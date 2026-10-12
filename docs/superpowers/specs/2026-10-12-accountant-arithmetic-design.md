# nbg-rates-mcp 0.4.0: arithmetic on the server, batch conversion

Date: 2026-10-12. Amends `2026-10-08-nbg-rates-mcp-design.md` (the main
spec); where they disagree, this document wins for the sections it names.
The onboarding spec of 2026-10-09 is unchanged.

## Purpose

An accountant asks for a converted amount and gets a number for a ledger.
Today the server returns an unrounded float and tells the model to round
it, which puts the one step that must be exact into the least reliable
place. Three changes move that arithmetic into the server without touching
how any rate is computed, and one change makes a list of invoices one
tool call:

1. Wording: tool descriptions, prompts and error texts say what the
   accountant sees on nbg.gov.ge and what to do next.
2. `resultRounded` on every conversion, computed exactly and rounded half
   up to two decimals.
3. A `summary` on `nbg_rate_history` with the first, last, lowest, highest
   and average rate, computed exactly.
4. `nbg_convert_many`, a batch of conversions with one NBG request per
   distinct date and per-item errors.

The release is 0.4.0: a new tool and new output fields. No existing field
changes shape or meaning.

## Background (checked 2026-10-12 against 0.3.0, live)

- `nbg_convert` of 1.5 USD on 2026-10-10 returns `result`
  3.9007499999999995 (exact: 3.90075). 10 USD returns 26.005, which
  JavaScript's `toFixed(2)` prints as 26.00 while a ledger rounds to 26.01.
  The prompts ask the model to "round to 2 decimal places" and leave the
  method to it.
- The monthly prompt asks the model to find the first, last, lowest and
  highest rate of 30 numbers itself; the server has them.
- Twenty invoices on twenty dates are twenty `nbg_convert` calls, each a
  permission prompt in Claude Desktop until "Allow always" is chosen.
- NBG quotes JPY as 1.6452 GEL per 100; the tool returns 0.016452 and the
  prompts say "per one unit", so the answer does not match what the
  accountant verifies against on nbg.gov.ge or in accounting software.
- Converting "dollar" answers "NBG did not quote dollar on the requested
  date or range. Call nbg_list_currencies", which sends the model to the
  currency list instead of to the code USD.
- A history range that reaches a future day fails as a whole with "NBG has
  not published a rate for 2026-10-31 yet" and no hint of the last date it
  can answer, so the monthly prompt always fails for the current month.
- Every NBG rate has at most four decimals (`nbg-csv.ts` and
  `nbg-schema.ts` reject more), and the quantity is a power of ten. The
  exact product of an amount and a rate is therefore a terminating
  decimal; only a division by a rate (GEL to a currency, or a cross pair)
  is not.

## Change 1: wording and errors

### Display rule

A new constant in `server.ts`, appended to the descriptions of
`nbg_get_rates`, `nbg_list_currencies` and to `SERVER_INSTRUCTIONS`:

> When nbgQuantity is not 1, state NBG's quoted form first, nbgRate GEL per
> nbgQuantity units (for example 1.6452 GEL per 100 JPY), and the per-unit
> rate beside it: that quoted form is what nbg.gov.ge and accounting
> software show.

The descriptions of `nbg_convert` and `nbg_convert_many`, and
`SERVER_INSTRUCTIONS`, add:

> Show resultRounded as the amount; result is the unrounded value for
> further calculation.

`nbg_list_currencies` returns quantities but no rates, so it cannot show
the quoted form itself; its description gets a shorter sentence instead
of the display rule:

> nbgQuantity is the unit count NBG quotes the raw rate for (JPY is quoted
> as 1.6452 GEL per 100 JPY); for the rates themselves call nbg_get_rates.

### A distinct error for a value that is not a code

New `RatesError` variant `invalid_currency_code: { value: string }`,
returned by `parseCurrencyCode` instead of `unknown_currency`. Message:

> "dollar" is not a currency code. Use the three-letter ISO 4217 code, for
> example USD for US dollars, EUR for euros or GEL for lari.

`unknown_currency` keeps its message for a well-formed code NBG did not
quote. `nbg_get_rates` is unchanged: a malformed entry still lands in
`unknownCodes` as typed, because `splitCodes` only checks `ok`.

### The future-date error names the last answerable date

`rate_not_published` gains `today: CalendarDate` (the Tbilisi date at the
time of the call). `rejectBeyondTomorrow` and `requirePublished` fill it.
Message:

> NBG has not published a rate for 2026-10-31 yet. Today in Tbilisi is
> 2026-10-12; the latest date that can have a rate is 2026-10-13, after
> about 17:00 Tbilisi time. [The latest published rate is valid from
> 2026-10-12.] For a range, end it at today.

The bracketed sentence appears when `latestEffectiveDate` is known, as
today. `PUBLICATION_RULE` stays in the text.

### Prompts

`nbg_monthly_rates` text becomes:

> Using nbg_rate_history from the first day of ${arguments.month} to its
> last day, or to today when the month is not over, give me a table of the
> official National Bank of Georgia rate of ${arguments.currency} for every
> day, in GEL per one unit, marking the days whose rate is carried over
> from an earlier day. Below the table report the summary the tool
> returns: first, last, change, lowest and highest rate with their dates,
> and the average over the calendar days.

`nbg_convert_amount` text ends with "and the result as resultRounded"
instead of "and the result rounded to 2 decimal places".

`nbg_rates_today` defaults to USD, EUR, GBP and TRY (argument description
and text).

`manifest.json` mirrors the three texts verbatim (the drift test already
compares them).

### README

"What you can ask" gains one line after the examples: write the date with
the month as a word, "10 September 2026", because 10/09/2026 reads as two
different dates. The Tools section documents the new fields, the new tool
and the two changed error messages.

## Change 2: `resultRounded`

### Exact arithmetic

New pure module `src/core/decimal.ts`:

- `type Rational = { readonly numerator: bigint; readonly denominator: bigint }`,
  denominator positive.
- `decimalToRational(value: number): Rational`: from the number's shortest
  decimal representation (`String(value)`, with exponent notation expanded,
  so 1e-7 and 1e21 are handled). Throws on a non-finite number; the input
  schemas already reject those.
- `roundHalfUp(value: Rational, decimals: number): number`: exact round
  half up, away from zero for negatives, returned as a number. For
  `decimals` 2 the result has at most two decimals and is exactly
  representable as a short decimal string, so it reaches the model as
  `26.01`, never `26.009999999999998`.
- `formatDecimals(value: number): number`: the number of decimals in the
  shortest representation (0 for 26, 4 for 2.6005, 7 for 0.0071783).

`convert.ts` builds the conversion as one rational:

```
amount * fromRate / fromQuantity * toQuantity / toRate
```

where GEL contributes rate 1, quantity 1, and `fromRate`, `toRate` are the
raw `nbgRate` values (at most four decimals, exact as decimals). Identical
codes give `amount`. `resultRounded = roundHalfUp(that, 2)`. `result` and
`rate` keep their current float computation, so no existing value changes.
The identity case in `server.ts` (GEL to GEL) sets
`resultRounded = roundHalfUp(decimalToRational(amount), 2)`.

`Conversion` and `convertOutput` gain `resultRounded: number`, described
as "result rounded half up to 2 decimals, computed exactly; the amount to
show". JSON carries no trailing zeros, so 3.90 arrives as `3.9`; the
description says so, and the prompts ask for two decimals in the answer.

Worked example, 2026-10-10 (USD 2.6005 per 1, JPY 1.6452 per 100):

| amount | from | to | result (unchanged) | resultRounded |
| --- | --- | --- | --- | --- |
| 10 | USD | GEL | 26.005 | 26.01 |
| 1.5 | USD | GEL | 3.9007499999999995 | 3.90 |
| -10 | USD | GEL | -26.005 | -26.01 |
| 1000000 | JPY | GEL | 16452 | 16452 |
| 100 | GEL | USD | 38.45414343395501 | 38.45 |

### Tests

- Unit: `decimalToRational` on integers, decimals, negatives, exponent
  notation; `roundHalfUp` on the ties above and on an exact tie in a
  quotient: 0.0130125 GEL at 2.6025 is exactly 0.005 USD, rounded to 0.01,
  and -0.0130125 GEL to -0.01.
- Property (fast-check), currency to GEL: for random amounts with up to
  6 decimals and random NBG-shaped rates (1 to 4 decimals, quantity a
  power of ten up to 10000), `resultRounded` equals an oracle that works
  on integers only: amount and rate scaled to integers by their decimal
  counts, multiplied, then divided by the quantity and the scale with
  integer half-up rounding to two decimals. The oracle never touches a
  float or `decimal.ts`.
- Property, `convertAmount` itself, currency to GEL: the same integer
  oracle against a snapshot holding a generated quote.
- Property, every pair: `Math.abs(resultRounded - result) <= 0.005 +
  1e-14 * Math.abs(result)` and `resultRounded` has at most two decimals.
  The relative term covers the float error of `result` (a few ulps for
  at most three operations), which a fixed 1e-9 does not at amounts in
  the billions.
- Server: `nbg_convert` output carries `resultRounded`; the e2e test's
  fixture conversion asserts it.

## Change 3: history summary

`HistorySeries` is unchanged. `historyOutput` adds:

```json
"summary": {
  "first": 3.0333, "last": 2.9552, "change": -0.0781,
  "min": 2.9552, "minDate": "2026-09-30",
  "max": 3.0424, "maxDate": "2026-09-02",
  "average": 3.0086
}
```

(EUR, 2026-09-01 to 2026-09-30, from the live server on 2026-10-12: the
30 per-unit rates sum to 90.2574, the exact mean is 3.00858, rounded half
up to four decimals 3.0086.)

- `first`, `last`: the rate on the first and last day of the range.
- `change`: `last - first`, exact, rounded half up to the series'
  decimals.
- `min`, `max` with `minDate`, `maxDate`: the first calendar day the value
  occurs on.
- `average`: the arithmetic mean over every calendar day of the range,
  carried-over days included (the basis of NBG's own period averages and
  of a period-end revaluation), exact, rounded half up to the series'
  decimals.
- The series' decimals: the largest `formatDecimals(rate)` over the days,
  so USD stays at 4 and AMD at 7, matching how NBG prints averages.

Computed in a new pure function `summarizeHistory(days)` in
`src/core/history-summary.ts`, using `decimal.ts`. `rateHistoryOutput`
declares the summary with descriptions ("average over calendar days,
carried-over days included").

Tests: a hand-checked five-day series (first, last, change, min and max
with first-occurrence dates, average with a tie at the last decimal);
property: `min <= average <= max` and `change == last - first` within one
unit of the last decimal; the e2e history assertion gains the summary.

## Change 4: `nbg_convert_many`

### Interface

Input:

| Name | Required | Description |
| --- | --- | --- |
| `items` | yes | 1 to 100 entries of `{ amount, from, to, date? }`, each with the rules of `nbg_convert`. |

The item schema checks shape only (a finite number and strings of at most
64 characters); the date and code rules are applied per item by the
handler. `nbg_convert` rejects `10.09.2026` or an empty code at its schema,
which is fine for one call; in a batch the same input must cost only its
item, with the same error text.

Output:

- `items`: one entry per input, in input order. A converted item is the
  `nbg_convert` output (with `resultRounded`). A failed item is
  `{ amount, from, to, date, error }`, `date` as given or omitted, `error`
  the sentence `nbg_convert` would return for the same call.
- `converted`, `skipped`: counts.
- `total`: `{ to, resultRounded }`, present only when `converted` is at
  least 1, every converted item has the same `to`, and the sum is a finite
  number. `resultRounded` is the sum of the items' `resultRounded` values,
  computed exactly, the way a ledger sums posted lines: two lines of
  26.025 post as 26.03 + 26.03 = 52.06, where rounding the summed 52.05
  would give 52.05. Absent when targets differ. The description tells the
  model that the total covers the converted items only and to call it
  partial when `skipped` is not 0.

Worked example: items 10 USD and 1.5 USD to GEL on 2026-10-10, and 100 USD
to GEL on 2026-13-01.

```json
{
  "items": [
    { "amount": 10, "from": "USD", "to": "GEL", "result": 26.005, "resultRounded": 26.01, "rate": 2.6005, "via": "direct", "requestedDate": "2026-10-10", "effectiveDate": "2026-10-10", "carriedOver": false },
    { "amount": 1.5, "from": "USD", "to": "GEL", "result": 3.9007499999999995, "resultRounded": 3.9, "rate": 2.6005, "via": "direct", "requestedDate": "2026-10-10", "effectiveDate": "2026-10-10", "carriedOver": false },
    { "amount": 100, "from": "USD", "to": "GEL", "date": "2026-13-01", "error": "2026-13-01 is not a valid calendar date (not a real calendar date); use YYYY-MM-DD." }
  ],
  "converted": 2,
  "skipped": 1,
  "total": { "to": "GEL", "resultRounded": 29.91 }
}
```

Description:

> Converts a list of amounts, each at the official NBG rate in force on its
> own date: one call for a list of invoices. Items are answered
> independently; a bad date or code fails only its item, with the error
> text in that item. total is present when every converted item has the
> same target currency. Show resultRounded as the amounts. [DATE_RULES]

### Behaviour

- Per-item validation (date, codes) happens first, without a request.
- The remaining items are grouped by resolved date. Dates are fetched one
  after another through `service.getSnapshot` (so the cache and the
  beyond-tomorrow check apply as for `nbg_convert`); a failed date fails
  every item on it with that date's error.
- Each conversion uses `convertAmount`, so an unknown code or an overflow
  is a per-item error with the existing text.
- The tool is registered with the same read-only annotations. The whole
  call fails only on an input the schema rejects (an empty list, more than
  100 items, a non-numeric amount).

Sequential fetching bounds the load on nbg.gov.ge: 100 items on 100
distinct dates is 100 requests, about 15 seconds cold when NBG answers
and well under a client's tool timeout; typical lists share a few dates
and finish in under a second. When NBG does not answer, one date costs
up to 20.5 seconds (two attempts with a 10-second timeout each), so the
handler stops asking after the first `upstream_unavailable`: every date
not yet fetched gets that same error without a request, and the call
returns within the client's timeout with the items that did convert.

### Tests

- Server (in-memory client): the worked example above against fixture
  days, including a `10.09.2026` date and an empty code that fail only
  their items; a list whose items span two dates makes exactly two
  upstream requests; a date NBG has not published fails only its items;
  after an `upstream_unavailable` the later dates are not requested; two
  equal lines total to the sum of the rounded lines; mixed targets and a
  non-finite sum omit `total`; 101 items are rejected by the schema and
  100 are answered.
- E2e: the built binary lists five tools and answers one batch.
- Manifest: `manifest.json` `tools` gains the entry; the existing identity
  drift test is extended to assert the manifest's tool names equal the
  registered ones.

## Release 0.4.0

- `package.json`, `manifest.json` and `server.json` move to 0.4.0.
- CHANGELOG entry:

  > Added: `nbg_convert_many`, a batch of conversions, each at the rate of
  > its own date, with per-item errors and a total; `resultRounded` on
  > every conversion, computed exactly and rounded half up to two decimals;
  > a `summary` (first, last, change, lowest, highest, calendar-day
  > average) on `nbg_rate_history`.
  >
  > Changed: descriptions and prompts ask for NBG's quoted form (for
  > example 1.6452 GEL per 100 JPY) beside the per-unit rate; a value that
  > is not a currency code gets its own error text; the future-date error
  > names the last date that can have a rate; the monthly prompt ends at
  > today for the current month; the today's-rates prompt adds TRY.

## Documents updated with the code

- `README.md`: the date line, `resultRounded`, `summary`,
  `nbg_convert_many`, the two error messages.
- `CHANGELOG.md`: the 0.4.0 entry.
- `manifest.json`: tool list, prompt texts.

## Out of scope

- `nbgQuantity` in the history output (the per-unit value is the only one
  there; the display rule applies where the quantity is present).
- Batch-level default currencies and parallel NBG requests.
- Per-currency minor units (JPY 0, KWD 3): NBG does not publish them and
  the table would be maintained by hand. Every `resultRounded` has two
  decimals.
- A published-days average alongside the calendar-day one.
- A hosted HTTP endpoint, a Georgian README, install screenshots.
