# NBG failure cause on the log lines: design

Approved: 2026-10-19.

Amends the log line of `2026-10-15-nbg-failure-alarm-design.md` and the
sync log line of `2026-10-16-nbg-mirror-design.md`. Ships in 0.7.0,
before its tag.

## Why

On 2026-10-19 at 06:36:49 UTC a directory verifier
(`robinsaige-verifier`) made one `nbg_get_rates` call on the hosted
endpoint. The lookup failed and the `nbg-rates-mcp-nbg-failures` alarm
sent its email at 06:37 UTC. The request's log line was:

```json
{"time":"2026-10-19T06:36:49.841Z","method":"tools/call","tool":"nbg_get_rates","client":null,"protocolVersion":null,"status":200,"outcome":"ok","nbgError":"upstream_unavailable","durationMs":1392}
```

NBG answered normally minutes later, and the alarm returned to OK at
06:52 UTC. Why NBG failed is unknown, because nothing recorded it.
`upstream_unavailable` covers an error status, a 429, a timeout, a
reset connection, a redirect loop (the F5 bot defense of 2026-10-15
answered every request with a 307 to itself) and a block page served
as HTML. These call for different responses, from waiting it out to
contacting NBG.

The error object carries a `detail` that would tell them apart
(`HTTP 503 after retry`), but the hosted function writes it nowhere: the
NBG client logs its requests only with `NBG_RATES_DEBUG`, which is off
in production. The detail cannot simply be added to the line either,
because some details carry what a user asked:

- `requirePublished`: `NBG answered 2026-10-19 with a table valid from
  2026-10-20`, the requested date.
- `parseNbgCsv`: `CSV line 3 is malformed: <the line>`, with the
  currency and dates of a history request.
- A body snippet (`unexpected text/html response: <80 characters>`),
  and NBG's block page could echo the request URL with its date.

The privacy text promises that the logs never record the amounts or
currencies asked.

The owner wants the next alarm of this kind to be diagnosable from the
log line. The alarm itself stays as it is: one failed lookup in five
minutes moves it, because the client already retries once and the
endpoint's traffic is low enough that a real outage may show as a single
failed lookup.

## Worked example

The same request after this change, for four possible causes:

| What NBG did | `nbgCause` on the line |
|---|---|
| Answered 503 twice | `HTTP 503 after retry` |
| Closed the connection mid-request twice | `network UND_ERR_SOCKET after retry` |
| Answered 307 to itself until fetch gave up, twice | `network redirect count exceeded after retry` |
| Served a block page as 200 `text/html` | `content-type text/html` |

The line keeps every field it has today and gains `nbgCause`:

```json
{"time":"2026-10-19T06:36:49.841Z","method":"tools/call","tool":"nbg_get_rates","client":null,"protocolVersion":null,"status":200,"outcome":"ok","nbgError":"upstream_unavailable","nbgCause":"HTTP 503 after retry","durationMs":1392}
```

A request with no NBG failure has `"nbgCause":null`, as it has
`"nbgError":null`.

## Goals

- Every request log line and every sync log line that names an NBG
  failure also names its cause (`nbgCause` and `syncCause`), in a short
  string a person can read in the CloudWatch console.
- The cause never carries anything derived from a user's request, from
  the request URL or from NBG's response body.

## Non-goals

- No change to the alarm, its metric filter or its threshold. The
  metric filter matches `nbgError` and keeps working.
- No change to what a user is told. The tool error text keeps using
  `detail`, as today.
- No logging of NBG's individual requests in production. Debug logging
  stays opt-in.
- No retry or redirect handling change in the NBG client.

## Anti-goals

- A cause that leaks a date, a currency code, an amount, a URL or body
  text into the log. That breaks the published privacy promise even if
  the field is useful.
- A free-text cause that needs a scrubber to be safe. Scrubbers miss
  cases; the cause is built from known parts instead.

## Design

### The cause on the error

Both NBG failure kinds in `RatesError` (`src/core/types.ts`) gain a
required field, beside `detail`:

```ts
| { readonly kind: 'upstream_unavailable'; readonly detail: string; readonly cause: string }
| { readonly kind: 'upstream_shape_changed'; readonly detail: string; readonly cause: string }
```

Required, so the compiler names every place that builds one. Each place
builds `cause` from the vocabulary below, never from `detail`.

### The vocabulary

A cause is one category, an optional value, and ` after retry` exactly
where `detail` gets it today: both attempts failed in a way the client
retries (a 429 or 5xx, a timeout, a network error). A retried request
whose second attempt ends otherwise (a 503, then a 404) has the second
attempt's cause without the suffix (`HTTP 404`), as its `detail` has
(design call). At most 100 characters.

| Category | Value | Built where |
|---|---|---|
| `HTTP <status>` | the status number | client: any answer outside 2xx (a 3xx reaches here only without a usable `Location`) |
| `timeout` | none | client: the request timeout fired (`TimeoutError`) |
| `network <value>` | the fetch error's cause `code` when it is a string matching `^[A-Z][A-Z0-9_]{3,63}$` (`UND_ERR_SOCKET`, `ENOTFOUND`, `ECONNRESET`); otherwise the cause's `message` when it matches `^[a-z][a-z ]{0,59}$` (`redirect count exceeded`, `other side closed`); otherwise no value | client: fetch rejected, or the body failed to read |
| `content-type <type>` | the media type without parameters, when it matches `^[a-z0-9.+-]+/[a-z0-9.+-]+$` and keeps the cause within 100 characters; otherwise `none` for a missing header and `other` for anything else | client: a 2xx answer of the wrong type |
| `invalid JSON` | none | client: the body is not JSON |
| `shape json` | none | `parseNbgResponse` |
| `shape csv header`, `shape csv line` | none | `parseNbgCsv` |
| `shape table date` | none | `requirePublished` |
| `shape answer` | none | the sync's wrap of a non-failure error (`sync-publication.ts`) |

The value rules are the privacy guarantee. The values come from the
fetch library's fixed error codes and messages, and the rules make sure
that even a message which echoed the request could not pass (design
call, from the builder check):

- An error code is four or more upper-case letters, digits and
  underscores, so it cannot be a three-letter ISO currency code.
- A cause message is lower-case letters and spaces only, so it cannot
  hold a URL, a date, a number or an upper-case currency code.
- A media type is checked against its own grammar.

Anything that fails a rule is dropped, not cleaned.

### The log lines

- `RequestLogLine` (`src/shell/http.ts`) gains
  `readonly nbgCause: string | null`, the `cause` of the same failure
  `nbgError` names (the first one the request met), placed right after
  `nbgError`. Null when `nbgError` is null.
- `SyncLogLine` (`src/shell/sync.ts`) gains `readonly syncCause: string |
  null`, the `cause` of the NBG failure that failed the run, else null
  (a run that fails on the store or on `empty_export` has null), placed
  right after `syncDetail`. `syncDetail` keeps its meaning
  (`upstream_unavailable` for such a run). The name follows the mirror
  design's rule that the sync line uses its own field names, so a
  metric filter written for the request line never counts a sync run.

Both fields are always present, so a Logs Insights query can rely on
them.

### Docs

- The 0.7.0 changelog entry gains a `Changed:` line naming `nbgCause`
  and `syncCause` and the rule that they carry nothing from the request.
- The log line sections of the two amended specs gain the field.
- The privacy text (README, landing page in both languages, directory
  listings) is unchanged. It says the first log records "whether NBG
  answered", and the cause describes only NBG's answer.

## Proof

- One test per vocabulary row, through the place that builds it.
- The privacy test: a fake fetch that rejects with a `TypeError` whose
  message and whose cause's message contain the full request URL (date
  and path), and a block page whose body contains the URL. Neither
  cause contains the date, the URL or any part of the body. A
  `parseNbgCsv` failure on a line with `USD` and a date has the cause
  `shape csv line`. A `requirePublished` failure's cause has no date.
- The request log line tests show `nbgCause` beside `nbgError`, and the
  sync log line tests show `syncCause` beside `syncDetail`, each null
  when there is no NBG failure.

## Left to the builder

- Where the cause-building helpers live, and their names.
- The test fixtures' causes (any valid vocabulary string).

## Follow-up outside this repository

At Part B step B4 of the mirror plan, the
`nbg-rates-mcp-nbg-failures` alarm description in `personal/iac` (which
says how to see the failure kind) also names `nbgCause`, and that
repository's `docs/aws.md` mentions it.
