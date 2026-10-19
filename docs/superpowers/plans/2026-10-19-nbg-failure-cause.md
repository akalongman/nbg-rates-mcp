# NBG Failure Cause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every log line that names an NBG failure also names its cause (`nbgCause` on the request line, `syncCause` on the sync line), built from a fixed vocabulary that cannot carry anything a user asked.

**Architecture:** Both NBG failure kinds of `RatesError` gain a required `cause` of a branded type `NbgCause`, which only `src/core/nbg-cause.ts` constructs, so every place that builds a failure must go through the vocabulary's rules. The request line reads the cause from the failure its lookup scope already holds; the sync line carries it through `RunOutcome`.

**Tech Stack:** TypeScript on Node 24, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-nbg-failure-cause-design.md` (approved 2026-10-19). Ships in 0.7.0, before its tag.

## Global Constraints

- Names, verbatim: the error field `cause`; the type `NbgCause = string & { readonly __brand: 'NbgCause' }` in `src/core/types.ts` beside `CalendarDate`; the request line field `nbgCause` right after `nbgError`; the sync line field `syncCause` right after `syncDetail`. Both fields are always present, `string | null`.
- Vocabulary, verbatim: `HTTP <status>`, `timeout`, `network` with an optional value, `content-type <type>` (or `none`, `other`), `invalid JSON`, `shape json`, `shape csv header`, `shape csv line`, `shape table date`, `shape answer`, and the suffix ` after retry`.
- Value rules, verbatim: an error code is used when it matches `^[A-Z][A-Z0-9_]{3,63}$`; otherwise a cause message when it matches `^[a-z][a-z ]{0,59}$`; otherwise no value. A media type is the header's part before `;`, trimmed and lower-cased, used when it matches `^[a-z0-9.+-]+/[a-z0-9.+-]+$` and the cause stays within 100 characters; a missing or empty header is `none`, anything else `other`. Nothing is cleaned: a value that fails its rule is dropped.
- ` after retry` goes exactly where `detail` gets it today: both attempts ended in a retryable outcome. A retried request whose second attempt is fatal has that attempt's cause alone.
- Unchanged: `detail` and every text a user sees; the alarm, its metric filter and the privacy text; the client's retry behavior.
- Gates: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`, then `DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm run test:dynamodb` against DynamoDB Local `amazon/dynamodb-local:3.3.2` (stop the container afterwards), then `bash scripts/build-bundle.sh && npx tsx scripts/check-release.ts 0.7.0`.
- No em or en dashes anywhere (code, comments, docs, commit messages). Repository prose is agent-neutral.
- Commits on `main`, path-limited (`git add <paths> && git commit -m "<title>" -- <paths>`), signed as configured, titles under 72 characters, no attribution trailers. Never push or tag.

## Review Focus

1. A fetch error whose message and cause message carry the request URL (a CSV export URL with `currencies=USD` and its dates): the cause must be `network after retry`, with no URL, date or code. Task 1 tests it through `fetchRange`.
2. A block page served as 200 `text/html` whose body echoes the request URL: the cause is `content-type text/html` and nothing of the body. Task 1 tests it.
3. A 503 followed by a 404: two requests, the cause `HTTP 404` without the suffix, matching `detail`. Task 1 tests it.
4. A body that fails after the status line (`TypeError: terminated` while reading): a retryable network failure, `network after retry`, as `detail` treats it today. Task 1 extends the existing test.
5. A request that meets two failures: `nbgCause` belongs to the same failure as `nbgError` (the first one). Task 2 asserts both on the existing two-failure test.

---

### Task 1: Name the cause of every NBG failure

**Files:**
- Create: `src/core/nbg-cause.ts`, `src/core/nbg-cause.test.ts`, `src/shell/sync-publication.test.ts`
- Modify: `src/core/types.ts`, `src/shell/nbg-client.ts`, `src/core/nbg-schema.ts`, `src/core/nbg-csv.ts`, `src/core/normalize.ts`, `src/shell/sync-publication.ts`
- Test: `src/shell/nbg-client.test.ts`, `src/core/nbg-csv.test.ts`, `src/core/normalize.test.ts`, `src/core/nbg-schema.test.ts`
- Modify as the type check requires: every test fixture that builds an NBG failure (known: `test/helpers/sync-harness.ts` `UNAVAILABLE`, and the `UNAVAILABLE`/`SHAPE_CHANGED` constants of `src/shell/http.test.ts`, `src/shell/mirrored-rates-service.test.ts`, `src/shell/lookup-scope.test.ts`, `src/shell/sync-archive.test.ts`, plus inline ones in `src/shell/server.test.ts`, `src/shell/nbg-failure.test.ts`, `src/shell/rates-service.test.ts`, `src/shell/sync.test.ts`, `test/helpers/fake-nbg.test.ts`). Each gets a cause from `nbg-cause.ts` that matches its `detail` (`HTTP 503 after retry` gets `afterRetry(httpCause(503))`). Name each file touched in the report.

**Interfaces:**
- Produces, in `src/core/types.ts`:
  ```ts
  export type NbgCause = string & { readonly __brand: 'NbgCause' };
  // in RatesError:
  | { readonly kind: 'upstream_unavailable'; readonly detail: string; readonly cause: NbgCause }
  | { readonly kind: 'upstream_shape_changed'; readonly detail: string; readonly cause: NbgCause }
  ```
- Produces, in `src/core/nbg-cause.ts` (no imports beyond the `NbgCause` type; the only module that asserts the brand):
  ```ts
  export function httpCause(status: number): NbgCause;
  export function requestErrorCause(error: unknown): NbgCause; // 'timeout' or 'network[ <value>]'
  export function contentTypeCause(header: string | null): NbgCause;
  export function afterRetry(cause: NbgCause): NbgCause;
  export const NBG_CAUSE: Readonly<{
      invalidJson: NbgCause; shapeJson: NbgCause; shapeCsvHeader: NbgCause;
      shapeCsvLine: NbgCause; shapeTableDate: NbgCause; shapeAnswer: NbgCause;
  }>;
  ```

- [ ] **Step 1: Write the failing tests**

`src/core/nbg-cause.test.ts`, one `it` per case:

| Input | Expected |
|---|---|
| `requestErrorCause(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))` | `'timeout'` |
| `requestErrorCause(new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }))` | `'network UND_ERR_SOCKET'` |
| the same with code `'ENOTFOUND'` and message `'getaddrinfo ENOTFOUND nbg.gov.ge'` | `'network ENOTFOUND'` |
| `new TypeError('fetch failed', { cause: new Error('redirect count exceeded') })` | `'network redirect count exceeded'` |
| a cause with code `'EIO'` and message `'bad port'` | `'network bad port'` |
| a cause with code `'USD'` and message `'USD'` | `'network'` |
| `new TypeError('fetch failed https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/export/csv?currencies=USD&start=2026-10-01&end=2026-10-19', { cause: new Error('connect failed for https://nbg.gov.ge/...?date=2026-10-19') })` | `'network'` |
| `new TypeError('terminated')` (no cause), and the string `'boom'` | `'network'` |
| `contentTypeCause('text/html; charset=utf-8')`, `contentTypeCause('Text/HTML')` | `'content-type text/html'` |
| `contentTypeCause(null)`, `contentTypeCause('')` | `'content-type none'` |
| `contentTypeCause('text/html <b>2026-10-19</b>')`, `contentTypeCause('a/' + 'b'.repeat(90))` | `'content-type other'` |
| `afterRetry(httpCause(503))` | `'HTTP 503 after retry'` |
| `Object.values(NBG_CAUSE)` | `['invalid JSON', 'shape json', 'shape csv header', 'shape csv line', 'shape table date', 'shape answer']` |

`src/shell/nbg-client.test.ts`, existing tests gain a cause assertion (`result.ok === false && result.error.kind !== ... && result.error.cause`, or `toEqual` where the test already compares the whole error):

| Test | `cause` |
|---|---|
| gives up after the second 503 | `'HTTP 503 after retry'` |
| does not retry a 404 | `'HTTP 404'` |
| times out and reports upstream_unavailable | `'timeout after retry'` |
| makes one attempt without retry (its `toEqual` gains `cause`) | `'HTTP 503'` |
| gives up after one timed-out attempt without retry | `'timeout'` |
| reports an HTML firewall block page | `'content-type text/html'` |
| reports a JSON content type with an unparseable body | `'invalid JSON'` |
| reports parsed JSON that fails the schema | `'shape json'` |
| reports a connection failure (port 1, which fetch refuses as `bad port`) | `'network bad port after retry'` |
| logs one line per attempt when the body fails after the status line | `'network after retry'` |
| fetchRange: reports an HTML block page | `'content-type text/html'` |
| fetchRange: reports a CSV with a changed header | `'shape csv header'` |

New tests in `src/shell/nbg-client.test.ts`:
- `ends with the second attempt's cause when a 503 is followed by a 404`: the responder answers 503, then 404. Two requests; the error is `upstream_unavailable` with `detail` `'HTTP 404'` and `cause` `'HTTP 404'`.
- `keeps the request URL out of a network failure's cause`: `fetchImpl` rejects every call with the error below, where `url` is the URL it was given. `fetchRange([code('USD')], date('2026-10-01'), date('2026-10-19'))` fails with `cause` `'network after retry'`, and the cause contains none of `'2026'`, `'USD'`, `'nbg'`, `'/'`.

  ```ts
  new TypeError(`fetch failed for ${url}`, { cause: new Error(`connect failed for ${url}`) })
  ```
- `keeps a block page's body out of the cause`: the responder answers 200 `text/html` with a body containing `date=2026-10-07`; the cause is `'content-type text/html'`.

Core tests:
- `src/core/nbg-csv.test.ts`: `rejects a changed header` expects `cause` `'shape csv header'`; `rejects a quoted field and a wrong field count` and `rejects malformed values` expect `'shape csv line'`, and the malformed case's cause contains neither `USD` nor a date.
- `src/core/normalize.test.ts`: `rejects a table that took effect after the requested date as a shape change` expects `cause` `'shape table date'`.
- `src/core/nbg-schema.test.ts`: `rejects non-JSON-shaped input` expects `cause` `'shape json'`.
- `src/shell/sync-publication.test.ts` (new): `syncNbgFailure({ kind: 'no_data_for_date', date: date('2026-10-07'), currency: undefined })` equals `{ kind: 'upstream_shape_changed', detail: 'NBG answered no_data_for_date', cause: 'shape answer' }`; an `upstream_unavailable` failure passes through with its own cause.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/core/nbg-cause.test.ts src/shell/nbg-client.test.ts src/core/nbg-csv.test.ts src/core/normalize.test.ts src/core/nbg-schema.test.ts src/shell/sync-publication.test.ts`
Expected: FAIL (the module does not exist; the errors have no `cause`).

- [ ] **Step 3: Implement the type, the module and the construction sites**

- `types.ts`: the brand and the field as in Interfaces.
- `nbg-cause.ts`: the functions with the Global Constraints' rules. `requestErrorCause` returns `'timeout'` for an `Error` named `TimeoutError`; otherwise `'network'` plus the value from the error's `cause` (an object with a string `code` or `message`). Comment the privacy guarantee once, at the module head.
- `nbg-client.ts`: the `retryable` attempt carries a `cause` beside its `detail` (`httpCause(status)` for 429 and 5xx, `requestErrorCause(error)` in the catch); the fatal ones get `httpCause(status)` and `contentTypeCause(header)`; `parseJson` gets `NBG_CAUSE.invalidJson`; `fetchText` applies `afterRetry` where it appends ` after retry` to `detail`.
- `nbg-schema.ts` `NBG_CAUSE.shapeJson`; `nbg-csv.ts` `shapeChanged` takes the cause (`shapeCsvHeader` for the header, `shapeCsvLine` for the three line errors); `normalize.ts` `requirePublished` `shapeTableDate`; `sync-publication.ts` `syncNbgFailure` `shapeAnswer`.
- Then run `npm run typecheck` and give every flagged fixture its cause.

- [ ] **Step 4: Run the gates**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage the changed paths only and commit them path-limited with the title `Name the cause of each NBG failure`.

### Task 2: Log the cause on the request and sync lines

**Files:**
- Modify: `src/shell/http.ts`, `src/shell/sync.ts`, `CHANGELOG.md`, `docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md`, `docs/superpowers/specs/2026-10-15-nbg-failure-alarm-design.md`, `docs/superpowers/specs/2026-10-16-nbg-mirror-design.md`
- Test: `src/shell/http.test.ts`, `src/shell/sync.test.ts`, `test/e2e/http.test.ts`

**Interfaces:**
- Consumes: Task 1's `NbgCause` and the `cause` field of `NbgFailure`.
- Produces: `RequestLogLine.nbgCause: string | null`; `SyncLogLine.syncCause: string | null`.

- [ ] **Step 1: Write the failing tests**

`src/shell/http.test.ts`:
- `logs a tool call with its name and nothing of its arguments`: the line has `nbgCause: null`, and the pinned key list gains `'nbgCause'` and nothing else.
- Each `nbgError` test also expects `nbgCause`: the `UNAVAILABLE` cases `'HTTP 503 after retry'`, the `SHAPE_CHANGED` case the cause given to that fixture in Task 1, and the user-mistake test `null` for every line.
- The test where one request meets two failures expects the `nbgCause` of the failure its `nbgError` names.

`src/shell/sync.test.ts`:
- `fails with the NBG failure kind when NBG fails, leaving fresh-until`: `syncCause: 'HTTP 503 after retry'`.
- `fails a bootstrap whose first table fails, with no span`: its `failWith` fixture gets `cause` `NBG_CAUSE.shapeJson`, and the line `syncCause: 'shape json'`.
- The store failure test (`syncDetail` `'store_failed'`) and the `empty_export` test: `syncCause: null`.
- Every test that compares a whole line with `toEqual` gains `syncCause` (null unless it fails on NBG).

`test/e2e/http.test.ts`, `logs an NBG outage on the request's line`: `nbgCause: 'HTTP 503 after retry'` (the 503 responder, retried once).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/shell/http.test.ts src/shell/sync.test.ts`
Expected: FAIL on the new fields.

- [ ] **Step 3: Implement the fields and the docs**

- `http.ts`: `nbgCause: scope.failure?.cause ?? null`, after `nbgError`, with a doc comment on the interface field.
- `sync.ts`: `RunOutcome` gains `cause: NbgCause | null`; `failed` takes the `SyncFailure` instead of its kind and sets `cause` for the two NBG kinds (narrowed on `kind`), null otherwise; the step failure in `runKind` uses it too; `skipped` and the ok outcomes have null. `finish` writes `syncCause` after `syncDetail`.
- `CHANGELOG.md`, in `## 0.7.0`, after its `Added:` paragraph, this paragraph verbatim:

  ```markdown
  Changed: a hosted request's log line names the cause of the NBG failure it met (`nbgCause`, for example `HTTP 503 after retry` or `network UND_ERR_SOCKET after retry`, else null), and a sync run's line names the cause of the NBG failure that failed it (`syncCause`). A cause is built from a fixed vocabulary and carries nothing from the request, its URL or the body of NBG's response: of the response it names only the status and the media type, never a date, a currency or an amount a user asked for.
  ```
- Specs: the hosted-endpoint spec's `RequestLogLine` block gains the `nbgCause` line after `nbgError`; the alarm spec's "The log line" section gains one bullet naming `nbgCause` and pointing to the 2026-10-19 design; the mirror spec's log line bullet ("Writes one log line per run") names `syncCause` beside the failure kind.

- [ ] **Step 4: Run the gates**

Run the Global Constraints' gates, all three lines.
Expected: PASS; `grep -cP '[\x{2013}\x{2014}]' CHANGELOG.md docs/superpowers/specs/2026-10-19-nbg-failure-cause-design.md` prints 0 for each.

- [ ] **Step 5: Commit**

Stage the changed paths only and commit them path-limited with the title `Log the NBG failure cause on the request and sync lines`.
