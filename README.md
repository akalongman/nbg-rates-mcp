# nbg-rates-mcp

`nbg-rates-mcp` gives AI agents the official National Bank of Georgia (NBG) exchange rates of the lari (GEL). It runs locally over stdio, needs no account and no key, and encodes the rules a raw call gets wrong: per-unit values, Tbilisi calendar days, an explicit `carriedOver` flag when a day has no rate of its own, and an error, never a stale rate, for a date NBG has not published yet.

This is an independent open-source project, not affiliated with the National Bank of Georgia. NBG's website, [nbg.gov.ge](https://nbg.gov.ge), is the source of truth. The NBG endpoints this server reads are undocumented and may change.

## Install

### Claude Code

```bash
claude mcp add nbg-rates -- npx -y nbg-rates-mcp
```

To make the server available in every project, add it with user scope:

```bash
claude mcp add --scope user nbg-rates -- npx -y nbg-rates-mcp
```

### Claude Desktop

On macOS and Windows, download `nbg-rates-mcp-<version>.mcpb` from the [latest GitHub release](https://github.com/akalongman/nbg-rates-mcp/releases/latest) and open it. Claude Desktop installs the bundle and runs it with its own Node.js, so nothing else is needed.

On the Claude Desktop Linux beta, elsewhere, or to configure the server by hand, add it to `claude_desktop_config.json`:

```json
{ "mcpServers": { "nbg-rates": { "command": "npx", "args": ["-y", "nbg-rates-mcp"] } } }
```

### Cursor and other clients

Add the same `mcpServers` entry to the client's MCP settings. In Cursor that is `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` inside one project.

### Node.js

`npx` needs Node.js 22 or later (the Claude Desktop bundle does not). Check with `node --version`, and install it if needed:

- macOS (Homebrew):

  ```bash
  brew install node
  ```

- Debian and Ubuntu (NodeSource, Node.js 24):

  ```bash
  curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
  sudo -E bash nodesource_setup.sh
  sudo apt-get install -y nodejs
  ```

- Other Linux distributions (nvm; open a new terminal after the first line):

  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
  nvm install --lts
  ```

- Windows (PowerShell):

  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```

- WSL: the same commands as Debian and Ubuntu, run inside the WSL shell.

## Tools

Every tool is read-only. Dates are calendar days in Tbilisi in the form `YYYY-MM-DD`, and every rate is GEL per one unit of the currency. Each tool returns its result as structured content and as the same JSON in a text block.

### `nbg_get_rates`

The official NBG rates in force on one calendar date. NBG quotes some currencies per 10, 100, 1000 or 10000 units; the rate is always divided down to one unit, and the raw pair is kept as `nbgQuantity` and `nbgRate`.

Inputs:

| Name         | Required | Description                                                                                                                                                           |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `date`       | no       | Calendar date. Defaults to today in Tbilisi. Tomorrow's rate exists after about 17:00 Tbilisi time.                                                                   |
| `currencies` | no       | ISO 4217 codes to return, case-insensitive, duplicates ignored, for example `["USD", "EUR"]`. When given, the list holds at least one entry. Omit for all currencies. |
| `language`   | no       | Language of the currency names: `en` (default) or `ka` (Georgian). Codes, numbers and dates are the same in both.                                                     |

Output:

- `requestedDate`: the date asked for, or today in Tbilisi when `date` is omitted.
- `effectiveDate`: the date the returned rates took effect, as NBG publishes it.
- `carriedOver`: `true` when the rates in force on `requestedDate` took effect on an earlier day. They are still the official rates for `requestedDate`; quote `effectiveDate` alongside them.
- `rates`: one entry per currency with `code`, `name`, `rate` (GEL per one unit), `diff` (change versus the previous published rate, per one unit), `nbgQuantity` (the units NBG quotes the raw rate for: 1, 10, 100, 1000 or 10000) and `nbgRate` (the raw rate as NBG publishes it, for `nbgQuantity` units).
- `unknownCodes`: requested codes NBG did not quote on that date, and inputs that are not a three-letter currency code at all. The other requested codes are still answered.

Worked example: on Monday 2026-10-05 a user asks for the AMD rate on Sunday 2026-10-04. NBG sets no rate for a Sunday, so the rate in force is the one valid from Saturday 2026-10-03, which NBG quotes as 7.1762 GEL per 1000 drams. The request

```json
{ "date": "2026-10-04", "currencies": ["AMD"] }
```

returns

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

The same request for Monday 2026-10-05 returns the same rate with `requestedDate` 2026-10-05: the rate NBG set on Friday for Saturday is still in force on Monday.

### `nbg_convert`

Converts an amount between two currencies with the official NBG rate in force on a calendar date. Either side may be GEL; a pair without GEL is converted through GEL.

Inputs:

| Name     | Required | Description                                                               |
| -------- | -------- | ------------------------------------------------------------------------- |
| `amount` | yes      | Amount in the `from` currency. A finite number, may be negative.          |
| `from`   | yes      | ISO 4217 code, or `GEL`.                                                  |
| `to`     | yes      | ISO 4217 code, or `GEL`.                                                  |
| `date`   | no       | Calendar date whose official rate to apply. Defaults to today in Tbilisi. |

Output:

- `amount`, `from`, `to`: the request, with the codes in upper case.
- `result`: the converted amount, unrounded. Round it for display.
- `rate`: one unit of `from` expressed in `to`.
- `via`: `direct` when either side is GEL (or both codes are the same), `GEL` when a pair without GEL is converted through GEL.
- `requestedDate`, `effectiveDate`, `carriedOver`: as in `nbg_get_rates`.

GEL to GEL is the identity and needs no NBG rate, so it answers for any valid date. A code NBG did not quote on the date is an error.

### `nbg_list_currencies`

Lists every currency NBG publishes a GEL rate for today. NBG quoted other currencies in the past, so a code missing here may still have historical rates.

Inputs:

| Name       | Required | Description                                                        |
| ---------- | -------- | ------------------------------------------------------------------ |
| `language` | no       | Language of the currency names: `en` (default) or `ka` (Georgian). |

Output:

- `effectiveDate`: the date today's rates took effect.
- `currencies`: one entry per currency with `code`, `name` and `nbgQuantity` (the units NBG quotes the raw rate for).

### `nbg_rate_history`

The official rate of one currency, in GEL per one unit, in force on every calendar day of an inclusive range. One call makes one request to NBG.

Inputs:

| Name       | Required | Description                                                      |
| ---------- | -------- | ---------------------------------------------------------------- |
| `currency` | yes      | ISO 4217 code, for example `USD`.                                |
| `from`     | yes      | First calendar day, inclusive.                                   |
| `to`       | yes      | Last calendar day, inclusive. At most 366 days including `from`. |

Output:

- `currency`, `from`, `to`: the request, with the code in upper case.
- `days`: one entry per calendar day with `date`, `effectiveDate`, `rate` (GEL per one unit) and `carriedOver`, with the same meaning as in `nbg_get_rates`.

A range that reaches a date NBG has not published yet is an error, as is a day in the range for which NBG's export has no rate of the currency (for example before NBG first quoted it, or after NBG stopped).

### Resource `nbg://rates/{date}`

The full official NBG rate table in force on a calendar date (`YYYY-MM-DD`) or on `today`, as JSON with the same fields as the `nbg_get_rates` output and English currency names. `nbg://rates/today` is listed among the server's resources.

### Errors

A tool that cannot answer returns an error result whose text says what went wrong and what to do next:

- the date is not a real calendar date in the form `YYYY-MM-DD`, or a history range ends before it starts;
- a history range is longer than 366 days;
- the currency is not a three-letter code, or NBG did not quote it on the requested date (`nbg_get_rates` lists such codes in `unknownCodes` instead);
- NBG has no rate in force on the date (the archive starts on 1995-10-14, and a currency has no rate before NBG first quoted it, after NBG stopped quoting it, or where NBG's records have a gap);
- NBG has not published a rate for the date yet; when the latest published rate is known, the message says from which date it is valid;
- NBG did not respond usably; the request can be retried;
- the NBG response did not have the expected shape, which means the NBG endpoint may have changed; please [open an issue](https://github.com/akalongman/nbg-rates-mcp/issues) with the package version.

Reading the resource fails with the same messages.

## Date rules

- NBG sets a rate on business days around 17:00 Tbilisi time, valid from the next calendar day until the next rate. Once it is published, tomorrow's rate can be requested by date.
- "Today" means the calendar date in Tbilisi, wherever the client runs.
- Sundays, Mondays and days after a public holiday have no rate of their own: they carry the earlier rate with `carriedOver: true` and `effectiveDate` set to the day it took effect. Before September 2021 NBG stored a rate for every calendar day, so older Sundays are not carried over.
- A date whose rate NBG has not published yet (tomorrow before about 17:00 Tbilisi time, or any later date) returns an error, never a guess.
- The archive starts on 1995-10-14 with USD; other currencies start later.

## Environment variables

| Variable             | Effect                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `NBG_RATES_BASE_URL` | The NBG host to call. Defaults to `https://nbg.gov.ge`; a trailing slash is removed. Useful for testing. |
| `NBG_RATES_DEBUG`    | Set to `1` to log every upstream request to stderr. Include this log in bug reports.                     |

Set them in the client's configuration, for example:

```json
{
  "mcpServers": {
    "nbg-rates": { "command": "npx", "args": ["-y", "nbg-rates-mcp"], "env": { "NBG_RATES_DEBUG": "1" } }
  }
}
```

## Development

```bash
npm install
npm test                 # unit tests
npm run test:e2e         # builds, then drives the server over stdio against recorded NBG responses
npm run test:contract    # live: checks the assumptions against nbg.gov.ge
npm run record-fixtures  # refreshes test/fixtures from nbg.gov.ge; review the diff before committing
```

Before a pull request, also run `npm run format:check`, `npm run lint` and `npm run typecheck`.

The code is split into `src/core`, pure functions with no I/O (date rules, parsing, per-unit normalisation, conversion, history), and `src/shell`, which holds the effects (the NBG HTTP client, the cache, the rates service and the MCP server). `src/bin.ts` is the executable.

## License

MIT, see [LICENSE](LICENSE).
