# nbg-rates-mcp 0.2.0: context efficiency

Date: 2026-10-09. Amends `2026-10-08-nbg-rates-mcp-design.md` (the main
spec); where the two disagree, this document wins for the sections it names.

## Purpose

Three changes, taken from current MCP client and specification guidance
(researched 2026-10-09), that cut what the server costs a client's context
and help a client load the server when a question needs it:

1. Server instructions.
2. A compact `nbg_rate_history` output.
3. Server identity metadata.

The release is 0.2.0, not 0.1.1, because change 2 alters a tool's output
contract, and under 0.x semantic versioning a caret range (`^0.1.0`) must not
pick up a breaking change.

## Background (measured 2026-10-09 against 0.1.0)

- With MCP tool search on, which is Claude Code's default, a session loads
  only tool names and each server's instructions at start; full tool
  definitions load on demand. Claude Code's documentation says server
  instructions help it "understand when to search for your tools" and
  truncates them at 2,048 characters. 0.1.0 sends no instructions, so a new
  session sees only names such as `nbg_get_rates` and has to guess that
  "nbg" is the National Bank of Georgia.
- Claude Code warns when one tool result exceeds 10,000 tokens (a fixed
  threshold) and caps a result at 25,000 tokens by default.
- A 366-day USD history from 0.1.0 is 31,018 characters, an estimated 8,900
  to 10,300 tokens: at or past that warning. 116 of the 366 days (32%) were
  carried over. The main spec's estimate of about 35 tokens per day puts a
  full year near 12,800 tokens.
- The four tool definitions total 8,316 characters (about 2,400 tokens); with
  tool search they load only when a question needs them.

Sources: Claude Code MCP documentation (code.claude.com/docs/en/mcp), MCP
specification revision 2026-07-28 (server/discover, tools).

## Change 1: server instructions

The server passes these instructions through the SDK's server options
(`instructions`), as a constant in `src/shell/server.ts`. The text, exactly:

> Official exchange rates of the Georgian lari (GEL) set by the National Bank
> of Georgia (NBG). Use these tools for any question about GEL rates,
> converting to or from GEL, or historical NBG rates on a date or over a
> range. Dates are Tbilisi calendar days; quote effectiveDate when
> carriedOver is true.

"Official exchange rates" names the rate NBG sets; it does not claim the
package is official. The text stays under 400 characters, leads with what the
server is for, and repeats nothing that only one tool needs.

Acceptance: a client connected in memory reads exactly this text, and so does
a client connected to the built binary over stdio.

## Change 2: compact `nbg_rate_history` output

This replaces the `days` paragraph of the main spec's `nbg_rate_history`
contract.

`days` holds one entry per calendar day of the range, in order:

- A day whose own publication is in force: `{ date, rate }`.
- A carried-over day: `{ date, rate, effectiveDate, carriedOver: true }`.

Keys appear in that order. `carriedOver` never appears as `false`. An absent
`effectiveDate` means the rate took effect on `date` itself. Every calendar day is still included, for
the reason the main spec gives.

Worked example, USD from 2026-10-02 (Friday) to 2026-10-06 (Tuesday), values
as NBG published them:

```json
{
  "currency": "USD",
  "from": "2026-10-02",
  "to": "2026-10-06",
  "days": [
    { "date": "2026-10-02", "rate": 2.6042 },
    { "date": "2026-10-03", "rate": 2.6039 },
    { "date": "2026-10-04", "rate": 2.6039, "effectiveDate": "2026-10-03", "carriedOver": true },
    { "date": "2026-10-05", "rate": 2.6039, "effectiveDate": "2026-10-03", "carriedOver": true },
    { "date": "2026-10-06", "rate": 2.6032 }
  ]
}
```

Saturday 2026-10-03 has its own table, so it is a plain day; Sunday and
Monday carry Saturday's rate.

Boundaries:

- `assembleHistory` and the `HistorySeries` type in `src/core/` do not
  change; core keeps full points and its tests stay as they are.
- A pure function in `src/shell/` turns a full point into its wire form when
  the tool result is built. The `content` text block keeps holding the same
  JSON as `structuredContent`.
- The output schema makes `effectiveDate` optional and `carriedOver` an
  optional literal `true`, each with a description stating the rule above.
- The tool description gains one sentence: "Days whose own rate is in force
  contain only date and rate; a carried-over day adds effectiveDate and
  carriedOver: true." (Until 0.2.1 it read "carry only date and rate",
  which used "carry" in a second sense one sentence after "carry the
  earlier rate".)
- The 366-day cap stays. Its rationale becomes: a full year stays near 6,000
  tokens, under the 10,000-token warning of Claude Code.

Size: the same live 366-day USD series in this shape is 18,768 characters,
an estimated 5,400 to 6,300 tokens, about 40% smaller.

Acceptance:

- The mapper turns a plain point into exactly `{ date, rate }` and a
  carried-over point into all four fields, and never emits
  `carriedOver: false`.
- A synthetic 366-day series with five plain days and two carried-over days
  per week, using an eight-decimal rate as the worst case (a currency quoted
  per 10,000 units), serialises to at most 21,000 characters. This guards against the output growing back
  toward the warning.
- The server and end-to-end history tests assert the new shape, including
  the worked example's weekend.

## Change 3: server identity

The server identity sent to clients gains three display fields:

- `title`: `NBG Rates (National Bank of Georgia)`
- `description`: `GEL exchange rates from the National Bank of Georgia with
  per-unit values. Not affiliated with NBG.`
- `websiteUrl`: `https://github.com/akalongman/nbg-rates-mcp`

`name` (`nbg-rates-mcp`) and `version` stay as they are. No icon, because the
package ships no image to point at. Per the MCP specification, clients use
these fields for display and do not change behaviour on them.

`title` and `description` must equal the `title` and `description` in
`server.json`. A test reads `server.json` and compares, so the copies cannot
drift.

Acceptance: a client connected to the built binary over stdio reads all five
identity fields.

## Release 0.2.0

- Version fields: `npm version 0.2.0 --no-git-tag-version` (it updates
  `package-lock.json` too), both version fields in `server.json`, and
  `manifest.json`.
- `CHANGELOG.md` gains a `## 0.2.0 - <release date>` section above 0.1.0:
  first the breaking history change, then the instructions and the identity
  fields.
- The `v0.2.0` tag is pushed only after the changes are on `main` with green
  CI. `release.yml` then publishes to npm (with provenance), GitHub and the
  MCP registry.

## Documents updated with the code

- Main spec: the "Tool contracts" introduction (instructions and identity),
  the `nbg_rate_history` output paragraph, and the cap rationale.
- `README.md`: the `nbg_rate_history` output description and example.

## Out of scope

- The duplicated JSON in `content` and `structuredContent`. The MCP
  specification says a server SHOULD include the text copy, and no source
  confirms which of the two Claude Code passes to the model.
- A `response_format` input choosing between output sizes: one compact
  format serves every caller.
- Icons, and the other findings deferred from the 0.1.0 reviews.
