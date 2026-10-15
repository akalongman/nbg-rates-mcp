# NBG Failure Logging and Release 0.6.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every hosted `/mcp` log line says which NBG failure, if any, the request met, so the alarm of the infrastructure plan can mail the owner once per outage; the privacy text says so; the change ships as 0.6.2.

**Architecture:** `createHttpHandler` wraps the rates service in a reporter that notices final results of kind `upstream_unavailable` or `upstream_shape_changed`, and runs each `/mcp` exchange (the SDK call and the body read) inside its own `AsyncLocalStorage` context, so a failure lands on the log line of the request that met it, also when `--http` serves requests concurrently. The log line gains `nbgError`; `outcome` keeps its meaning.

**Tech Stack:** TypeScript on Node 22 and 24, `@modelcontextprotocol/server` 2.3.1, Vitest, `node:async_hooks`.

**Spec:** `docs/superpowers/specs/2026-10-15-nbg-failure-alarm-design.md` (approved 2026-10-15). The infrastructure half is `~/projects/personal/iac/docs/superpowers/plans/2026-10-15-nbg-rates-mcp-nbg-failure-alarm.md`, which runs after 0.6.2 is live.

## Global Constraints

- Counted kinds, verbatim: `upstream_unavailable` and `upstream_shape_changed`. Every other `RatesError` kind leaves `nbgError` null.
- `RequestLogLine.nbgError` is `'upstream_unavailable' | 'upstream_shape_changed' | null`; a request that meets both records the first it met. `outcome` is unchanged.
- The log line never carries an amount, date, currency or message text; the existing test that pins its keys gains `nbgError` and nothing else.
- Privacy phrase, verbatim in English: `which tool was called from which client and whether NBG answered`. Georgian clause added after `გამოიძახეს`: ` და უპასუხა თუ არა ეროვნულმა ბანკმა` (the owner confirms it before the tag).
- Gates: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`; for the release, `bash scripts/build-bundle.sh && npx tsx scripts/check-release.ts 0.6.2`.
- No em or en dashes anywhere (code, comments, docs, commit messages). Repository prose is agent-neutral.
- Commits on `main`, path-limited (`git add <paths> && git commit -m "<title>" -- <paths>`), signed as configured, titles under 72 characters, no attribution trailers. Never push or tag.

## Review Focus

1. The SDK may run a tool while its response body is being read, after `mcpFetch` has resolved: a context that covers only the `mcpFetch` call loses the failure. Task 1 runs the body read inside the same context, and its tests go through the handler, which reads the body.
2. Two concurrent requests on `--http`, one failing: a shared "last failure" marks the wrong line. Task 1's concurrency test forces the overlap with a gate rather than timing.
3. `nbg_convert_many` during an outage answers success with per-item errors: a check on `isError` would miss it. Task 1 tests it.
4. The `nbg://rates/{date}` resource reports an NBG failure as a JSON-RPC error: Task 1 tests that the line has `outcome: "error"` and the kind.
5. A first attempt that fails and a retry that succeeds is no outage: Task 1 drives the real client and service with a fetch that fails once and finds `nbgError` null.

---

### Task 1: Record the NBG failure on the request's log line

**Files:**
- Create: `src/shell/nbg-failure.ts`, `src/shell/nbg-failure.test.ts`
- Modify: `src/shell/http.ts` (`RequestLogLine`, `createHttpHandler`, `defaultMcpFetch`)
- Test: `src/shell/http.test.ts`, `test/e2e/http.test.ts`

**Interfaces:**
- Consumes: `RatesService` (`src/shell/rates-service.ts`), `RatesError` (`src/core/types.ts`).
- Produces:
  - `export type NbgFailureKind = Extract<RatesError['kind'], 'upstream_unavailable' | 'upstream_shape_changed'>;`
  - `export function nbgFailureKind(error: RatesError): NbgFailureKind | undefined` (pure)
  - `export function reportingNbgFailures(service: RatesService, report: (kind: NbgFailureKind) => void): RatesService` (calls `report` once per method call whose final result is an error of a counted kind, then returns the result unchanged)
  - `RequestLogLine.nbgError: NbgFailureKind | null`
  - `createHttpHandler(deps: HttpDeps, mcpFetch?: (request: Request) => Promise<Response>)`: the second parameter becomes optional and is resolved inside the function, because the default SDK fetch must be built over the reporting service.

- [ ] **Step 1: Write the failing unit tests for the classifier and the reporter**

`src/shell/nbg-failure.test.ts`:
- `nbgFailureKind` returns the kind for `{ kind: 'upstream_unavailable', detail: 'x' }` and `{ kind: 'upstream_shape_changed', detail: 'x' }`, and `undefined` for `rate_not_published`, `unknown_currency`, `invalid_date`, `no_data_for_date`, `range_too_long`, `result_out_of_range` and `invalid_currency_code` (build each with the fields `src/core/types.ts` requires).
- `reportingNbgFailures` over a fake service: `getSnapshot` returning `err({ kind: 'upstream_unavailable', ... })` reports `['upstream_unavailable']` and returns the same result object; `getHistory` returning `err({ kind: 'upstream_shape_changed', ... })` reports `['upstream_shape_changed']`; an `ok(...)` result and a `rate_not_published` error report nothing.

- [ ] **Step 2: Write the failing handler tests**

In `src/shell/http.test.ts`, with `handlerWith({ service: <fake> })` and no `mcpFetch` (the real SDK path):
- `logs the NBG failure a tool call met`: `it.each` over `nbg_convert` (`{ amount: 10, from: 'USD', to: 'GEL', date: '2026-10-07' }`), `nbg_get_rates` (`{ date: '2026-10-07', currencies: ['USD'] }`) and `nbg_list_currencies` (`{}`) against a service whose `getSnapshot` returns `upstream_unavailable`: the line has `tool` set, `outcome: 'ok'`, `nbgError: 'upstream_unavailable'`.
- `logs a history that NBG answered in a changed shape`: `nbg_rate_history` (`{ currency: 'USD', from: '2026-10-01', to: '2026-10-07' }`) with `getHistory` returning `upstream_shape_changed`: `nbgError: 'upstream_shape_changed'`.
- `logs an outage that nbg_convert_many reports item by item`: two items on different dates, `getSnapshot` returning `upstream_unavailable`: the response is a success (no `isError`), the line has `outcome: 'ok'`, `nbgError: 'upstream_unavailable'`.
- `logs an NBG failure behind the rates resource`: `resources/read` of `nbg://rates/2026-10-07` with `getSnapshot` returning `upstream_unavailable`: the line has `method: 'resources/read'`, `outcome: 'error'`, `nbgError: 'upstream_unavailable'`.
- `leaves nbgError null for the user's own mistakes`: `getSnapshot` returning `rate_not_published` (for `nbg_convert`), `nbg_convert` from `XYZ` against `ok(SNAPSHOT)` (an `unknown_currency` answer), and the existing `{ from: 'dollar' }` call that never reaches the service: all three lines `nbgError: null`.
- `marks only the request whose lookup failed when two run at once`: a fake service whose `getSnapshot` for `2026-10-06` first waits on a promise that the call for `2026-10-07` resolves when it starts, then returns `upstream_unavailable`, while `2026-10-07` returns `ok(SNAPSHOT)`; fire `nbg_convert` on `2026-10-06` and `nbg_get_rates` on `2026-10-07` with `Promise.all`: the `nbg_convert` line has `nbgError: 'upstream_unavailable'`, the `nbg_get_rates` line `null`.
- `does not count a lookup whose retry succeeded`: the real `createRatesService` over `createSnapshotCache` and `createNbgClient({ baseUrl: 'https://nbg.example', userAgent: 'test', retryDelayMs: 0, fetchImpl })`, where `fetchImpl` throws `new TypeError('fetch failed')` on its first call and then answers 200 `application/json` with the body of `fixturePath('en-2026-10-07')`; `nbg_convert` on `2026-10-07` succeeds and the line has `nbgError: null`, and `fetchImpl` was called twice.
- Update `logs a tool call with its name and nothing of its arguments`: the key list gains `'nbgError'`, and `lines[0]` has `nbgError: null`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/shell/nbg-failure.test.ts src/shell/http.test.ts`
Expected: FAIL (`nbg-failure.ts` missing; `nbgError` undefined on every line).

- [ ] **Step 4: Implement `src/shell/nbg-failure.ts` and wire it into `src/shell/http.ts`**

In `createHttpHandler`: one `AsyncLocalStorage<{ kind: NbgFailureKind | null }>` per handler; the reporter writes the store's `kind` only while it is null; `mcpFetch ?? defaultMcpFetch({ ...deps, service: reportingNbgFailures(deps.service, <reporter>) })`; for each `/mcp` request, `run` a fresh `{ kind: null }` around both `mcpFetch(forwarded)` and `response.text()`, and put its `kind` on the line as `nbgError` (the 500 path included). Update the module's top comment and the `RequestLogLine` field comment.

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx vitest run --project unit src/shell/nbg-failure.test.ts src/shell/http.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the end-to-end case**

In `test/e2e/http.test.ts`, `logs an NBG outage on the request's line`: `fixture.setResponder` answers the JSON route (`/gw/api/ct/monetarypolicy/currencies/en/json`) with status 503 for a date the warm cache has not seen (`2026-09-30`); `client.callTool` `nbg_convert` on that date returns `isError: true`; the stdout line for that call parses to `nbgError: 'upstream_unavailable'`; reset the responder to `undefined` afterwards (in a `finally`). The client's retry waits its default 500 ms.

Run: `npm run test:e2e`
Expected: PASS, 25 tests.

- [ ] **Step 7: Run all gates and commit**

Run the gates of Global Constraints. Expected: all pass.

```bash
git add src/shell/nbg-failure.ts src/shell/nbg-failure.test.ts src/shell/http.ts src/shell/http.test.ts test/e2e/http.test.ts
git commit -m "Log the NBG failure each hosted request met" -- src/shell/nbg-failure.ts src/shell/nbg-failure.test.ts src/shell/http.ts src/shell/http.test.ts test/e2e/http.test.ts
```

---

### Task 2: Say it in the privacy text and the hosted spec

**Files:**
- Modify: `src/shell/site/copy-en.ts:102`, `src/shell/site/copy-ka.ts:119`, `README.md:42`, `docs/directory-listings.md:96`, `docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md` (the `RequestLogLine` block near line 153, the privacy sentence near line 581, the tool-failure passage near line 618)
- Test: `src/shell/site/page.test.ts`

**Interfaces:**
- Consumes: Task 1's `nbgError` (named in the spec text only).
- Produces: nothing code depends on.

- [ ] **Step 1: Write the failing test**

In `src/shell/site/page.test.ts`, beside `USAGE_SENTENCE`, a constant `FIRST_LOG = 'which tool was called from which client and whether NBG answered'` and the test `describes the first log in the same words on the page, in the README and in the directory listings`: `COPY_EN.privacy.join(' ')`, `README.md` and `docs/directory-listings.md` each contain `FIRST_LOG`. In the Georgian describe block, `says the first log records whether NBG answered`: `COPY_KA.privacy.join(' ')` contains `და უპასუხა თუ არა ეროვნულმა ბანკმა`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/shell/site/page.test.ts`
Expected: FAIL on both new tests.

- [ ] **Step 3: Change the four texts**

Insert ` and whether NBG answered` after `which tool was called from which client` in `copy-en.ts`, `README.md` and `docs/directory-listings.md` (rewrap the Markdown paragraph if its lines pass 72 characters), and the Georgian clause of Global Constraints after `გამოიძახეს` in `copy-ka.ts`, before the comma that follows it.

- [ ] **Step 4: Amend the hosted spec**

`RequestLogLine` gains the `nbgError` line with the comment of Task 1; the privacy sentence near line 581 gains the same phrase; the passage near line 618 keeps that a tool failure is `outcome` `ok`, and adds that an NBG failure behind it is named in `nbgError`, recorded where the rates service settles the lookup, with a pointer to `2026-10-15-nbg-failure-alarm-design.md`.

- [ ] **Step 5: Run the gates and commit**

Run: the gates of Global Constraints, then `grep -cP '[\x{2013}\x{2014}]' src/shell/site/copy-en.ts src/shell/site/copy-ka.ts README.md docs/directory-listings.md docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md`
Expected: all pass; every count `0`.

```bash
git add src/shell/site/copy-en.ts src/shell/site/copy-ka.ts src/shell/site/page.test.ts README.md docs/directory-listings.md docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md
git commit -m "Say in the privacy text that the log records NBG failures" -- src/shell/site/copy-en.ts src/shell/site/copy-ka.ts src/shell/site/page.test.ts README.md docs/directory-listings.md docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md
```

---

### Task 3: Release 0.6.2

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `package-lock.json` (the two root `version` fields), `manifest.json`, `server.json` (both `version` fields)

**Interfaces:**
- Consumes: Tasks 1 and 2 committed.
- Produces: the commit the owner tags `v0.6.2`.

- [ ] **Step 1: Write the CHANGELOG entry**

Above `## 0.6.1`, with the commit's date:

```markdown
## 0.6.2 - <YYYY-MM-DD>

Changed: each hosted request's log line names the NBG failure it met (`nbgError`: `upstream_unavailable` or `upstream_shape_changed`, else null), counted for every tool, for each item of `nbg_convert_many` and for the `nbg://rates/{date}` resource, so an outage can raise an alarm; the privacy section says that the log records whether NBG answered.

Release process: the deploy smoke test asks `GET /` until it names the new version three times in a row, for up to 60 seconds, before its checks, because for a moment after the alias moves the public URL can still reach the previous version.
```

- [ ] **Step 2: Bump the version to 0.6.2**

In the five places listed under Files. Run: `grep -n '"version"' package.json manifest.json server.json && sed -n '1,12p' package-lock.json | grep -n version`
Expected: every listed field reads `0.6.2`.

- [ ] **Step 3: Run the gates and the release checks**

Run: the gates, then `bash scripts/build-bundle.sh && npx tsx scripts/check-release.ts 0.6.2`, then `grep -cP '[\x{2013}\x{2014}]' CHANGELOG.md`
Expected: all pass; `check-release` reports no problem; count `0`.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md package.json package-lock.json manifest.json server.json
git commit -m "Release 0.6.2" -- CHANGELOG.md package.json package-lock.json manifest.json server.json
```

---

## After the run (the driver, with the owner's go-ahead)

1. The owner confirms the Georgian clause.
2. Push `main`, and watch CI on the pushed commit to its end.
3. Right before the tag, a hosted conversion must succeed: `node scripts/smoke-http.ts https://nbg-rates.env.ge/mcp 0.6.1` passes. If NBG is failing, wait; a deploy during an outage rolls back while npm, GitHub and the registry already carry 0.6.2.
4. Tag `v0.6.2` (signed, annotated, message `v0.6.2`), push the tag, and watch the release run to its end.
5. Check: the live footer and `initialize` report 0.6.2, and the function log has a line with `"nbgError":null` (`aws logs filter-log-events --log-group-name /aws/lambda/nbg-rates-mcp --start-time <ms since tag> --filter-pattern '"nbgError"' --limit 1`).
6. Then the infrastructure plan.
