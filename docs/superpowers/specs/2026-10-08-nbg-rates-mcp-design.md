# nbg-rates-mcp design

Date: 2026-10-08
Status: approved for planning; amended 2026-10-08 after live probing of
nbg.gov.ge (carried-over semantics, CSV history source, archive start,
timestamp zone) and again after an external review (publication calendar
for history, cache rules, upstream validation, re-runnable release)

## Purpose

`nbg-rates-mcp` is an open-source MCP (Model Context Protocol) server that
gives AI agents the official exchange rates of the National Bank of Georgia
(NBG) for the Georgian lari (GEL). It runs on the user's machine over stdio
on Node 22 or later,
calls the public NBG endpoints directly, and encodes the rules a raw call gets
wrong: rates are quoted per 1, 10, 100, 1000 or 10000 units; a rate is set
around 17:00 Tbilisi time on a business day and is valid from the next
calendar day until the next rate takes effect; a request for a day without a
rate of its own (Sundays, Mondays, days after a public holiday) silently
returns the rate set earlier; a request for a future date silently returns
the latest rate as if it applied; an invalid date silently returns today's
table; and a non-GEL pair must be derived through GEL.

Audience: Georgian developers and accountants who need the official NBG rate
for a given date, which Georgian tax and accounting rules require for
invoicing, customs and bookkeeping. Generic exchange-rate MCP servers serve
mid-market rates and cannot answer that question.

Success: a user adds one line to an MCP client configuration, asks "what was
the USD rate on 14 March", and gets the right per-unit number with the
effective date and a flag saying whether the rate was carried over from an
earlier day. A question about a date whose rate NBG has not published yet
gets a clear "not published yet" answer, never a stale rate presented as
that date's rate.

Not in scope: hosting of any kind, API keys, telemetry, averages,
interpolation, or any value that is not a direct projection of NBG data.

## Decisions taken during design

| Decision | Choice |
|---|---|
| Shape | stdio MCP server, TypeScript, Node 22 or later (Node 20 is end of life) |
| SDK | `@modelcontextprotocol/server` v2 (ESM only, Zod v4, Standard Schema) |
| Tool surface | rich: four `nbg_`-prefixed tools plus one resource template, Georgian names, daily diff |
| Date semantics | a successful answer is always the rate in force on the requested date; `carriedOver` marks a rate that took effect earlier; a date whose rate is not published yet is an error |
| History source | the NBG CSV export, one request per call; the per-day JSON endpoint serves single dates |
| Package name | `nbg-rates-mcp` on npm, unscoped |
| Registry name | `io.github.akalongman/nbg-rates` in the official MCP registry (npm package only in 0.x) |
| Distribution | `npx -y nbg-rates-mcp` as primary; an MCPB bundle on each GitHub release for Claude Desktop |
| Architecture | functional core, imperative shell |
| Repository | `~/projects/akalongman/nbg-rates-mcp`, GitHub `akalongman/nbg-rates-mcp`, MIT |
| Hosting | none |

## Upstream facts (probed 2026-10-08)

Both endpoints below are undocumented and unversioned; the website's own
JavaScript bundle is the only reference. The contract test guards every
fact in this section.

### Per-day JSON endpoint

`https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/{en|ka}/json`

- Query parameters: `date=YYYY-MM-DD`; `currencies=USD` repeated once per
  code (a comma-separated list returns an empty array). Codes are
  case-insensitive. Without `currencies` the full table is returned.
- Response: an array with one element, `{ date, currencies: [...] }`. Each
  currency row carries `code`, `quantity`, `rate`, `diff`, `name`, `date`,
  `validFromDate`, plus display strings `rateFormated` and `diffFormated`
  (the latter unsigned). Every row back to 1995 carries `validFromDate`, and
  all rows of one table share it.
- Timestamps are Tbilisi wall-clock values serialised with a `Z` suffix,
  not UTC. Tomorrow's rate for 2026-10-09 appeared at 13:00:24 UTC stamped
  `"date": "2026-10-08T17:00:01.911Z"`, and `validFromDate` reads
  `"2026-10-09T00:00:00.000Z"` for Tbilisi midnight. A calendar date is
  therefore the first ten characters of a timestamp; a `Date` object would
  shift it.
- Publication: on business days at about 17:00 Tbilisi time, valid from the
  next calendar day. From September 2021 there are no rows of their own for
  days after a non-business day: a request for Sunday 2026-10-04 or Monday
  2026-10-05 returns the table valid from Saturday 2026-10-03; Saturday has
  its own table (published Friday). After the 2026-01-01 table, requests for
  2 to 5 January all return it, and Tuesday 2026-01-20 after the Monday
  holiday returns the Saturday 2026-01-17 table.
- Before the September 2021 changeover (the last old-style Sunday is
  2021-09-05, the first new-style one 2021-09-12) every calendar day,
  Sundays included, has its own row with `date` and `validFromDate` equal to
  that day.
- A future date returns the latest published table. An invalid date
  (`2026-02-30`, `bad`) returns today's table. An unknown code returns an
  empty array. The archive starts on 1995-10-14 (USD only); 1995-10-13 and
  earlier return an empty array. The currency list changes over time (42
  today; BGN was quoted in 2005 and is gone; AZN, TRY and others were added
  later).
- 42 currencies today: 13 quoted per 1 unit, 17 per 10, 8 per 100, 3 per
  1000, 1 per 10000. Raw rates have four decimals.

### CSV export endpoint

`https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/export/csv?currencies=USD&start=YYYY-MM-DD&end=YYYY-MM-DD`

- `currencies` is required (HTTP 422 without it) and may repeat. Returns
  `Content-Type: application/csv`, UTF-8 with a byte-order mark, header
  `Code,Quantity,Rate,Diff,Name,Date,ValidFromDate`, one row per
  publication, newest first. Dates are `M/D/YYYY`. `Name` is Georgian only
  (there is no language variant). `Diff` is unsigned. No field is quoted.
- `start` and `end` filter on `ValidFromDate`, inclusive: `start=2026-10-03`,
  `end=2026-10-05` returns only the row valid from 2026-10-03.
- One year of USD is 250 rows in about 0.1 s; the whole USD archive since
  1995 is 10074 rows in 1.6 s. An unknown code returns the header only. An
  invalid `start` silently returns the latest row, like the JSON endpoint.
- A currency can stop being quoted: BGN's last row is valid from 2025-12-31
  (Bulgaria adopted the euro on 2026-01-01), while USD continues with
  2026-01-01. Repeating a currency's last row across later days would invent
  rates NBG never published.
- The currency filter has gaps. Filtering on AZN (CSV `currencies=AZN`, and
  the JSON `currencies=AZN` parameter alike) returns nothing for 2006 and
  2007, although the unfiltered daily tables list AZN then (2006-06-01:
  1.9989); AZN rows start on 2008-01-01. A CSV request that includes AZN for
  that period comes back header-only for every currency in it. A row missing
  from a filtered export is therefore not proof that NBG published nothing.
- All 261,022 rows of the archive (43 codes, 1995-10-14 to 2026-10-08) have
  rates and diffs with at most four decimals, positive rates, power-of-ten
  quantities, seven fields and no quoting.

### Transport

- Response time 60 to 700 ms. No cache headers. No authentication. Rate
  limits unknown.
- The site sits behind an F5 web application firewall (`TS…` cookie). A
  block page from such a firewall is HTML with status 200, which must not be
  mistaken for a changed response shape.

## Tool contracts

All tool names carry the `nbg_` prefix so they cannot be confused with the
`convert` or `latest_rate` tools of generic exchange-rate servers installed
in the same client. Each tool has a human-readable `title`, carries the
annotations `readOnlyHint`, `idempotentHint` and `openWorldHint` set to
true, and declares an `outputSchema`. Handlers return both
`structuredContent` and a `content` text block holding the same JSON
serialised once without indentation; the SDK does not add the text block
itself. `language` affects only the `name` field; codes, numbers and dates
are identical in `en` and `ka`.

Common output fields:

- `requestedDate`: the calendar date the caller asked for (or today in
  Tbilisi when omitted).
- `effectiveDate`: the calendar date the returned rate took effect, as NBG
  publishes it.
- `carriedOver`: true when `effectiveDate` is earlier than `requestedDate`,
  that is, the rate in force on the requested day was set for an earlier
  day. The answer is still the official rate for the requested day.

A requested date is settled when it is today in Tbilisi or earlier, or when
NBG has already published a rate valid from it. Every answer built from NBG
data is for a settled date; an unsettled date fails with
`rate_not_published`. A date later than tomorrow is rejected without calling
NBG, because no rate for it can exist yet. A table valid from a day after
the requested date can only mean NBG ignored the date parameter (as it does
for an invalid date), so it is `upstream_shape_changed`, never a rate. GEL to
GEL in `nbg_convert` is the identity and needs no rate, so it answers for any
valid date.

Worked examples, all against the live data of 2026-10-08:

1. On Monday 2026-10-05 a user asks for the AMD rate on Sunday 2026-10-04.
   NBG has no Sunday rate; Saturday's applies. `nbg_get_rates` with
   `date: "2026-10-04"`, `currencies: ["AMD"]` returns:

   ```json
   {
     "requestedDate": "2026-10-04",
     "effectiveDate": "2026-10-03",
     "carriedOver": true,
     "rates": [
       {
         "code": "AMD",
         "name": "Armenian Dram",
         "rate": 0.0071762,
         "diff": 0.000012,
         "nbgQuantity": 1000,
         "nbgRate": 7.1762
       }
     ],
     "unknownCodes": []
   }
   ```

2. The same request for Monday 2026-10-05 returns the same table with
   `requestedDate` 2026-10-05: the rate set on Friday for Saturday is still in
   force on Monday.
3. At 15:00 Tbilisi on 2026-10-08 a user asks for the USD rate on 2026-10-09.
   NBG has not published it, so the call fails with "NBG has not published a
   rate for 2026-10-09 yet. The latest published rate is valid from
   2026-10-08. NBG sets rates on business days around 17:00 Tbilisi time,
   valid from the next calendar day." After 17:00 the same call returns
   2.6019 with `effectiveDate` 2026-10-09 and `carriedOver` false.

### `nbg_get_rates` (title: NBG rates for a date)

Input: `date` (optional, ISO calendar date, default today in Tbilisi),
`currencies` (optional, non-empty array of ISO 4217 codes, case-insensitive,
duplicates ignored, default all), `language` (optional, `en` or `ka`,
default `en`).

Output: the common fields plus `rates`, an array of `{ code, name, rate,
diff, nbgQuantity, nbgRate }` where `rate` and `diff` are per one unit of the
currency in GEL and `nbgQuantity`, `nbgRate` are the raw pair as NBG
publishes it, so a user can recognise the number on the NBG website.
`unknownCodes` lists requested codes absent from the table. Unknown codes
are not an error here: a request for five codes with one typo still answers
the other four.

The description states that tomorrow's rate is published around 17:00
Tbilisi time and can be requested by date, so a model asked in the evening
knows the next day's rate is available, and that a date not yet published
returns an error rather than a guess.

### `nbg_convert` (title: Convert via NBG rate)

Input: `amount` (number), `from` and `to` (ISO codes, either may be `GEL`),
`date` (optional).

Output: `amount`, `from`, `to`, `result`, `rate` (one unit of `from`
expressed in `to`), `via` (`"direct"` when one side is GEL, `"GEL"`
otherwise), `effectiveDate`, `carriedOver`, `requestedDate`.

Numbers are unrounded. The tool description instructs the model to round for
display and to quote the effective date whenever `carriedOver` is true.

When `from` equals `to`, or both are GEL, `rate` is 1, `result` equals
`amount` and `via` is `direct`; with both GEL no upstream call is made.

### `nbg_list_currencies` (title: NBG currency list)

Input: `language` (optional).

Output: `effectiveDate` and `currencies`, an array of `{ code, name,
nbgQuantity }` for every currency in today's table. The list is never
hard-coded; it is the table NBG returned. The description says the list is
today's: NBG quoted other currencies in the past.

### `nbg_rate_history` (title: NBG rate history)

Input: `currency`, `from`, `to` (inclusive ISO calendar dates).

Output: `currency`, `from`, `to`, `days`: one entry per calendar day in
order, `{ date, effectiveDate, rate, carriedOver }`. Every calendar day is
included, carried-over days with `carriedOver` true, because the rate
applicable on a non-business day is a question the audience asks and a
model filling gaps itself gets it wrong.

There is no `language` input, because the output contains no names, and no
`diff`, because the CSV source gives it unsigned and on a carried-over day
NBG's diff describes a change that did not happen that day.

Source: one CSV export request for the currency plus USD, with `start` 31
days before `from` (the longest observed gap between publications is five
days, over New Year) and `end` equal to `to`. USD is in every NBG table since
the archive starts, so its rows are the publication calendar. For each day,
the applicable publication is the latest `ValidFromDate` on or before it
across all returned rows, and the currency must have a row valid from that
same date; ties between rows go to the later publication date. When the
currency is missing from the applicable publication (BGN after 2025-12-31,
or a gap in NBG's filter such as AZN in 2006 and 2007) the day fails with
`no_data_for_date` instead of repeating an older row. An export with no rows
at all (a range before 1995-10-14) is `no_data_for_date` for `from`; an
export with calendar rows but none for the currency is `unknown_currency`.
The range is capped at 366 days per call, because each day costs about 35
tokens of model context, not because of upstream cost.

### Resource template `nbg://rates/{date}`

`date` is an ISO calendar date or the literal `today`. Returns the
`nbg_get_rates` payload for that date with no currency filter, as JSON.
Intended for clients that let users attach resources to context instead of
calling tools. The template registers a `list` callback that returns the
single `nbg://rates/today` entry, so the resource is visible in client
resource lists rather than only resolvable when typed.

## Core (`src/core/`)

Pure modules: no `fetch`, no clock, no `console`, no mutable module state.
Functions take the current date as an argument when they need one. Core
never imports from shell or Node built-ins; an ESLint
`no-restricted-imports` rule enforces it.

- `types.ts`: branded `CurrencyCode` (validated three uppercase letters) and
  `CalendarDate` (validated `YYYY-MM-DD`); the `RateEntry`, `RatesSnapshot`,
  `Conversion` and `HistorySeries` records the tool outputs are built from;
  the `Result<T, E>` type; the error union below. No TypeScript `enum`.
- `currency-code.ts`: code parsing and the `GEL` constant.
- `dates.ts`: `todayIn(timeZone, now)` through `Intl.DateTimeFormat`
  `formatToParts` (not a locale's string format, which has changed between
  ICU versions), strict calendar-date parsing, extraction of the calendar
  date from an NBG timestamp (the first ten characters, never through a
  `Date` object), `enumerateDays(from, to)`, the 366-day range check, the
  settledness predicate and the "later than tomorrow" rejection.
  `Asia/Tbilisi` and the archive start `1995-10-14` are constants here.
- `nbg-schema.ts`: the Zod schema of the raw JSON response. Timestamps must
  start with a real calendar date and `T` (`2026-02-30T...` is a shape
  change, not a crash); `validFromDate` is required; a table must have at
  least one row and all rows must share one `validFromDate`; rates are
  positive, and rates and diffs have at most four decimals, so a change in
  NBG's precision is reported instead of rounded away. Unknown extra fields
  are accepted.
- `nbg-csv.ts`: the strict parser of the CSV export. It strips the byte-order
  mark, requires the exact header, rejects quoted fields and rows without
  seven fields, parses `M/D/YYYY` strictly, and requires positive rates with
  at most four decimals.
- `normalize.ts`: parsed NBG table plus requested date to `RatesSnapshot`.
  Divides `rate` and `diff` by `quantity`, sets `effectiveDate` from
  `validFromDate`, sets `carriedOver`; selects and de-duplicates requested
  codes and collects `unknownCodes`; `requirePublished` turns a table valid
  after the requested date into `upstream_shape_changed` and an unsettled
  snapshot into `rate_not_published`. `nbg-schema.ts`, `nbg-csv.ts` and
  `requirePublished` are the only places `upstream_shape_changed` is
  produced.
- `convert.ts`: cross-rate arithmetic on a snapshot. GEL has rate 1;
  `result = amount * rate(from) / rate(to)`.
- `history.ts`: CSV rows (the currency and the USD calendar) plus the
  calendar days plus today to a `HistorySeries`, checking each day against
  the applicable publication as described under `nbg_rate_history`.

Decimal division: NBG rates have four decimals and quantities are powers of
ten, so a per-unit value has exactly `4 + log10(quantity)` decimals.
`normalize` rounds to that many places, so AMD at 7.1762 per 1000 becomes
`0.0071762`, never a value with float noise. Conversion results are plain
float arithmetic and documented as unrounded.

## Shell (`src/shell/`)

- `nbg-client.ts`: `fetchDay` fetches the full JSON table for one date and
  language; it never passes a `currencies` filter upstream, so one cache
  entry per date serves every later question about that date. `fetchRange`
  fetches the CSV export for a list of currencies (one `currencies`
  parameter each) and a `ValidFromDate` range.
  Ten-second timeout through `AbortSignal`, one retry after a 500 ms pause
  on network error, 429 or 5xx, a `User-Agent` naming the package and
  version. A response whose content type is not the expected one (JSON or
  CSV), or whose body does not parse, is `upstream_unavailable` and is not
  retried; a parsed body that fails the schema or the CSV header check is
  `upstream_shape_changed`.
- `cache.ts`: in-memory snapshot map keyed by language and requested date. A
  snapshot whose requested date is before today in Tbilisi is final whatever
  its flag, because the past does not change. For today and later dates a
  snapshot is final when `carriedOver` is false and provisional for ten
  minutes when it is true (a late publication for today is possible). A
  live entry is never replaced by a snapshot with an older effective date:
  two requests straddling a publication can finish out of order. Capped at
  2000 entries, oldest evicted first. History is not cached: it is one
  request of about 0.1 s.
- `rates-service.ts`: `getSnapshot` rejects a date later than tomorrow,
  reads through the cache and the client, normalises, and passes every
  fetched answer through `requirePublished` before caching it. Unsettled or
  impossible answers are never cached: a "not published" answer cached at
  23:59 would otherwise turn into a success at 00:01 without NBG being asked
  again. `getHistory` checks the range, makes one `fetchRange` call for the
  currency and USD, and hands the rows to core.
- `tool-schemas.ts`: the Zod input and output schemas of the four tools.
- `server.ts`: builds the `McpServer`, registers the four tools and the
  resource template, maps core errors to MCP tool errors. Uses the v2
  factory style (`serveStdio(createServer)`) so each connection gets a fresh
  server. Tool descriptions state the Tbilisi calendar-day rule, that rates
  are per one unit, which days carry an earlier rate, that `effectiveDate`
  must be quoted when `carriedOver` is true, and that unpublished dates
  return an error. Logs go to stderr only.
- `bin.ts`: executable entry with shebang, `--version`, `--help`. Reads two
  environment variables: `NBG_RATES_BASE_URL` overrides the NBG host for
  tests; `NBG_RATES_DEBUG=1` logs every upstream request with status and
  timing to stderr, which the issue template asks reporters to attach.

Latency: a single date is one request (zero when cached). A history of any
length up to the cap is one request of about 0.1 s. Parallel tool calls for
the same uncached date may fetch it twice; that is accepted rather than
adding in-flight de-duplication.

Not included: disk cache, configuration file, HTTP transport, history cache.

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
3. `unknown_currency`: from `convert` and `nbg_rate_history` only. Says NBG
   did not quote the code for the requested date and that
   `nbg_list_currencies` lists today's codes, since the list has changed
   over the years.
4. `no_data_for_date`: no rate in force on a date (before the archive,
   before a currency was first quoted, after it was last quoted, or a day
   whose publication NBG's filter does not return for it). Names the date,
   the currency when known, and the archive start 1995-10-14.
5. `rate_not_published`: the date is not settled. Names the date, the latest
   effective date when known, and the 17:00 publication rule.
6. `upstream_unavailable`: network failure, timeout, 4xx, 5xx after one
   retry, or a body that is not the expected JSON or CSV (such as a
   firewall block page). Says the call can be retried.
7. `upstream_shape_changed`: a parsed body that failed the JSON schema or the
   CSV header and row checks, or a table valid from a day after the requested
   date. Asks the user to report it with the package version.

History is all or nothing: if the range request fails, or any day has no
rate in force, the whole call fails and the message names the cause. A
series with a silent hole corrupts any average computed from it.

Worked example. `convert` 100 USD to EUR on `2026-02-30` fails locally with
"2026-02-30 is not a valid calendar date". The same call on `1995-06-01`
reaches NBG, gets an empty array, and fails with "NBG has no rates for
1995-06-01; the archive starts on 1995-10-14 and some currencies were first
quoted later". With `to: "XXX"` it fails with "NBG did not quote XXX for the
requested date; call nbg_list_currencies for today's codes".

## Testing

Vitest, tests co-located as `*.test.ts`.

- Core: `normalize` on recorded fixtures (a weekday, a Saturday with its own
  table, a carried-over Sunday and Monday, an old-era Sunday 2021-09-05 with
  its own row, a 2005 table, an empty answer); rows missing `validFromDate`
  or disagreeing on it rejected, as are impossible timestamp dates,
  non-positive rates and rates or diffs with more than four decimals; a
  table valid after the requested date rejected; decimal division for every
  quantity power;
  `dates` at 21:30 UTC (already tomorrow in Tbilisi), 29 February, the
  366-day cap, `2026-02-30`, NBG timestamp extraction under
  `TZ=America/Los_Angeles`, settledness for yesterday, today, tomorrow
  before and after publication, and later; the CSV parser on recorded
  exports and malformed input; `history` across a weekend, a range starting
  on a Sunday (in-force rate found through the lookback), the 2021
  changeover, a currency not quoted yet, a currency no longer quoted (BGN
  after 2025-12-31), a publication missing from a currency's rows, an export
  with no rows, and an unpublished tail; `convert`
  with GEL on each side, a cross pair, and identical codes.
- Property tests with fast-check: converting A to B and back returns the
  amount within float tolerance; enumerating any valid range yields
  `to - from + 1` days in order without duplicates.
- Shell: cache retention rules with an injected clock, and an older answer
  arriving after a newer one; the service not caching a "not published"
  answer across midnight; client timeout, single
  retry, user agent, content-type classification (an HTML block page is
  `upstream_unavailable` without retry) against a local `node:http` fixture
  server reached through `NBG_RATES_BASE_URL`.
- End to end: spawn the built binary over stdio with
  `@modelcontextprotocol/client`, list tools, call each once against the
  fixture server, assert structured output. Runs against `dist/`.
- Fixtures are recorded by `scripts/record-fixtures.ts` for a fixed set of
  dates and CSV ranges into `test/fixtures/`. Refreshing them is a script
  run and a diff review.
- Live contract test `test/contract/nbg-live.test.ts`, skipped unless
  `NBG_LIVE=1`, pins one date per behaviour: today's table parses with USD
  present and power-of-ten quantities and at most four raw decimals; Sunday
  and Monday 2026-10-04 and 2026-10-05 return the 2026-10-03 table;
  Saturday 2026-10-03 has its own; old-era Sunday 2021-09-05 has its own;
  1995-10-13 is empty and 1995-10-14 has USD; the Georgian table returns
  USD with a name in Georgian script (the check fails if the request
  fails); the CSV export has the expected header, `M/D/YYYY` dates and the
  `ValidFromDate` filter; BGN history ends with the publication valid from
  2025-12-31 and fails for 2026-01-01; a one-year history through the
  service returns 366 days in one request. No exact rate values.

Not tested: exact rate values, NBG uptime, tool description prose.

## CI and release

GitHub Actions, three workflows, with `actions/checkout@v7` and
`actions/setup-node@v7`:

1. `ci.yml` on push and pull request: Prettier check, ESLint
   (`no-explicit-any` as error, core import ban), typecheck, unit and
   end-to-end tests, on Node 22 and 24.
2. `contract.yml` weekly and on manual dispatch: runs the live contract
   test. On failure it opens an issue, or comments on the open one. This is
   the upstream-drift alarm.
3. `release.yml` on a version tag, on Node 24 (npm 11.5.1 or later is needed
   for trusted publishing; Node 22 bundles npm 10). Order: verify; check that
   every version field equals the tag, each `server.json` package entry
   included (`scripts/check-release.ts`); build the MCPB bundle and validate
   it; `npm publish` through npm trusted publishing (workflow permission
   `id-token: write`, provenance generated automatically, no token in the
   repository); create the GitHub release with the bundle attached;
   `mcp-publisher publish` through its GitHub OIDC login. `npm publish` is
   the only irreversible step, so everything that can fail runs before it.
   Each publishing step lives in `scripts/publish-release.sh` and first asks
   its target whether the version is already there, so a job that failed
   after `npm publish` can be re-run from the top.

Dependabot (`.github/dependabot.yml`) checks npm and GitHub Actions weekly
with minor and patch updates grouped.

First publish: trusted publishing can only be configured on a package that
already exists, and a new configuration must complete a publish within two
days. So 0.1.0 is published manually from the maintainer's machine with an
OTP, the trusted publisher is then configured on npmjs.com with
`npm publish` among its allowed actions (configurations created after
2026-09-03 allow only `npm stage publish` by default), and the next tag
proves the workflow. `repository.url` in `package.json` must match the
GitHub URL exactly or provenance fails, and provenance requires a public
repository.

Versioning: first publish 0.1.0; 1.0.0 once the weekly contract test has run
clean for a month.

## Distribution

- Primary: `npx -y nbg-rates-mcp`, for Claude Code, Cursor and any client
  configured by command line. Install line for Claude Code:
  `claude mcp add nbg-rates -- npx -y nbg-rates-mcp`.
- Claude Desktop on macOS and Windows: the MCPB bundle from the GitHub
  release, installed by double-click. Claude Desktop ships its own Node
  runtime, so the user needs nothing else. The bundle format lives at
  `github.com/modelcontextprotocol/mcpb` (the old `anthropics/mcpb` URL
  redirects there); its current `manifest_version` is `0.3`, and the
  implementing task must read the current `MANIFEST.md` rather than a
  tutorial. The bundle is linked from the README; it is not listed in
  `server.json` during 0.x, because the registry entry would need the
  bundle's SHA-256 and version written at release time, and that is not
  worth automating before the bundle has users. The Claude Desktop Linux
  beta is not listed in the bundle's platforms until a bundle install has
  been tested there.
- Claude Desktop elsewhere, and anyone who prefers a config file: the
  README shows the manual `claude_desktop_config.json` snippet with the
  `npx` command next to the bundle instructions.
- Rejected: global `npm install -g` (users stop updating), single executable
  binaries (three-platform build matrix and macOS notarisation for a problem
  the bundle already solves), Docker (wrong shape for a desktop tool), a
  hosted HTTP server (out of scope by decision).

## Repository layout

```
package.json              type module, bin, files, engines node>=22, mcpName
server.json               registry manifest, name io.github.akalongman/nbg-rates, npm package only
manifest.json             MCPB manifest
tsconfig.json             strict settings, ESM output to dist/
eslint.config.js          typescript-eslint, no-explicit-any, core import ban
.prettierrc, .prettierignore, .editorconfig   4 spaces (2 for YAML and Markdown), 120 columns, single quotes
src/core/                 pure modules, tests beside them
src/shell/                effectful modules, tests beside them
src/bin.ts                executable entry
test/fixtures/            recorded NBG responses (JSON tables and CSV exports)
test/helpers/             fixture loading and the local fixture server
test/e2e/                 stdio round trip against dist/
test/contract/            live test, opt-in
scripts/record-fixtures.ts
scripts/build-bundle.sh
scripts/check-release.ts    release preconditions: versions match the tag, npm new enough
scripts/publish-release.sh  idempotent npm, GitHub release and registry steps
docs/superpowers/         this design and the implementation plan
.github/workflows/        ci.yml, contract.yml, release.yml
.github/dependabot.yml    weekly npm and actions updates
.github/ISSUE_TEMPLATE/   bug report asking for NBG_RATES_DEBUG output
README.md, LICENSE, CHANGELOG.md
```

Build is plain `tsc`, no bundler. Runtime dependencies:
`@modelcontextprotocol/server`, `zod`. Dev dependencies: typescript (the
newest version typescript-eslint supports, 6.0 at planning time, not 7),
vitest, fast-check, typescript-eslint, eslint, prettier, tsx,
`@types/node` matching the oldest supported Node (22),
`@modelcontextprotocol/client`.

Package metadata: keywords `nbg`, `national-bank-of-georgia`, `georgia`,
`gel`, `lari`, `exchange-rates`, `currency`, `mcp`, `mcp-server`.
Description: "Official National Bank of Georgia (NBG) GEL exchange rates for
AI agents, with correct per-unit values and date semantics". `mcpName`:
`io.github.akalongman/nbg-rates`.

README, written agent-neutral: what it is and a disclaimer that it is
unofficial and NBG is the source of truth; install for Claude Code, Claude
Desktop and Cursor; Node installation for macOS, Linux, Windows PowerShell
and WSL; the tool reference with the Sunday worked example; the date rules
(17:00 publication valid from the next day, Tbilisi calendar days, which
days carry an earlier rate and the September 2021 changeover, unpublished
dates are errors, the archive starts on 1995-10-14); a contributing section
pointing at the fixture script.

## Maintenance expectations

There is no hosted component. The npm package and the GitHub release are the
deployment. Expected maintenance, in order of likelihood:

1. NBG changes an endpoint. The weekly contract test opens an issue; the fix
   is a schema or parser change and a fixture refresh.
2. The MCP SDK ships a major version. Dependabot opens the pull request; the
   test suite reports breakage.
3. User issues, a handful per year for this audience.
