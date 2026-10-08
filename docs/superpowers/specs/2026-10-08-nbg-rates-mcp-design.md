# nbg-rates-mcp design

Date: 2026-10-08
Status: approved for planning

## Purpose

`nbg-rates-mcp` is an open-source MCP (Model Context Protocol) server that
gives AI agents the official exchange rates of the National Bank of Georgia
(NBG) for the Georgian lari (GEL). It runs on the user's machine over stdio,
calls the public NBG endpoint directly, and encodes the rules a raw call gets
wrong: rates are quoted per 1, 10, 100, 1000 or 10000 units; a rate is set in
the afternoon and valid from the next calendar day; a request for a weekend,
holiday or future date silently returns the last published rate; an invalid
date silently returns today's table; and a non-GEL pair must be derived
through GEL.

Audience: Georgian developers and accountants who need the official NBG rate
for a given date, which Georgian tax and accounting rules require for
invoicing, customs and bookkeeping. Generic exchange-rate MCP servers serve
mid-market rates and cannot answer that question.

Success: a user adds one line to an MCP client configuration, asks "what was
the USD rate on 14 March", and gets the right per-unit number with the
effective date and a flag saying whether the rate was carried over from an
earlier day.

Not in scope: hosting of any kind, API keys, telemetry, averages,
interpolation, or any value that is not a direct projection of NBG data.

## Decisions taken during design

| Decision | Choice |
|---|---|
| Shape | stdio MCP server, TypeScript, Node 20 or later |
| SDK | `@modelcontextprotocol/server` v2 (ESM only, Zod v4, Standard Schema) |
| Tool surface | rich: four tools plus one resource template, Georgian names, daily diff |
| Package name | `nbg-rates-mcp` on npm, unscoped |
| Registry name | `io.github.akalongman/nbg-rates` in the official MCP registry |
| Distribution | `npx -y nbg-rates-mcp` as primary; an MCPB bundle on each GitHub release for Claude Desktop |
| Architecture | functional core, imperative shell |
| Repository | `~/projects/akalongman/nbg-rates-mcp`, GitHub `akalongman/nbg-rates-mcp`, MIT |
| Hosting | none |

## Upstream facts (probed 2026-10-08)

Endpoint: `https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/{en|ka}/json`.
It is undocumented and unversioned; every public wrapper reverse-engineered
it from the website. Observed behaviour, which the contract test guards:

- Query parameters: `date=YYYY-MM-DD`; `currencies=USD` repeated once per
  code (a comma-separated list returns an empty array). Codes are
  case-insensitive. Without `currencies` the full table is returned.
- Response: an array with one element, `{ date, currencies: [...] }`. Each
  currency row carries `code`, `quantity`, `rate`, `diff`, `name`, `date`
  (the publication timestamp, about 17:01 Tbilisi time the day before) and
  `validFromDate`. Rows from the 2000s omit `validFromDate`; their `date`
  equals the calendar day.
- 42 currencies today; 29 are quoted per 10, 100, 1000 or 10000 units.
- A weekend, holiday or future date returns the latest published table with
  its own `date`, not the requested one. An invalid date (`2026-02-30`,
  `bad`) returns today's table. An unknown code returns an empty array.
  A date before the archive (observed: 1995) returns an empty array; 2000
  onwards has data.
- Response time 100 to 350 ms. No cache headers. No authentication.

## Tool contracts

All tools carry the annotations `readOnlyHint`, `idempotentHint` and
`openWorldHint` set to true and declare an `outputSchema`, so clients
receive structured results.

Common output fields:

- `requestedDate`: the calendar date the caller asked for (or today in
  Tbilisi when omitted).
- `effectiveDate`: the calendar date NBG says the returned rates are valid
  from.
- `isFallback`: true when `effectiveDate` differs from `requestedDate`.
- `publishedAt`: the NBG publication timestamp, ISO 8601 UTC.

Worked example. On Monday 2026-10-05 a user asks for the AMD rate on Sunday
2026-10-04. NBG has no Sunday rate and returns Saturday's. `get_rates` with
`date: "2026-10-04"`, `currencies: ["AMD"]` returns:

```json
{
  "requestedDate": "2026-10-04",
  "effectiveDate": "2026-10-03",
  "isFallback": true,
  "publishedAt": "2026-10-02T17:01:02Z",
  "rates": [
    {
      "code": "AMD",
      "name": "Armenian Dram",
      "rate": 0.0071748,
      "diff": -0.0000035,
      "nbgQuantity": 1000,
      "nbgRate": 7.1748
    }
  ],
  "unknownCodes": []
}
```

### `get_rates`

Input: `date` (optional, ISO calendar date, default today in Tbilisi),
`currencies` (optional, array of ISO 4217 codes, case-insensitive, default
all), `language` (optional, `en` or `ka`, default `en`).

Output: the common fields plus `rates`, an array of `{ code, name, rate,
diff, nbgQuantity, nbgRate }` where `rate` and `diff` are per one unit of the
currency in GEL and `nbgQuantity`, `nbgRate` are the raw pair as NBG
publishes it, so a user can recognise the number on the NBG website.
`unknownCodes` lists requested codes absent from the table. Unknown codes
are not an error here: a request for five codes with one typo still answers
the other four.

### `convert`

Input: `amount` (number), `from` and `to` (ISO codes, either may be `GEL`),
`date` (optional).

Output: `amount`, `from`, `to`, `result`, `rate` (one unit of `from`
expressed in `to`), `via` (`"direct"` when one side is GEL, `"GEL"`
otherwise), `effectiveDate`, `isFallback`, `requestedDate`.

Numbers are unrounded. The tool description instructs the model to round for
display and to quote the effective date whenever `isFallback` is true.

### `list_currencies`

Input: `language` (optional).

Output: `effectiveDate` and `currencies`, an array of `{ code, name,
nbgQuantity }` for every currency in today's table. The list is never
hard-coded; it is the table NBG returned.

### `get_rate_history`

Input: `currency`, `from`, `to` (inclusive ISO calendar dates), `language`
(optional).

Output: `currency`, `from`, `to`, `days`: one entry per calendar day in
order, `{ date, effectiveDate, rate, diff, isFallback }`. Every calendar day
is included, weekends and holidays with `isFallback` true, because the rate
applicable on a non-business day is a question the audience asks. The range
is capped at 366 days per call.

### Resource template `nbg://rates/{date}`

`date` is an ISO calendar date or the literal `today`. Returns the
`get_rates` payload for that date with no currency filter, as JSON. Intended
for clients that let users attach resources to context instead of calling
tools.

## Core (`src/core/`)

Pure modules: no `fetch`, no clock, no `console`, no mutable module state.
Functions take the current instant as an argument when they need one. Core
never imports from shell; an ESLint `no-restricted-imports` rule enforces
it.

- `types.ts`: branded `CurrencyCode` (validated three uppercase letters) and
  `CalendarDate` (validated `YYYY-MM-DD`); the `RateEntry`, `RatesSnapshot`,
  `Conversion` and `HistorySeries` records the tool outputs are built from;
  the `Result<T, E>` type; the error union below. No TypeScript `enum`.
- `nbg-schema.ts`: the Zod schema of the raw NBG response and nothing else.
  `validFromDate` is optional and falls back to the day-level `date`.
  Unknown extra fields are accepted. This is the only place
  `upstream_shape_changed` is produced.
- `normalize.ts`: parsed NBG day plus requested date to `RatesSnapshot`.
  Divides `rate` and `diff` by `quantity`, sets `effectiveDate` from
  `validFromDate`, sets `isFallback`, takes `publishedAt` from the
  per-currency timestamp, collects `unknownCodes`.
- `dates.ts`: `todayIn(timeZone, now)`, strict calendar-date parsing,
  `enumerateDays(from, to)`, the 366-day range check. `Asia/Tbilisi` is a
  constant here.
- `convert.ts`: cross-rate arithmetic on a snapshot. GEL has rate 1;
  `result = amount * rate(from) / rate(to)`.
- `history.ts`: assembles per-day snapshots into a `HistorySeries` in
  calendar order. Planning only; fetching is shell work.

Decimal division: NBG rates have four decimals and quantities are powers of
ten, so a per-unit value has exactly `4 + log10(quantity)` decimals.
`normalize` rounds to that many places, so AMD at 7.1748 per 1000 becomes
`0.0071748`, never `0.0071748000000000005`. Conversion results are plain
float arithmetic and documented as unrounded.

## Shell (`src/shell/`)

- `nbg-client.ts`: fetches the full table for one date and language. It
  never passes a `currencies` filter upstream; filtering happens in core, so
  one cache entry per date serves every later question about that date.
  Ten-second timeout through `AbortSignal`, one retry on network error or
  5xx, a `User-Agent` naming the package and version. Returns a `Result`
  with the parsed NBG day or `upstream_unavailable` /
  `upstream_shape_changed`.
- `cache.ts`: in-memory map keyed by language and date. A snapshot with
  `isFallback` false is final and kept for the life of the process. A
  snapshot with `isFallback` true is provisional (tomorrow's rate appears at
  about 17:00 Tbilisi) and kept for ten minutes. Capped at 2000 entries,
  oldest evicted first.
- `history-fetcher.ts`: enumerates days through core, fetches each through
  client and cache with a concurrency cap of 6 (hand-rolled, no dependency),
  hands the snapshots to core.
- `server.ts`: builds the `McpServer`, registers the four tools and the
  resource template, maps core errors to MCP tool errors. Uses the v2
  factory style (`serveStdio(createServer)`) so each connection gets a fresh
  server. Tool descriptions state the Tbilisi calendar-day rule, that rates
  are per one unit, and that `effectiveDate` must be quoted when
  `isFallback` is true. Logs go to stderr only.
- `bin.ts`: executable entry with shebang, `--version`, `--help`. Reads one
  environment variable, `NBG_RATES_BASE_URL`, which overrides the NBG host
  for tests.

Latency: a 90-day history fetches 90 tables at six in flight, about three to
six seconds on first call and zero fetches on a repeat. A 366-day range takes
roughly 10 to 20 seconds. If that proves too slow in practice, lower the
range cap rather than raise concurrency against NBG.

Not included: disk cache, configuration file, HTTP transport.

## Error handling

Expected failures return a tool result with `isError` true and a message
that says what to do next. Programmer errors throw. Nothing is swallowed or
guessed.

Validation happens before NBG is called. Dates are parsed strictly (real
calendar dates only), so `2026-02-30` is rejected locally and never reaches
NBG, where it would silently become today. Codes are upper-cased and
shape-checked. The SDK rejects inputs failing the Zod input schema before
the handler runs.

Error union:

1. `invalid_date`: not a real calendar date, or `from` after `to`. Names the
   value.
2. `range_too_long`: more than 366 days. States the cap.
3. `unknown_currency`: from `convert` and `get_rate_history` only. Points at
   `list_currencies`.
4. `no_data_for_date`: NBG returned an empty table (dates before the
   archive). States the earliest known date.
5. `upstream_unavailable`: network failure, timeout or 5xx after one retry.
   Says the call can be retried.
6. `upstream_shape_changed`: JSON parsed but failed the schema. Asks the
   user to report it with the package version.

History is all or nothing: if one day fails after its retry the whole call
fails and the message names the date. A series with a silent hole corrupts
any average computed from it; successful days are already cached, so the
retry costs only the failed day.

Worked example. `convert` 100 USD to EUR on `2026-02-30` fails locally with
"2026-02-30 is not a valid calendar date". The same call on `1999-06-01`
reaches NBG, gets an empty array, and fails with "NBG has no rates for
1999-06-01; the archive starts in 2000". With `to: "XXX"` it fails with
"unknown currency XXX; call list_currencies for the supported codes".

## Testing

Vitest, tests co-located as `*.test.ts`.

- Core: `normalize` on recorded fixtures (recent row, 2005 row without
  `validFromDate`, empty array, row with an extra field); decimal division
  for every quantity power; `dates` at 23:30 UTC (already tomorrow in
  Tbilisi), 29 February, the 366-day cap, `2026-02-30`; `convert` with GEL on
  each side and a cross pair; `history` ordering and flags across a weekend.
- Property tests with fast-check: converting A to B and back returns the
  amount within float tolerance; enumerating any valid range yields
  `to - from + 1` days in order without duplicates.
- Shell: cache retention rules with an injected clock; client timeout, single
  retry and user agent against a local `node:http` fixture server reached
  through `NBG_RATES_BASE_URL`.
- End to end: spawn the built binary over stdio with
  `@modelcontextprotocol/client`, list tools, call each once against the
  fixture server, assert structured output. Runs against `dist/`.
- Fixtures are recorded by `scripts/record-fixtures.ts` for a fixed set of
  dates into `test/fixtures/`. Refreshing them is a script run and a diff
  review.
- Live contract test `test/contract/nbg-live.test.ts`, skipped unless
  `NBG_LIVE=1`: fetches today, a known Sunday, a 2005 date and a 1995 date;
  asserts the schema parses, USD is present, every quantity is a power of
  ten, and the fallback flag behaves. No exact rate values.

Not tested: exact rate values, NBG uptime, tool description prose.

## CI and release

GitHub Actions, three workflows:

1. `ci.yml` on push and pull request: ESLint (`no-explicit-any` as error,
   core-to-shell import ban), typecheck, unit and end-to-end tests, on Node
   20, 22 and 24.
2. `contract.yml` weekly and on manual dispatch: runs the live contract
   test. On failure it opens an issue, or comments on the open one. This is
   the upstream-drift alarm.
3. `release.yml` on a version tag: build, test, `npm publish` with
   provenance through npm trusted publishing (no token in the repository),
   `mcp-publisher publish` through its GitHub OIDC login, and an MCPB bundle
   (`mcpb pack`) attached to the GitHub release.

Versioning: first publish 0.1.0; 1.0.0 once the weekly contract test has run
clean for a month.

## Distribution

- Primary: `npx -y nbg-rates-mcp`, for Claude Code, Cursor and any client
  configured by command line. Install line for Claude Code:
  `claude mcp add nbg-rates -- npx -y nbg-rates-mcp`.
- Claude Desktop: the MCPB bundle from the GitHub release, installed by
  double-click. Claude Desktop ships its own Node runtime, so the user needs
  nothing else. The manifest schema has changed several times (0.2 to 0.4
  within a year); the implementing task must read the current specification
  at `github.com/anthropics/mcpb` rather than a tutorial.
- Rejected: global `npm install -g` (users stop updating), single executable
  binaries (three-platform build matrix and macOS notarisation for a problem
  the bundle already solves), Docker (wrong shape for a desktop tool), a
  hosted HTTP server (out of scope by decision).

## Repository layout

```
package.json              type module, bin, files, engines node>=20, mcpName
server.json               registry manifest, name io.github.akalongman/nbg-rates
manifest.json             MCPB manifest
tsconfig.json             strict settings, ESM output to dist/
eslint.config.js          typescript-eslint, no-explicit-any, core-to-shell ban
.prettierrc, .editorconfig   4 spaces, 120 columns, single quotes
src/core/                 pure modules, tests beside them
src/shell/                effectful modules, tests beside them
src/bin.ts                executable entry
test/fixtures/            recorded NBG responses
test/e2e/                 stdio round trip against dist/
test/contract/            live test, opt-in
scripts/record-fixtures.ts
docs/superpowers/specs/   this design
.github/workflows/        ci.yml, contract.yml, release.yml
README.md, LICENSE, CHANGELOG.md
```

Build is plain `tsc`, no bundler. Runtime dependencies:
`@modelcontextprotocol/server`, `zod`. Dev dependencies: typescript, vitest,
fast-check, typescript-eslint, prettier, tsx, `@modelcontextprotocol/client`.

Package metadata: keywords `nbg`, `national-bank-of-georgia`, `georgia`,
`gel`, `lari`, `exchange-rates`, `currency`, `mcp`, `mcp-server`.
Description: "Official National Bank of Georgia (NBG) GEL exchange rates for
AI agents, with correct per-unit values and date semantics". `mcpName`:
`io.github.akalongman/nbg-rates`.

README, written agent-neutral: what it is and a disclaimer that it is
unofficial and NBG is the source of truth; install for Claude Code, Claude
Desktop and Cursor; Node installation for macOS, Linux, Windows PowerShell
and WSL; the tool reference with the Sunday worked example; the date rules;
a contributing section pointing at the fixture script.

## Maintenance expectations

There is no hosted component. The npm package and the GitHub release are the
deployment. Expected maintenance, in order of likelihood:

1. NBG changes the endpoint. The weekly contract test opens an issue; the fix
   is one schema line and one fixture refresh.
2. The MCP SDK ships a major version. Dependabot opens the pull request; the
   test suite reports breakage.
3. User issues, a handful per year for this audience.
