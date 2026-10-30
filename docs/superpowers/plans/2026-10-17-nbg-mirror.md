# Hosted NBG Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hosted endpoint answers from a DynamoDB mirror of NBG's data: a scheduled sync keeps the recent publications and the whole archive's CSV rows equal to NBG, and the first request for a past date writes that date's checked day table. NBG load stops growing with users, an NBG outage stops reaching them for anything the mirror holds, and local installs do not change. The code ships inert as 0.7.0 and is switched on in `personal/iac`.

**Architecture:** Pure rules live in `src/core`: the schedule and freshness times, the mirror's state record and coverage, publication agreement and row comparison, and the history plan both paths share. In `src/shell`: a `MirrorStore` interface with a DynamoDB implementation; a mirror-first `RatesService` that wraps today's service, applies the spec's answering rules and writes past tables (rule 7), carrying per-request state in the `AsyncLocalStorage` scope `http.ts` already runs; and a sync runner (hourly check, publication window, daily refetch, weekly re-check, archive rows' fill) as a second way into the Lambda handler. Tests drive both paths over one in-process fake NBG and an in-memory store, and a contract suite holds the DynamoDB store to the in-memory one against DynamoDB Local.

**Tech Stack:** TypeScript on Node 22 and 24, zod 4, Vitest, `@aws-sdk/client-dynamodb` v3 (provided by the Lambda `nodejs24.x` runtime, a devDependency here), DynamoDB Local in Docker, Terraform in `personal/iac`.

**Spec:** `docs/superpowers/specs/2026-10-16-nbg-mirror-design.md` (approved 2026-10-17, amended the same day: past tables on request, archive rows once, the privacy sentence). Section names and rule numbers below ("Committing a publication", rule 7) are the spec's. Part A is this repository and runs through subagents; Part B is the release and the infrastructure, run in session with the owner.

## Global Constraints

- The variable is `NBG_RATES_MIRROR_TABLE`. Unset or empty (after trimming), the function behaves exactly as today. `src/bin.ts` never reads it.
- Two schedules, both `Asia/Tbilisi`: hourly at minute 0, and the publication window every minute from 17:00 to 17:30 on Monday to Friday. There is no backfill schedule.
- Fresh-until is the next due check plus 2 minutes when that check is a window minute and 5 minutes otherwise. Only a successful hourly or window check moves it, and only forward.
- The window stops for its Tbilisi date once tomorrow's publication is committed and 10 successful runs since have seen no change; a failed or skipped run neither counts nor resets the count.
- The late-publication window is the last 7 days (`LATE_PUBLICATION_DAYS`) plus tomorrow. The history interval is the range's start minus 31 days (`HISTORY_LOOKBACK_DAYS`) to its end, for the currency and `USD`.
- Values within the spec's limits: database read bound 2,000 ms per request; short attempt one try of 3,000 ms; past-table write bound 1,000 ms; sync NBG requests 5,000 ms per try with the client's one retry, 500 ms apart; store operations 2,000 ms each; at most 2 archive years per hourly run.
- After one live NBG failure in a request, that request asks NBG nothing more. After one failed or timed-out past-table write, it writes nothing more.
- A request writes only rule 7's past tables, through `MirrorRequestStore.fillPastTable`, the one write method user requests can reach. A past-table item holds the table alone: no time, client, currency or request detail.
- A sync event older than 60 seconds does nothing. Scheduler and Lambda asynchronous invocation both get no retries and a maximum event age of 60 seconds.
- The one accepted difference from the live path is NBG's AZN filter gap (2006-01-01 to 2007-12-31). Every other answer, error kind included, is equal.
- The npm package and the MCPB bundle gain no runtime dependency. The Lambda imports `@aws-sdk/client-dynamodb` from the runtime (3.1105.0 in `public.ecr.aws/lambda/nodejs:24`, probed 2026-10-17 through the runtime's own bootstrap: both `import()` and `require` resolve it), and only when the variable is set.
- Sync log lines use `syncRun`, `syncResult`, `syncDetail` and `checked`, never `nbgError`. The request log line is unchanged and never says a request wrote a past table.
- The privacy sentence, in English, verbatim: "The connector needs no account and never records the amounts or currencies you ask about. For a past date it keeps a copy of NBG's table the first time anyone asks; the copy does not say who asked or when." The Georgian, confirmed by the owner on 2026-10-17, is in Task 16.
- No tool's input, output, description or error text changes. The NBG user agent is unchanged.
- Gates: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`, plus `npm run test:dynamodb` from Task 8 on.
- No em or en dashes anywhere (code, comments, docs, commit messages). Repository prose is agent-neutral.
- Commits on `main`, path-limited (`git add <paths> && git commit -m "<title>" -- <paths>`), signed as configured, titles under 72 characters, no attribution trailers. Never push or tag.

## Decisions this plan makes

The spec leaves these to the builder. Each is used as stated below; the owner may overturn any by number.

1. Item layout: one state item (`pk` `state`, `sk` `state`, the record as JSON with a `revision` number); per publication a rows item (`pk` `rows`, `sk` the valid-from date, the CSV rows as JSON, an `observedAt`); and per publication and language a table item (`pk` `table#en` or `table#ka`, same `sk`, the table as JSON). The sync's table items carry `observedAt`; a past table carries nothing but `pk`, `sk` and the table. A span publication is one `TransactWriteItems` of its rows item and both table items.
2. The state record is written by compare-and-set on `revision`, and every change to it is a pure forward-only function in `src/core/mirror.ts`, so overlapping runs merge instead of overwriting.
3. Readers read the state first, then the rows item in force on the date (the latest on or before it), then the table item; for a history, the state and then the rows. All are strongly consistent, inside one 2-second bound. The rows item gives the publication in force inside the span and before it alike, so one read path serves both.
4. Rule 4 reads as "after a live NBG failure the request asks NBG nothing more". A short attempt that succeeds does not spend the budget, so a request can make several short attempts while NBG answers, and at most one on a hanging NBG, which is the case the spec bounds. `nbg_convert_many` keeps its own stop after `upstream_unavailable` but now asks the service with `withoutNbg` instead of skipping it, so later dates can still come from a stale mirror.
5. An unresolved date keeps its last committed version and stays covered.
6. The window run asks only tomorrow's English table each minute, as the spec says, and compares values with `sameTable` (rates, quantities, diffs, names, order), not the write stamps, so a second write that changes no value counts as quiet.
7. The daily refetch is the first hourly run at or after 03:00 Tbilisi time and resumes from a cursor when its deadline cuts it short. The weekly re-check takes one calendar year per slice, at most one slice every 5 hours, and a new cycle every 7 days: about 32 slices a week, about 5 a day.
8. The archive rows' fill runs in hourly runs after their check, newest year first, at most 2 years per run: 12 English tables (the first day of each month in range) for the codes and 1 CSV for the year, about 13 requests a year and about 400 in all, ending within about a day.
9. A catch-up after an interruption verifies from the span's end minus 7 days to tomorrow in CSV chunks of at most 31 days.
10. Deadline: an NBG request starts only if the remaining time covers its worst case (10,500 ms) plus 4,500 ms for a commit and 500 ms for the log line; a commit starts only if 5,000 ms remain.
11. One scheduler execution role serves both schedules; their permissions are identical.
12. The DynamoDB contract suite runs against DynamoDB Local in a new Vitest project, `dynamodb`, in CI and in the release build.
13. The table has deletion protection on and point-in-time recovery off (the spec: recovery points would keep when each past table was written).
14. `nbg_convert_many`'s description keeps "the remaining dates fail with the same error without being asked". On the hosted endpoint some may now succeed from the mirror. The spec's non-goal forbids rewording, and the sentence stays true about NBG not being asked.
15. The table a live lookup fetched reaches rule 7 through a per-call `onFetched` callback on `getSnapshot`, called only when that call fetched from NBG; a cache hit never calls it, so it never writes.
16. When the weekly re-check finds a past publication's rows changed, one transaction rewrites (or removes) its rows item and deletes both its past tables.

## Review Focus

1. A catch-up commits and extends the span between a reader's reads: data read before a newer state would answer an old table for a newly covered date. Task 9 pins the order with a store hook that commits between the reads.
2. A request writes a table under the wrong publication: NBG answers a past date with a table valid from another day than the rows' publication in force, and the stored copy then answers every date that publication covers. Task 9 tests that such a table is not written.
3. A request served an in-memory cache entry older than the mirror's copy while the mirror is stale. Task 9 has the cache-rule test with a mirror rate that differs from the cached one.
4. Two runs at once: the 17:00 hourly and window runs, a duplicate delivery, or a slow 16:00 run finishing after the 17:01 one. Tasks 10 and 11 interleave them with a gate in the fake NBG.
5. NBG's JSON answers a date it has no table for with the latest table: stored as the asked date it would be a wrong publication. Tasks 10 and 11 ask for tomorrow before publication and expect nothing committed.

## File map

- `src/core/sync-schedule.ts`: run kinds, Tbilisi clock, window minutes, next check and fresh-until.
- `src/core/mirror.ts`: `MirrorState`, its parser, forward-only transitions, coverage and freshness.
- `src/core/mirror-publication.ts`: `MirrorPublication`, agreement of the sources, row comparison, AZN gap codes, export emulation over stored rows.
- `src/core/history.ts`, `src/core/normalize.ts`: `planHistory`, `compareCsvRows`, `snapshotFromDay`.
- `src/shell/mirror-store.ts`: `MirrorReader`, `MirrorRequestStore`, `MirrorStore` and their record types.
- `src/shell/mirror-dynamodb.ts`: the DynamoDB store.
- `src/shell/lookup-scope.ts`: the per-request scope.
- `src/shell/mirrored-rates-service.ts`: answering rules 1 to 7.
- `src/shell/sync-publication.ts`, `src/shell/sync-check.ts`, `src/shell/sync-archive.ts`, `src/shell/sync.ts`: the sync.
- `test/helpers/publications.ts`, `test/helpers/fake-nbg.ts`, `test/helpers/memory-mirror-store.ts`, `test/helpers/mirror-store-contract.ts`, `test/helpers/mcp-http.ts`, `test/dynamodb/mirror-dynamodb.test.ts`.

---

## Part A: this repository

### Task 1: Schedule and freshness times

**Files:**
- Create: `src/core/sync-schedule.ts`, `src/core/sync-schedule.test.ts`

**Interfaces:**
- Consumes: `TBILISI_TIME_ZONE`, `CalendarDate` (`src/core/dates.ts`, `src/core/types.ts`).
- Produces:

```ts
export type SyncKind = 'hourly' | 'window';
export const WINDOW_FIRST_MINUTE = 1020; // 17:00
export const WINDOW_LAST_MINUTE = 1050; // 17:30
export const QUIET_RUNS_TO_STOP = 10;
export const WINDOW_MARGIN_MS = 120_000;
export const HOURLY_MARGIN_MS = 300_000;
export const MAX_EVENT_AGE_MS = 60_000;
export const DAILY_REFETCH_FROM_HOUR = 3;
export const RECHECK_CYCLE_DAYS = 7;
export const RECHECK_SLICE_EVERY_HOURS = 5;
export const ARCHIVE_YEARS_PER_RUN = 2;
export interface TbilisiClock {
    readonly date: CalendarDate;
    /** 1 is Monday, 7 is Sunday. */
    readonly weekday: number;
    readonly minuteOfDay: number;
}
export function tbilisiClock(at: Date): TbilisiClock;
export function isWindowMinute(at: Date): boolean;
/** The first hourly or window run due after `after`, skipping the window on its stopped date. */
export function nextCheckDue(after: Date, windowStoppedOn: CalendarDate | undefined): Date;
export function freshUntilAfter(checkScheduledAt: Date, windowStoppedOn: CalendarDate | undefined): Date;
```

- [ ] **Step 1: Write the failing tests**

- `tbilisiClock(new Date('2026-10-16T13:00:00Z'))` is `{ date: '2026-10-16', weekday: 5, minuteOfDay: 1020 }`; `2026-10-17T20:30:00Z` is `{ date: '2026-10-18', weekday: 7, minuteOfDay: 30 }`.
- `isWindowMinute`: Friday 2026-10-16 at 17:00 and 17:30 Tbilisi true; 16:59 and 17:31 false; Saturday 2026-10-17 17:05 false.
- `freshUntilAfter` (Tbilisi wall clock; the test writes UTC instants, four hours earlier):

| Check scheduled at | Window stopped on | Fresh until |
| --- | --- | --- |
| Fri 2026-10-16 16:00 | none | 17:02 |
| Fri 2026-10-16 17:00 | none | 17:03 |
| Fri 2026-10-16 17:12 | 2026-10-16 | 18:05 |
| Fri 2026-10-16 17:30 | none | 18:05 |
| Fri 2026-10-16 23:00 | none | Sat 00:05 |
| Sat 2026-10-17 16:00 | none | 17:05 |
| Mon 2026-10-19 10:00 | none | 11:05 |
| Wed 2026-10-14 16:00 (a holiday) | none | 17:02 |
| Fri 2026-10-16 16:00 | 2026-10-15 | 17:02 |

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/core/sync-schedule.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement `src/core/sync-schedule.ts`**

Clock fields come from `Intl.DateTimeFormat(...).formatToParts` in `TBILISI_TIME_ZONE`, as `todayIn` does. `nextCheckDue` takes the earlier of the next whole hour and the next window minute on a weekday whose Tbilisi date is not `windowStoppedOn`; the schedule knows no holidays.

- [ ] **Step 4: Run the tests and lint**

Run: `npx vitest run --project unit src/core/sync-schedule.test.ts && npm run lint`
Expected: PASS; lint clean (core purity rules).

- [ ] **Step 5: Commit**

```bash
git add src/core/sync-schedule.ts src/core/sync-schedule.test.ts
git commit -m "Add the mirror sync schedule and freshness times" -- src/core/sync-schedule.ts src/core/sync-schedule.test.ts
```

### Task 2: The mirror's state record

**Files:**
- Create: `src/core/mirror.ts`, `src/core/mirror.test.ts`

**Interfaces:**
- Consumes: `SyncKind` (Task 1), `NBG_ARCHIVE_START`, `Result`.
- Produces:

```ts
export interface MirrorSpan { readonly start: CalendarDate; readonly end: CalendarDate }
export interface WindowState {
    readonly date: CalendarDate;
    readonly committed: boolean;
    readonly quietRuns: number;
    readonly stopped: boolean;
    /** Scheduled time of the run that wrote it, epoch ms. */
    readonly at: number;
}
export interface MirrorState {
    readonly revision: number;
    /** The recent publications; its start never moves once set. */
    readonly span?: MirrorSpan;
    /** The first date from which every publication's rows are stored, through to the span. */
    readonly rowsStart?: CalendarDate;
    readonly freshUntil?: number;
    readonly window?: WindowState;
    readonly unresolved: ReadonlyArray<CalendarDate>;
    readonly lastRun: Readonly<Partial<Record<SyncKind, number>>>;
    readonly refetch: { readonly day?: CalendarDate; readonly cursor?: CalendarDate };
    readonly recheck: { readonly cycleStartedAt?: number; readonly lastSliceAt?: number; readonly nextYear?: number };
}
export const EMPTY_MIRROR_STATE: MirrorState;
export function parseMirrorState(json: unknown): Result<MirrorState, string>;
// Forward-only transitions: each returns its input object unchanged when it would move a field back.
export function claimRun(state: MirrorState, kind: SyncKind, scheduledAt: number): MirrorState | undefined;
export function startSpan(state: MirrorState, span: MirrorSpan): MirrorState;
export function extendSpanEnd(state: MirrorState, end: CalendarDate): MirrorState;
export function extendRowsStart(state: MirrorState, start: CalendarDate): MirrorState;
export function recordFreshUntil(state: MirrorState, freshUntil: number): MirrorState;
export function recordWindow(state: MirrorState, window: WindowState): MirrorState;
export function markUnresolved(state: MirrorState, dates: ReadonlyArray<CalendarDate>): MirrorState;
export function markResolved(state: MirrorState, dates: ReadonlyArray<CalendarDate>): MirrorState;
export function isFresh(state: MirrorState, now: Date): boolean;
/** Inside the span: both tables and the rows are stored. */
export function inSpan(state: MirrorState, date: CalendarDate): boolean;
/** Between the rows' start and the span: covered when the past table is stored. */
export function isPastDate(state: MirrorState, date: CalendarDate): boolean;
export function coversInterval(state: MirrorState, start: CalendarDate, end: CalendarDate): boolean;
```

`refetch` and `recheck` are written by single hourly runs (Task 12 replaces them with object spread), so they need no transition. The store bumps `revision`; transitions never touch it.

- [ ] **Step 1: Write the failing tests**

- `claimRun` with `lastRun.hourly` 1000: 1000 and 999 give `undefined`; 1001 gives a state with `lastRun.hourly` 1001; `lastRun.window` is untouched.
- `startSpan` sets a span only when none exists; on a state with one it returns the input.
- `extendSpanEnd` from end `2026-10-09`: to `2026-10-12` extends, to `2026-10-08` returns the input object (`toBe`). `extendRowsStart` from `2026-01-01`: `2025-01-01` moves it, `2026-02-01` returns the input; on a state without `rowsStart` it sets it.
- `recordFreshUntil` moves only forward. `recordWindow` replaces a window of an earlier date, or of the same date with a smaller `at`, and ignores anything older.
- `markUnresolved` and `markResolved` keep a sorted set: marking `2026-10-08` twice holds it once.
- `isFresh` with fresh-until 17:02:00: 17:01:59.999 fresh, 17:02:00 stale; no fresh-until is stale.
- On span `2026-10-01..2026-10-09` with `rowsStart` `2025-01-01`: `inSpan` is true for both ends, false for `2026-09-30` and `2026-10-10`, and true for an unresolved `2026-10-05`; `isPastDate` is true for `2025-01-01` and `2026-09-30`, false for `2024-12-31` and `2026-10-01`; with no span both are false.
- `coversInterval` on that state: `2025-01-01..2026-10-09` true, starting `2024-12-31` false, ending `2026-10-10` false; without `rowsStart`, from the span's start; with `rowsStart` `1995-10-14`, `1995-09-13..1995-10-20` true.
- `parseMirrorState` round-trips a state with every field set through `JSON.stringify` and `JSON.parse`; `{ revision: 'x' }` is an error.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/core/mirror.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement `src/core/mirror.ts`**

`parseMirrorState` is a zod schema (dates through `parseCalendarDate`). `coversInterval`: a span exists, `end <= span.end`, and with `first = rowsStart ?? span.start`, `start >= first` or `first === NBG_ARCHIVE_START`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit src/core/mirror.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/mirror.ts src/core/mirror.test.ts
git commit -m "Add the mirror's state record and its forward-only rules" -- src/core/mirror.ts src/core/mirror.test.ts
```

### Task 3: Agreement and comparison of publications

**Files:**
- Create: `src/core/mirror-publication.ts`, `src/core/mirror-publication.test.ts`, `test/helpers/publications.ts`
- Modify: `src/core/history.ts` (export `compareCsvRows`; `assembleHistory` sorts with it)

**Interfaces:**
- Consumes: `NbgDay` (`nbg-schema.ts`), `NbgCsvRow` (`nbg-csv.ts`), `calendarDateFromTimestamp`.
- Produces:

```ts
// src/core/history.ts
/** validFrom, then publishedOn: the order in which assembleHistory applies rows; the later row wins a tie. */
export function compareCsvRows(left: NbgCsvRow, right: NbgCsvRow): number;

// src/core/mirror-publication.ts
export interface MirrorPublication {
    readonly validFrom: CalendarDate;
    readonly en: NbgDay;
    readonly ka: NbgDay;
    /** In the order the export listed them. */
    readonly rows: ReadonlyArray<NbgCsvRow>;
    /** When the oldest of the three fetches began, epoch ms. */
    readonly observedAt: number;
}
export const AZN_GAP_START = '2006-01-01';
export const AZN_GAP_END = '2007-12-31';
export function tableValidFrom(day: NbgDay): CalendarDate;
export function tableCodes(day: NbgDay): ReadonlyArray<CurrencyCode>;
/** The codes to request: AZN is left out when [start, end] reaches into the gap. */
export function csvRequestCodes(codes: ReadonlyArray<string>, start: CalendarDate, end: CalendarDate): ReadonlyArray<CurrencyCode>;
/** One table against its publication's rows: valid-from date, codes (AZN excused inside the gap), and each code's quantity and rate. */
export function checkTableAgainstRows(validFrom: CalendarDate, table: NbgDay, rows: ReadonlyArray<NbgCsvRow>): Result<void, string>;
/** Both tables against the rows, and the two tables against each other. */
export function checkAgreement(validFrom: CalendarDate, en: NbgDay, ka: NbgDay, rows: ReadonlyArray<NbgCsvRow>): Result<void, string>;
/** Equal rows in equal order on code, quantity, rate, diff, name and validFromDate; write stamps are ignored. */
export function sameTable(left: NbgDay, right: NbgDay): boolean;
/** Equal as multisets of code, quantity, rate, publishedOn and validFrom. */
export function sameRows(left: ReadonlyArray<NbgCsvRow>, right: ReadonlyArray<NbgCsvRow>): boolean;
export function groupByValidFrom(rows: ReadonlyArray<NbgCsvRow>): ReadonlyMap<CalendarDate, ReadonlyArray<NbgCsvRow>>;
/** Ascending dates that are new in `fetched`, differ, or are missing from it. */
export function changedPublications(
    fetched: ReadonlyMap<CalendarDate, ReadonlyArray<NbgCsvRow>>,
    stored: ReadonlyMap<CalendarDate, ReadonlyArray<NbgCsvRow>>,
): ReadonlyArray<CalendarDate>;
/** What NBG's export returns for these currencies and dates, from stored rows: newest publication first. */
export function exportRows(
    stored: ReadonlyArray<{ readonly validFrom: CalendarDate; readonly rows: ReadonlyArray<NbgCsvRow> }>,
    currencies: ReadonlyArray<CurrencyCode>,
    start: CalendarDate,
    end: CalendarDate,
): ReadonlyArray<NbgCsvRow>;
export function parseStoredRows(json: unknown): Result<ReadonlyArray<NbgCsvRow>, string>;

// test/helpers/publications.ts
export function tableFixture(language: Language, date: string): NbgDay;
/** The rows the CSV export lists for a table: publishedOn is the date part of each row's write stamp. */
export function rowsFromTable(table: NbgDay): ReadonlyArray<NbgCsvRow>;
/** A Georgian stand-in where none is recorded: the same rows with names prefixed "ka:". */
export function georgianTwin(table: NbgDay): NbgDay;
export function syntheticTable(
    validFrom: string,
    rates: Readonly<Record<string, number>>,
    options?: { readonly quantities?: Readonly<Record<string, number>>; readonly writtenAt?: string },
): NbgDay;
export function publication(
    en: NbgDay,
    options?: { readonly ka?: NbgDay; readonly rows?: ReadonlyArray<NbgCsvRow>; readonly observedAt?: number },
): MirrorPublication;
```

The applied row for one code in one publication is the last of its rows after a stable sort with `compareCsvRows`, so a check compares exactly the row `assembleHistory` applies.

- [ ] **Step 1: Write the failing tests**

- `publication(tableFixture('en', '2026-10-07'), { ka: tableFixture('ka', '2026-10-07') })` agrees, and each table alone passes `checkTableAgainstRows`.
- Each of these is an error naming the cause: the 2026-10-06 table checked as `2026-10-07`; a Georgian table without AMD; rows without AMD; an extra `XYZ` row; a CSV USD rate of 2.6026 against 2.6025; a CSV quantity of 10 for USD; a Georgian USD rate of 2.6026.
- AZN gap: `syntheticTable('2006-06-01', { AZN: 1.9989, USD: 1.8 })` agrees with USD rows only; the same for `2008-01-02` disagrees.
- Duplicate rows: USD for `2026-10-07` listed as (publishedOn `2026-10-06`, 2.6025) and (publishedOn `2026-10-08`, 2.7) agree with a table quoting 2.7 and disagree with one quoting 2.6025.
- `csvRequestCodes(['AZN', 'USD'], ...)`: `2007-12-01..2007-12-31` gives `['USD']`; `2008-01-01..2008-01-31` gives `['AZN', 'USD']`; `2005-12-01..2006-01-05` gives `['USD']`.
- `sameTable`: the same values with other write stamps true; one changed name false; two rows swapped false. `sameRows` ignores order.
- `changedPublications`: fetched `{10-06: A, 10-07: B2}` against stored `{10-06: A, 10-07: B, 10-08: C}` gives `['2026-10-07', '2026-10-08']`; a fetched `10-09` is included.
- `rowsFromTable` over the recorded English tables of the five publications in 2026-10-01 to 2026-10-07 (valid from 10-01, 10-02, 10-03, 10-06 and 10-07; the 10-04 and 10-05 tables repeat 10-03) lists the same USD and AMD rows (`sameRows`) as `parseNbgCsv(csvExport(['AMD', 'USD'], '2026-10-01', '2026-10-07'))`, which checks the helper against NBG's recorded export.
- `exportRows` over those publications for `['AMD', 'USD']`, `2026-10-02..2026-10-06` equals the same recorded export for that range (`sameRows`), and lists publications newest first.
- `parseStoredRows` rejects a row whose code is `usd`.
- The existing `history.test.ts` stays green with `assembleHistory` sorting through `compareCsvRows`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/core/mirror-publication.test.ts src/core/history.test.ts`
Expected: FAIL on the missing module; `history.test.ts` passes.

- [ ] **Step 3: Implement the helper, `compareCsvRows` and `src/core/mirror-publication.ts`**

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit src/core && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/mirror-publication.ts src/core/mirror-publication.test.ts src/core/history.ts test/helpers/publications.ts
git commit -m "Check that NBG's sources agree on a publication" -- src/core/mirror-publication.ts src/core/mirror-publication.test.ts src/core/history.ts test/helpers/publications.ts
```

### Task 4: One history plan and one snapshot rule for both paths

**Files:**
- Modify: `src/core/history.ts`, `src/core/normalize.ts`, `src/shell/rates-service.ts`
- Test: `src/core/history.test.ts`, `src/core/normalize.test.ts`

**Interfaces:**
- Produces:

```ts
// src/core/history.ts
export interface HistoryPlan {
    readonly currency: CurrencyCode;
    readonly days: ReadonlyArray<CalendarDate>;
    /** The currency and the calendar currency USD, once each. */
    readonly currencies: ReadonlyArray<CurrencyCode>;
    readonly start: CalendarDate;
    readonly end: CalendarDate;
}
/** getHistory's checks before any request, in its order: the days, a range ending after tomorrow, a range before the archive. */
export function planHistory(currency: CurrencyCode, from: CalendarDate, to: CalendarDate, today: CalendarDate): Result<HistoryPlan, RatesError>;

// src/core/normalize.ts
export function snapshotFromDay(day: NbgDay, requestedDate: CalendarDate, today: CalendarDate): Result<RatesSnapshot, RatesError>;
```

`createRatesService` keeps its signature and behavior: `getHistory` is `planHistory`, `fetchRange(plan.currencies, plan.start, plan.end)` and `assembleHistory`; `settledSnapshot` calls `snapshotFromDay`.

- [ ] **Step 1: Write the failing tests**

- `planHistory('USD', '2026-10-01', '2026-10-07', '2026-10-08')`: start `2026-08-31`, end `2026-10-07`, currencies `['USD']`, 7 days. For AMD over `2026-10-03..2026-10-05`: currencies `['AMD', 'USD']`, start `2026-09-02`.
- `2024-01-01..2025-01-01` is `range_too_long` 367 of 366; `2026-10-01..2026-10-10` is `rate_not_published`; `1995-10-01..1995-10-13` and `0000-01-15..0000-01-20` are `no_data_for_date` on `from` with currency USD.
- `snapshotFromDay(tableFixture('en', '2026-10-03'), '2026-10-05', '2026-10-08')` is ok with effective date `2026-10-03` and carried over; the 2026-10-07 table for `2026-10-09` is `rate_not_published` with latest `2026-10-07` and today `2026-10-08`; the 2026-10-07 table for `2026-10-06` is `upstream_shape_changed`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/core/history.test.ts src/core/normalize.test.ts`
Expected: FAIL, the functions are not exported.

- [ ] **Step 3: Implement both and route `createRatesService` through them**

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS, `rates-service.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/history.ts src/core/normalize.ts src/shell/rates-service.ts src/core/history.test.ts src/core/normalize.test.ts
git commit -m "Share the history plan and the snapshot rule between paths" -- src/core/history.ts src/core/normalize.ts src/shell/rates-service.ts src/core/history.test.ts src/core/normalize.test.ts
```

### Task 5: What the mirror needs from the client, the cache and the service

**Files:**
- Modify: `src/shell/nbg-client.ts`, `src/shell/cache.ts`, `src/shell/rates-service.ts`, `src/shell/nbg-failure.ts`, `src/shell/server.ts` (`convertMany`)
- Test: `src/shell/nbg-client.test.ts`, `src/shell/cache.test.ts`, `src/shell/rates-service.test.ts`, `src/shell/nbg-failure.test.ts`, `src/shell/server.test.ts`

**Interfaces:**
- Produces:

```ts
// nbg-client.ts: NbgClientOptions gains
readonly retry?: boolean; // default true; false: one attempt, a retryable outcome is upstream_unavailable with its own detail

// cache.ts: SnapshotCache.get gains a parameter; an entry remembers when it was set
get(language: Language, requestedDate: CalendarDate, now: Date, ignoreCachedBefore?: Date): RatesSnapshot | undefined;

// nbg-failure.ts
export type NbgFailure = Extract<RatesError, { readonly kind: NbgFailureKind }>;
export function asNbgFailure(error: RatesError): NbgFailure | undefined;

// rates-service.ts: getSnapshot's args gain
/** Skip an in-memory entry set before this time (the mirror observed the publication later). */
ignoreCachedBefore?: Date;
/** The request already met this NBG failure: return it at once, before any check or request. */
withoutNbg?: NbgFailure;
/** Called with the table this call fetched from NBG, when the answer is ok; never on a cache hit. */
onFetched?: (day: NbgDay) => void;
```

`convertMany` keeps `outage`, now typed `NbgFailure`, but for the dates after it calls `getSnapshot({ date, language: 'en', withoutNbg: outage })` instead of storing `err(outage)` itself.

- [ ] **Step 1: Write the failing tests**

- Client: `retry: false` against a 503 responder makes one request and returns `upstream_unavailable` with detail `HTTP 503`; against a responder delayed 2,000 ms with `timeoutMs: 100` it makes one request and fails within 1 second.
- Cache: an entry set at NOW; `get` with `ignoreCachedBefore` NOW + 1 ms is `undefined`, with NOW it returns the entry, and a later `get` without the option still returns it.
- Service: `withoutNbg` returns that error with no client call, also for `2099-01-01`; `ignoreCachedBefore` later than the cached entry fetches the date again (two `day:en` calls); `onFetched` receives the fetched 2026-10-05 table (valid from 2026-10-03) on the first call and is not called on the second, cached one, nor for a `rate_not_published` answer.
- `asNbgFailure` returns the error for the two failure kinds and `undefined` for `rate_not_published`.
- Server: in "stops asking NBG after one outage", the stub returns `err(args.withoutNbg)` when given one, as a real service does. The test now expects requests for `2026-10-05`, `2026-10-07` and `2026-10-06`, the last with `withoutNbg` equal to the outage, and the same four outputs and total as before.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/shell/nbg-client.test.ts src/shell/cache.test.ts src/shell/rates-service.test.ts src/shell/nbg-failure.test.ts src/shell/server.test.ts`
Expected: FAIL on the new cases only.

- [ ] **Step 3: Implement the options**

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shell/nbg-client.ts src/shell/cache.ts src/shell/rates-service.ts src/shell/nbg-failure.ts src/shell/server.ts src/shell/nbg-client.test.ts src/shell/cache.test.ts src/shell/rates-service.test.ts src/shell/nbg-failure.test.ts src/shell/server.test.ts
git commit -m "Give the service the hooks the mirror needs" -- src/shell/nbg-client.ts src/shell/cache.ts src/shell/rates-service.ts src/shell/nbg-failure.ts src/shell/server.ts src/shell/nbg-client.test.ts src/shell/cache.test.ts src/shell/rates-service.test.ts src/shell/nbg-failure.test.ts src/shell/server.test.ts
```

### Task 6: A lookup scope per hosted request

**Files:**
- Create: `src/shell/lookup-scope.ts`, `src/shell/lookup-scope.test.ts`, `test/helpers/mcp-http.ts` (moved from `http.test.ts`: `post`, `toolCall`, `firstMessage`)
- Modify: `src/shell/http.ts`, `src/shell/nbg-failure.ts` (`reportingNbgFailures` reports the error), `src/shell/http.test.ts`, `src/shell/nbg-failure.test.ts`

**Interfaces:**
- Consumes: `NbgFailure` (Task 5).
- Produces:

```ts
// src/shell/lookup-scope.ts
/** What one hosted request has met so far; mutable by design, one per request. */
export interface LookupScope {
    failure: NbgFailure | null;
    /** Set after a failed or timed-out past-table write: the request writes nothing more. */
    fillStopped: boolean;
}
export interface LookupScopes {
    run<T>(scope: LookupScope, work: () => Promise<T>): Promise<T>;
    current(): LookupScope | undefined;
    /** Records the failure on the current scope unless it holds one; outside a scope it does nothing. */
    record(failure: NbgFailure): void;
}
export function createLookupScopes(): LookupScopes;
export function newLookupScope(): LookupScope;

// nbg-failure.ts
export function reportingNbgFailures(service: RatesService, report: (failure: NbgFailure) => void): RatesService;

// http.ts: HttpDeps gains
/** Shared with a service that records failures itself (the mirror); default: the handler's own. */
readonly lookupScopes?: LookupScopes;
```

`createHttpHandler` runs each `/mcp` exchange in `scopes.run(newLookupScope(), ...)` exactly where `nbgFailures.run` is today, the reporter calls `scopes.record`, and the line's `nbgError` is `scope.failure?.kind ?? null`.

- [ ] **Step 1: Write the failing tests**

- `lookup-scope.test.ts`: `record` inside `run` sets the failure; a second `record` keeps the first; `record` outside any scope does nothing; two overlapping `run` calls each see only their own failure and `fillStopped`.
- `http.test.ts`, new: a service whose `getSnapshot` calls `scopes.record(UNAVAILABLE)` and then returns `ok(SNAPSHOT)`, given the same `lookupScopes` as the handler: `nbg_convert` answers a conversion and the line has `nbgError: 'upstream_unavailable'`. This is the seam rule 5 needs.
- Every existing `createHttpHandler nbgError` test stays green unchanged, the concurrency one included; `nbg-failure.test.ts` compares the reported errors' kinds.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/shell/lookup-scope.test.ts src/shell/http.test.ts src/shell/nbg-failure.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the scope and wire it into `http.ts`**

Update the module comment of `http.ts`: the scope also carries what the mirror needs from the request.

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shell/lookup-scope.ts src/shell/lookup-scope.test.ts src/shell/http.ts src/shell/http.test.ts src/shell/nbg-failure.ts src/shell/nbg-failure.test.ts test/helpers/mcp-http.ts
git commit -m "Carry each hosted request's NBG failure in a lookup scope" -- src/shell/lookup-scope.ts src/shell/lookup-scope.test.ts src/shell/http.ts src/shell/http.test.ts src/shell/nbg-failure.ts src/shell/nbg-failure.test.ts test/helpers/mcp-http.ts
```

### Task 7: The store interface, an in-memory store and a fake NBG

**Files:**
- Create: `src/shell/mirror-store.ts`, `src/shell/mirror-store.test.ts`, `test/helpers/memory-mirror-store.ts`, `test/helpers/mirror-store-contract.ts`, `test/helpers/fake-nbg.ts`, `test/helpers/fake-nbg.test.ts`
- Modify: `vitest.config.ts` (the unit project also includes `test/helpers/**/*.test.ts`)

**Interfaces:**
- Consumes: `MirrorState`, `EMPTY_MIRROR_STATE` (Task 2), `MirrorPublication` (Task 3), `test/helpers/publications.ts`.
- Produces:

```ts
// src/shell/mirror-store.ts
export const STORE_OPERATION_TIMEOUT_MS = 2_000;
export interface StoreError { readonly kind: 'store_failed'; readonly detail: string }
export interface StoredRows { readonly validFrom: CalendarDate; readonly rows: ReadonlyArray<NbgCsvRow>; readonly observedAt: number }
/** observedAt is absent on a past table. */
export interface StoredTable { readonly validFrom: CalendarDate; readonly day: NbgDay; readonly observedAt?: number }
export interface StoredTables { readonly validFrom: CalendarDate; readonly en: NbgDay; readonly ka: NbgDay; readonly observedAt: number }
export interface MirrorReader {
    readState(signal: AbortSignal): Promise<Result<MirrorState, StoreError>>;
    /** The rows item with the latest validFrom on or before `date`. */
    readRowsInForce(date: CalendarDate, signal: AbortSignal): Promise<Result<StoredRows | undefined, StoreError>>;
    readTable(validFrom: CalendarDate, language: Language, signal: AbortSignal): Promise<Result<StoredTable | undefined, StoreError>>;
    /** Rows items with validFrom in [start, end], ascending, every page read. */
    readRowsBetween(start: CalendarDate, end: CalendarDate, signal: AbortSignal): Promise<Result<ReadonlyArray<StoredRows>, StoreError>>;
}
/** All a user request may do: read, and add a past table. */
export interface MirrorRequestStore extends MirrorReader {
    /** Adds the item if absent, never replaces one; the item holds the table alone. */
    fillPastTable(validFrom: CalendarDate, language: Language, day: NbgDay, signal: AbortSignal): Promise<Result<'written' | 'present', StoreError>>;
}
export interface MirrorStore extends MirrorRequestStore {
    readTablesBetween(start: CalendarDate, end: CalendarDate, signal: AbortSignal): Promise<Result<ReadonlyArray<StoredTables>, StoreError>>;
    /** Compare-and-set on revision, re-read and re-applied on a conflict up to 5 times; `next` undefined writes nothing. */
    updateState<T>(
        change: (state: MirrorState) => { readonly next: MirrorState | undefined; readonly outcome: T },
        signal: AbortSignal,
    ): Promise<Result<T, StoreError>>;
    /** The rows item and both table items, or none; only over an older observation or a past table. */
    commitPublication(publication: MirrorPublication, signal: AbortSignal): Promise<Result<'committed' | 'superseded', StoreError>>;
    removePublication(validFrom: CalendarDate, observedAt: number, signal: AbortSignal): Promise<Result<'removed' | 'superseded', StoreError>>;
    /** Archive rows items, each written whole; the caller moves rowsStart afterwards. */
    writeArchiveRows(items: ReadonlyArray<StoredRows>, signal: AbortSignal): Promise<Result<void, StoreError>>;
    /** Rewrites (or with undefined removes) an archive publication's rows and deletes both its past tables, in one transaction. */
    replaceArchivePublication(validFrom: CalendarDate, rows: ReadonlyArray<NbgCsvRow> | undefined, observedAt: number, signal: AbortSignal): Promise<Result<'replaced' | 'superseded', StoreError>>;
}

// test/helpers/memory-mirror-store.ts
export interface MemoryWrite {
    readonly operation: 'state' | 'commit' | 'remove' | 'fill' | 'archive' | 'replace';
    readonly key: string;
}
export interface MemoryMirrorStore extends MirrorStore {
    /** Successful writes, in order. */
    readonly writes: ReadonlyArray<MemoryWrite>;
    /** The stored item as JSON would hold it, to check what a past table carries. */
    rawItem(pk: string, sk: string): Readonly<Record<string, unknown>> | undefined;
    /** Called before each operation; may await, to interleave a write between two reads or hang one. */
    before(hook: ((operation: string) => Promise<void> | void) | undefined): void;
    /** Every operation fails with this detail until cleared. */
    failWith(detail: string | undefined): void;
}
export function createMemoryMirrorStore(): MemoryMirrorStore;
export async function seedMirror(
    store: MirrorStore,
    content: {
        readonly publications?: ReadonlyArray<MirrorPublication>;
        readonly archiveRows?: ReadonlyArray<StoredRows>;
        readonly state?: Partial<Omit<MirrorState, 'revision'>>;
    },
): Promise<void>;

// test/helpers/mirror-store-contract.ts
export function describeMirrorStoreContract(
    name: string,
    open: () => Promise<{ readonly store: MirrorStore; close(): Promise<void> }>,
): void;

// test/helpers/fake-nbg.ts
export interface FakeNbg {
    readonly client: NbgClient;
    /** 'day:en:2026-10-07' and 'range:AMD,USD:2026-10-01:2026-10-09', in order. */
    readonly requests: ReadonlyArray<string>;
    publish(publication: MirrorPublication): void; // both views, added or replaced
    publishJson(publication: MirrorPublication): void; // the JSON view only
    publishCsv(publication: MirrorPublication): void; // the CSV view only
    withdraw(validFrom: CalendarDate): void;
    /** Every request answers with this error until cleared. */
    failWith(error: RatesError | undefined): void;
    /** Requests wait for the returned release function. */
    hold(): () => void;
}
export function createFakeNbg(publications: ReadonlyArray<MirrorPublication>): FakeNbg;
```

The fake answers like NBG: `fetchDay(date)` gives the table with the latest validFrom on or before `date`, the latest table for a date after every table, and `no_data_for_date` (currency `undefined`) before the first one; `fetchRange` gives the rows of the requested codes with validFrom in `[start, end]`, newest first per code, in request order, and nothing at all when AZN is requested over a range reaching into the gap.

- [ ] **Step 1: Write the failing tests**

The contract suite, run on the memory store by `src/shell/mirror-store.test.ts`:
- An empty store reads `EMPTY_MIRROR_STATE`; `updateState` writes revision 1, then 2. Two racing `updateState` calls (the first change awaits a promise the second resolves) both land.
- `commitPublication` of 2026-10-07 at `observedAt` 1000 is `committed`; at 999 `superseded` with the 1000 items intact; at 1001 it replaces all three items; over a past table of the same date it is `committed`.
- `readRowsInForce('2026-10-05')` with rows items 10-03 and 10-06 gives 10-03; before the first `undefined`. `readTable` gives each language's table.
- `fillPastTable` writes an item whose raw form has only `pk`, `sk` and the table; a second fill of the same key is `present` and leaves the first table.
- `readRowsBetween` and `readTablesBetween` are inclusive at both ends and ascending.
- `removePublication` at an older observation is `superseded`; at a newer one all three items are gone.
- `replaceArchivePublication` rewrites the rows item and deletes both past tables of that date; with `undefined` the rows item is gone too.
- An aborted signal gives `store_failed`.

`fake-nbg.test.ts`: the rules above, each with one case, including AZN over `2007-12-01..2008-01-05` giving no rows for any code.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/shell/mirror-store.test.ts test/helpers/fake-nbg.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement the interface, the memory store, the contract suite and the fake**

The memory store copies values with `structuredClone` on the way in and out, so a test cannot change stored data through a reference.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shell/mirror-store.ts src/shell/mirror-store.test.ts test/helpers/memory-mirror-store.ts test/helpers/mirror-store-contract.ts test/helpers/fake-nbg.ts test/helpers/fake-nbg.test.ts vitest.config.ts
git commit -m "Define the mirror store and test it on an in-memory copy" -- src/shell/mirror-store.ts src/shell/mirror-store.test.ts test/helpers/memory-mirror-store.ts test/helpers/mirror-store-contract.ts test/helpers/fake-nbg.ts test/helpers/fake-nbg.test.ts vitest.config.ts
```

### Task 8: The DynamoDB store

**Files:**
- Create: `src/shell/mirror-dynamodb.ts`, `test/dynamodb/mirror-dynamodb.test.ts`
- Modify: `package.json` (devDependency `@aws-sdk/client-dynamodb` `^3.1105.0`, script `test:dynamodb`), `package-lock.json`, `vitest.config.ts` (project `dynamodb`), `.github/workflows/ci.yml`, `.github/workflows/release.yml` (build job), `test/e2e/build-lambda.test.ts`

**Interfaces:**
- Consumes: `MirrorStore` and the contract suite (Task 7).
- Produces:

```ts
export function createDynamoMirrorStore(options: { readonly tableName: string; readonly client?: DynamoDBClient }): MirrorStore;
```

Layout (decision 1), `pk` and `sk` strings. State: `{ pk: 'state', sk: 'state', revision: N, state: S }`, written by `PutItem` with `attribute_not_exists(pk)` for revision 0 and `revision = :expected` otherwise. Rows: `{ pk: 'rows', sk, rows: S, observedAt: N }`. Tables: `{ pk: 'table#en' | 'table#ka', sk, day: S, observedAt?: N }`. A commit is one `TransactWriteItems` of three `Put`s, each with `attribute_not_exists(observedAt) OR observedAt < :observedAt` (so a past table is replaced and a newer sync item is not); a `TransactionCanceledException` whose reasons are `ConditionalCheckFailed` is `superseded`. `fillPastTable` is a `PutItem` with `attribute_not_exists(pk)` and no other attribute than `day`. A removal is three `Delete`s with the commit's condition. `writeArchiveRows` uses `BatchWriteItem` in groups of 25 and retries `UnprocessedItems` until none remain. `replaceArchivePublication` is one transaction: a `Put` (or `Delete`) of the rows item with the commit's condition and unconditional `Delete`s of the two table items. Reads are `ConsistentRead: true`; `readRowsInForce` is a `Query` on `sk <= :date`, descending, `Limit` 1; range reads follow `LastEvaluatedKey` to the end. Every JSON read back is validated (`parseNbgResponse([day])`, `parseStoredRows`, `parseMirrorState`); a failure is `store_failed`. Every call passes its `abortSignal`. The default client is `new DynamoDBClient({ maxAttempts: 2 })`.

- [ ] **Step 1: Write the failing contract run**

`test/dynamodb/mirror-dynamodb.test.ts` calls `describeMirrorStoreContract('dynamodb', ...)` with a client on `process.env.DYNAMODB_ENDPOINT` (the test fails, not skips, when it is unset), region `us-east-1` and the static credentials `local`/`local`, so it never reaches a real AWS account. `open` creates a table named `mirror-test-<random>` with `pk` and `sk` keys on demand and `close` deletes it. Two more cases: 400 rows items of about 3 KB written by `writeArchiveRows` and read back complete (more than one page), and a commit whose second item fails its condition leaves the first unchanged.

In `test/e2e/build-lambda.test.ts`: the zip has no entry under `node_modules/@aws-sdk/`.

- [ ] **Step 2: Start DynamoDB Local and see the run fail**

Pin the newest `amazon/dynamodb-local` release tag (look it up on Docker Hub) with its digest, and use the same reference in both workflows.
Run: `docker run --rm -d --name dynamodb-local -p 127.0.0.1:8000:8000 amazon/dynamodb-local:<tag>@<digest> && DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm run test:dynamodb`
Expected: FAIL, `mirror-dynamodb.ts` does not exist.

- [ ] **Step 3: Implement `src/shell/mirror-dynamodb.ts`, the project, the script and the jobs**

`ci.yml` gains a job `dynamodb` (Node 24, a `services` container on port 8000, `npm ci`, `npm run test:dynamodb` with `DYNAMODB_ENDPOINT=http://localhost:8000`); the release build job gains the same service and runs `npm run test:dynamodb` after `test:e2e`.

- [ ] **Step 4: Run the contract and the gates**

Run: `DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm run test:dynamodb && npm run typecheck && npm run lint && npm test && npm run test:e2e; docker stop dynamodb-local`
Expected: PASS everywhere; the zip test confirms no SDK in the zip.

- [ ] **Step 5: Commit**

```bash
git add src/shell/mirror-dynamodb.ts test/dynamodb/mirror-dynamodb.test.ts package.json package-lock.json vitest.config.ts .github/workflows/ci.yml .github/workflows/release.yml test/e2e/build-lambda.test.ts
git commit -m "Store the mirror in DynamoDB, tested on DynamoDB Local" -- src/shell/mirror-dynamodb.ts test/dynamodb/mirror-dynamodb.test.ts package.json package-lock.json vitest.config.ts .github/workflows/ci.yml .github/workflows/release.yml test/e2e/build-lambda.test.ts
```

### Task 9: Answering from the mirror, and writing past tables

**Files:**
- Create: `src/shell/mirrored-rates-service.ts`, `src/shell/mirrored-rates-service.test.ts`

**Interfaces:**
- Consumes: `MirrorRequestStore` (Task 7), `planHistory`, `snapshotFromDay` (Task 4), `exportRows`, `checkTableAgainstRows`, `tableValidFrom` (Task 3), `isFresh`, `inSpan`, `isPastDate`, `coversInterval` (Task 2), `LookupScopes` (Task 6), `asNbgFailure`, `withoutNbg`, `ignoreCachedBefore`, `onFetched` (Task 5).
- Produces:

```ts
export const MIRROR_READ_TIMEOUT_MS = 2_000;
export const PAST_TABLE_WRITE_TIMEOUT_MS = 1_000;
export interface MirroredServiceDeps {
    readonly mirror: MirrorRequestStore;
    /** Today's service: the NBG client with its full timing and the instance's cache. */
    readonly live: RatesService;
    /** The same over a one-attempt client with a short timeout, sharing that cache. */
    readonly shortLive: RatesService;
    readonly scopes: LookupScopes;
    readonly now: () => Date;
    readonly readTimeoutMs?: number;
    readonly writeTimeoutMs?: number;
}
export function createMirroredRatesService(deps: MirroredServiceDeps): RatesService;
```

The prior failure is `withoutNbg`, else the current scope's. Without one, a call first makes the check `live` would make before any request (`rejectBeyondTomorrow` for a snapshot, `planHistory` for a history) and returns its error without a read; with one, a snapshot skips that check, so a date the mirror cannot answer gets the failure, as `nbg_convert_many` gives it today. Reads, all under one `AbortSignal.timeout(readTimeoutMs)`: `readState`; for a snapshot whose date is `inSpan` or `isPastDate`, `readRowsInForce(date)` and then `readTable(rows.validFrom, language)`; for a history that `coversInterval(plan.start, plan.end)`, `readRowsBetween(plan.start, plan.end)` through `exportRows(…, plan.currencies, …)`. The read is covered when the history interval is covered, or when the snapshot's table is found. The mirror's answer is `snapshotFromDay` plus `selectCurrencies`, or `assembleHistory(plan.currency, plan.days, rows, today)`; a positive answer is an ok result. Then:

| Mirror read | Prior failure | Result |
| --- | --- | --- |
| covered, fresh | any | the mirror's answer |
| covered, stale, positive | yes | the mirror's answer, no request |
| anything else | yes | that failure, no request |
| covered, stale, positive | no | `shortLive` with `ignoreCachedBefore` = the table's observation when it has one; on an NBG failure, record it and return the mirror's answer |
| covered, stale, negative | no | `live` with the same `ignoreCachedBefore`; record an NBG failure |
| a past date without its table | no | `live` with `onFetched`; record an NBG failure; then rule 7 |
| not covered otherwise, or a store error or timeout | no | `live`; record an NBG failure |

Rule 7, after `live` answered ok for a past date whose read succeeded: when `onFetched` gave a table, `tableValidFrom(table)` equals the rows' `validFrom`, `checkTableAgainstRows` passes and the scope's `fillStopped` is false, `fillPastTable` under `AbortSignal.timeout(writeTimeoutMs)`; a `store_failed` result sets `fillStopped`. The answer is `live`'s whatever the write does.

- [ ] **Step 1: Write the failing tests**

Over `createFakeNbg`, a memory store seeded with publications 2026-10-01 to 2026-10-07, span `2026-10-01..2026-10-09`, archive rows from `2024-01-01` (synthetic tables for 2024-03-15 and 2024-03-16, whose rows only are seeded), a clock at 2026-10-08 10:00 Tbilisi, `live` and `shortLive` from `createRatesService` over the fake's client and one shared `createSnapshotCache()`:
- Fresh: `getSnapshot` for `2026-10-05` in English and Georgian, with and without codes, and `getHistory` USD `2026-10-01..2026-10-07` and `2024-03-01..2024-03-31`, equal `live`'s answers, and the fake saw no request. `2026-10-09` is `rate_not_published` from the mirror with no request.
- Past date, first ask: `2024-03-16` in English goes to NBG once, equals `live`'s answer, and leaves one `fill` write whose raw item has only `pk`, `sk` and `day`. Then `2024-03-18` (Monday) in English comes from the mirror with no request; in Georgian it asks NBG and writes the Georgian table.
- No write when: the fake answers `2024-03-16` with a table valid from 2024-03-15 (Review Focus 2); the table's USD rate differs from the stored rows; the answer came from the instance cache; NBG fails; the store fails its reads; the date is in the span; the request is a history; the date is before `rowsStart` (2023-12-29).
- A write that hangs (a `before` hook on `fill`): the answer comes within `writeTimeoutMs` plus 100 ms, the scope's `fillStopped` is set, and a second past date in the same scope writes nothing.
- Fresh, `2023-12-29` (before the rows): `live`'s answer, one request, no write.
- Stale (fresh-until in the past) with NBG answering a newer USD rate for `2026-10-07`: the newer rate, through `shortLive`.
- `failWith('down')` on the store, and separately a `before` hook that waits 5 seconds on reads with `readTimeoutMs: 50`: `live`'s answer, the second within 1 second.
- Stale with NBG failing `upstream_unavailable`: `2026-10-07` and a stored past date are the mirror's rate and the scope holds the failure; `2026-10-09` (a "not published" mirror answer) is the failure; history of `XXX` (an `unknown_currency` mirror answer) is the failure.
- Cache rule: with the mirror stale, the cache holds `2026-10-07` from 09:00 at USD 2.6025, and the mirror's 2026-10-07 publication was observed at 09:30 with USD 2.7; NBG fails: the answer is 2.7. This fails without `ignoreCachedBefore`.
- Inside one scope whose failure is set: a stale positive date answers from the mirror and a past date without its table returns the failure, neither with a request; with `withoutNbg` and no scope, the same.
- Reader order (Review Focus 1): a `before` hook that, after the first read of a request, commits publications 2026-10-08 to 2026-10-10 and extends the span to `2026-10-11`; `getSnapshot('2026-10-10')` returns `live`'s answer (the fake's 2026-10-10 table), never the 2026-10-07 table carried over.
- Across every case above, the only writes are `fill` writes.
- Through `createHttpHandler` with this service and the same `lookupScopes` (helpers from `test/helpers/mcp-http.ts`):
  - Stale mirror, NBG failing: `nbg_convert` answers from the mirror and the log line has `nbgError: 'upstream_unavailable'`.
  - Stale mirror holding 30 publications, `shortLive` over `createNbgClient` (`timeoutMs` 3,000, `retry: false`) against `startFixtureServer` whose responder delays 60 seconds: `nbg_convert_many` of 100 items over those 30 dates converts all 100 in under 10 seconds with one request to the fixture server.
  - `nbg_convert_many` over 30 past dates without tables, with every `fill` hanging: all converted from NBG in under 5 seconds, one write attempted.
  - Fresh mirror: 50 concurrent `nbg_get_rates` calls for today and tomorrow make no request to the fake, before and after tomorrow's publication is committed.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/shell/mirrored-rates-service.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement `src/shell/mirrored-rates-service.ts`**

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shell/mirrored-rates-service.ts src/shell/mirrored-rates-service.test.ts
git commit -m "Answer hosted lookups from the mirror and keep past tables" -- src/shell/mirrored-rates-service.ts src/shell/mirrored-rates-service.test.ts
```

### Task 10: The sync runner and the hourly check

**Files:**
- Create: `src/shell/sync-publication.ts`, `src/shell/sync-check.ts`, `src/shell/sync.ts`, `src/shell/sync.test.ts`, `src/shell/sync-check.test.ts`

**Interfaces:**
- Consumes: `MirrorStore` (Task 7), the core of Tasks 1 to 3, `NbgClient`.
- Produces:

```ts
// src/shell/sync-publication.ts
export const SYNC_REQUEST_TIMEOUT_MS = 5_000;
export const SYNC_REQUEST_WORST_MS = 10_500; // two tries and the retry delay
export const SYNC_REQUEST_SPACING_MS = 500;
export const COMMIT_RESERVE_MS = 4_500;
export const LOG_RESERVE_MS = 500;
export type SyncFetch<T> =
    | { readonly kind: 'ok'; readonly value: T }
    | { readonly kind: 'nbg_error'; readonly error: RatesError }
    | { readonly kind: 'deadline' };
export interface SyncContext {
    readonly store: MirrorStore;
    readonly scheduledAt: Date;
    readonly today: CalendarDate;
    readonly now: () => Date;
    /** Spaced, counted, and not sent when the deadline does not allow its worst case plus a commit. */
    fetchDay(date: CalendarDate, language: Language): Promise<SyncFetch<NbgDay>>;
    fetchRange(codes: ReadonlyArray<CurrencyCode>, start: CalendarDate, end: CalendarDate): Promise<SyncFetch<ReadonlyArray<NbgCsvRow>>>;
    /** True while the remaining time minus LOG_RESERVE_MS covers `ms`. */
    allows(ms: number): boolean;
    signal(): AbortSignal; // AbortSignal.timeout(STORE_OPERATION_TIMEOUT_MS)
    readonly counts: { nbgRequests: number; committed: number };
}
export type ResolveOutcome = 'committed' | 'unchanged' | 'removed' | 'unresolved' | 'deadline';
export type SyncFailure = NbgFailure | StoreError | { readonly kind: 'empty_export' };
/** Fetches what the three sources say about one span publication and commits, removes or marks it unresolved. */
export function resolvePublication(
    context: SyncContext,
    validFrom: CalendarDate,
    csvRows: ReadonlyArray<NbgCsvRow> | undefined,
    requestedCodes: ReadonlyArray<CurrencyCode>,
): Promise<Result<ResolveOutcome, SyncFailure>>;

// src/shell/sync.ts
export interface SyncEvent { readonly kind: SyncKind; readonly scheduledTime: Date }
export interface SyncLogLine {
    readonly time: string;
    readonly syncRun: SyncKind;
    readonly scheduledTime: string;
    readonly syncResult: 'ok' | 'skipped' | 'failed';
    /** The failure kind, the skip reason, 'deadline', or null. */
    readonly syncDetail: string | null;
    /** True when this run recorded a fresh-until time. */
    readonly checked: boolean;
    readonly committed: number;
    readonly nbgRequests: number;
    /** 'start..end', or null without a span. */
    readonly span: string | null;
    readonly durationMs: number;
}
export interface SyncDeps {
    readonly store: MirrorStore;
    readonly client: NbgClient;
    readonly now: () => Date;
    readonly sleep: (ms: number) => Promise<void>;
    readonly log: (line: SyncLogLine) => void;
}
export function runSync(event: SyncEvent, remainingMs: () => number, deps: SyncDeps): Promise<SyncLogLine>;
export function notConfiguredLine(event: SyncEvent, now: Date): SyncLogLine; // failed, 'mirror_not_configured'

// src/shell/sync-check.ts
export interface CheckOutcome { readonly checked: boolean; readonly deadline: boolean }
export function runHourlyCheck(context: SyncContext, state: MirrorState): Promise<Result<CheckOutcome, SyncFailure>>;
```

`resolvePublication(V, csvRows, codes)`: observation is the time before its first fetch. English then Georgian table for V; a table whose valid-from date is not V means "not there": with CSV rows for V that is `unresolved`, without them and with V stored it is a removal. CSV rows are fetched for V alone when none were given or the tables carry a code outside `codes`; an empty export is `empty_export`. Agreement commits (or `unchanged` when the stored copy has the same tables and rows) and calls `markResolved`; disagreement calls `markUnresolved`. A commit starts only if `allows(COMMIT_RESERVE_MS)`.

`runSync`: an event older than `MAX_EVENT_AGE_MS` is skipped as `late` with no store call; then `readState`; then the window guard (Task 11); then `claimRun` through `updateState`, a lost claim skipped as `duplicate`; then the kind's work; then the log line, also returned.

`runHourlyCheck`: without a span, a bootstrap: today's English table gives the codes, one CSV over `[today - 7, tomorrow]`, every publication in it resolved, and the span started at the earliest one and ended at tomorrow only when all agree. With a span: the range runs from `min(span.end, today) - 7` to tomorrow, in CSV chunks of at most 31 days, codes from the latest stored table on or before each chunk's end through `csvRequestCodes`; each chunk compares `groupByValidFrom` of the export with `readRowsBetween`, resolves every changed date and every unresolved date in the chunk, and extends the span end to the chunk's end, or to the day before the first unresolved new date. A run whose span reached tomorrow records `freshUntilAfter(scheduledTime, stopped window date)` and is `checked`. Any unresolved date outside the chunks is retried after the check, within the deadline.

- [ ] **Step 1: Write the failing tests**

With the fake NBG over the recorded tables 2026-10-01 to 2026-10-07 (publications 10-01, 10-02, 10-03, 10-06, 10-07), a memory store, `sleep` recorded, the clock at the scheduled time plus 2 seconds, and 25,000 ms remaining unless stated:
- An event 61 seconds old: skipped `late`, no request, no write. The same scheduled time twice: the second skipped `duplicate` with no request.
- Bootstrap at 2026-10-08 10:00: span `2026-10-01..2026-10-09`, the five publications committed, fresh-until 11:05, `checked` true; the requests are today's English table, one CSV over `2026-10-01..2026-10-09`, then the English and Georgian tables of each publication, with `sleep(500)` between them.
- The 11:00 run with no change: one CSV request, nothing committed, fresh-until 12:05.
- 2026-10-06 changes USD in both views: the next run commits it with the newer observation.
- CSV ahead: `publishCsv` of a 2026-10-09 table at 17:00:30: 2026-10-09 is unresolved and not committed, the run is still `checked`; after `publishJson` the next run commits it and clears it.
- AMD withdrawn from 2026-10-06 in both views: the mirror's 2026-10-06 rows and tables lack AMD.
- An export with no rows: `failed`, `syncDetail` `empty_export`, nothing written but the claim, fresh-until unchanged.
- NBG failing: `failed`, `upstream_unavailable`, fresh-until unchanged.
- Ten days down: span end `2026-10-09`, the next run at 2026-10-20 10:00 with publications 10-08 to 10-20 and 10-14 in the CSV only: the span end is `2026-10-13`, `checked` false.
- Deadline: `remainingMs` drops below the gate after two publications of the bootstrap: `ok` with `syncDetail` `deadline`, no publication half written, and the next run finishes the bootstrap.
- A catch-up stopped by the deadline right after committing 2026-10-10 beyond a span ending `2026-10-09`, before the span moves: the service of Task 9 answers `2026-10-10` exactly as before the run (through `live`), and every date inside the span as before.
- A 16:00 run held by `hold()` after its CSV while a direct `commitPublication` of 2026-10-09 at a later observation and `recordFreshUntil` 17:03 land; releasing it leaves both as they were.
- `notConfiguredLine` is `failed` with `mirror_not_configured`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/shell/sync.test.ts src/shell/sync-check.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement the three modules (the window kind answers `skipped` with `not_built` until Task 11)**

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shell/sync-publication.ts src/shell/sync-check.ts src/shell/sync.ts src/shell/sync.test.ts src/shell/sync-check.test.ts
git commit -m "Keep the mirror equal to NBG with an hourly check" -- src/shell/sync-publication.ts src/shell/sync-check.ts src/shell/sync.ts src/shell/sync.test.ts src/shell/sync-check.test.ts
```

### Task 11: The publication window

**Files:**
- Modify: `src/shell/sync-check.ts`, `src/shell/sync.ts`, `src/shell/sync-check.test.ts`

**Interfaces:**
- Consumes: Task 10.
- Produces: `export function runWindowCheck(context: SyncContext, state: MirrorState): Promise<Result<CheckOutcome, SyncFailure>>;` and the window guard in `runSync`: an event outside `isWindowMinute` is skipped `outside_window`, and one whose window is stopped for today is skipped `window_stopped`, both before the claim.

Each run asks tomorrow's English table. A table not valid from tomorrow: nothing to commit, `quietRuns` 0. Valid from tomorrow and `sameTable` with the stored one (and tomorrow not unresolved): `quietRuns + 1`. Otherwise `resolvePublication(tomorrow, undefined, csvRequestCodes(tableCodes(en), tomorrow, tomorrow))`, `quietRuns` 0. Then unresolved dates, within the deadline. `recordWindow` with `stopped` when committed and `quietRuns >= QUIET_RUNS_TO_STOP`. When the span covers tomorrow, `recordFreshUntil(freshUntilAfter(scheduledTime, stopped ? today : undefined))`. A failed run writes no window state.

- [ ] **Step 1: Write the failing tests**

Friday 2026-10-16, a fake with synthetic tables for 2026-10-09 to 2026-10-16 and the mirror bootstrapped by the 16:00 hourly run:
- The fake publishes the 2026-10-17 table before the 17:01 run and republishes it with new write stamps before the 17:02 run. 17:00: nothing committed, fresh-until 17:03. 17:01: committed, three requests. 17:02 to 17:11: one request each, quiet; the 17:11 run stops the window and sets fresh-until 18:05. 17:12 to 17:30: skipped `window_stopped`, no request, no write.
- The republish changes USD: the 17:02 run commits again and the window stops at the 17:12 run.
- A holiday (no 2026-10-15 table, Wednesday 2026-10-14): 31 runs of one request each, no stop; the 17:30 run's fresh-until is 18:05.
- Ten failed runs: committed at 17:01, NBG failing from 17:02 to 17:11, answering from 17:12: no stop before the 17:21 run.
- Saturday 2026-10-17 17:05: skipped `outside_window`, no request.
- Tomorrow's English request answered with today's table (Review Focus 5): nothing committed, nothing unresolved.
- The 17:00 hourly run and the 17:00 window run started together (`Promise.all`) after the table appears: one copy of the 2026-10-17 publication, fresh-until 17:03, and a later 16:00-scheduled run released from `hold()` changes neither (Review Focus 4).
- Freshness through the service of Task 9: with only the 16:00 check successful and every window run failing, `isFresh` is true at 16:59, false at 17:03 and false at 17:31.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/shell/sync-check.test.ts`
Expected: FAIL on the window cases.

- [ ] **Step 3: Implement `runWindowCheck` and the guard**

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shell/sync-check.ts src/shell/sync.ts src/shell/sync-check.test.ts
git commit -m "Check every minute from 17:00 until tomorrow's table settles" -- src/shell/sync-check.ts src/shell/sync.ts src/shell/sync-check.test.ts
```

### Task 12: Daily refetch and weekly re-check

**Files:**
- Create: `src/shell/sync-archive.ts`, `src/shell/sync-archive.test.ts`
- Modify: `src/shell/sync.ts` (the hourly kind runs both after its check)

**Interfaces:**
- Consumes: Task 10.
- Produces:

```ts
export function runDailyRefetch(context: SyncContext, state: MirrorState): Promise<Result<'done' | 'not_due' | 'deadline', SyncFailure>>;
export function runRecheckSlice(context: SyncContext, state: MirrorState): Promise<Result<'done' | 'not_due' | 'deadline', SyncFailure>>;
```

Refetch: due when the Tbilisi hour is at least `DAILY_REFETCH_FROM_HOUR` and `refetch.day` is not today. For each stored span publication in `[today - 7, tomorrow]` from `refetch.cursor`: both tables; when either differs (`sameTable`), `resolvePublication` with its CSV fetched for it alone; the cursor saved after each; at the end `refetch.day` today and no cursor.

Re-check: a cycle starts when none ran or `cycleStartedAt` is `RECHECK_CYCLE_DAYS` old, at the year of `rowsStart ?? span.start`. A slice is due `RECHECK_SLICE_EVERY_HOURS` after the last one. The slice is the year clipped to the stored rows and to `today - 8`. Its codes are those of the stored rows in it, through `csvRequestCodes`. One CSV, compared with `readRowsBetween`; a changed date in the span goes through `resolvePublication`, one before it through `replaceArchivePublication` with the export's rows (or `undefined` when the export lacks it). The year advances when the slice is done.

- [ ] **Step 1: Write the failing tests**

- The 2026-10-06 English name of USD changes with no rate change: the 02:00 run refetches nothing; the 03:00 run commits the new name and records the day; the 04:00 run refetches nothing.
- A deadline after two publications: the cursor holds the third; the next hourly run finishes and records the day.
- A 2026-09-15 rate changed in both views (older than 7 days, inside a span started 2026-09-01): the slice for 2026 commits it through `resolvePublication`.
- A 2024-03-16 rate changed in the CSV, with both past tables of that date stored: the slice for 2024 rewrites its rows and deletes both tables; a later request writes the table again.
- Slices: a second slice waits 5 hours; the slice for 2006 requests without AZN; the 2005 slice requests BGN (a code of its own rows, absent today).
- A full cycle over rows from 2024-01-01 makes one CSV request per year, and a new cycle starts 7 days after the first.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/shell/sync-archive.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement both and call them from the hourly kind after its check**

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shell/sync-archive.ts src/shell/sync-archive.test.ts src/shell/sync.ts
git commit -m "Refetch the week's tables daily and recheck the rows weekly" -- src/shell/sync-archive.ts src/shell/sync-archive.test.ts src/shell/sync.ts
```

### Task 13: The archive rows' fill

**Files:**
- Modify: `src/shell/sync-archive.ts`, `src/shell/sync.ts`, `src/shell/sync-archive.test.ts`

**Interfaces:**
- Produces: `export function runArchiveFill(context: SyncContext, state: MirrorState): Promise<Result<'progress' | 'complete' | 'deadline', SyncFailure>>;`, called by the hourly kind after its check and refetch, and only once a span exists.

Up to `ARCHIVE_YEARS_PER_RUN` years per run, newest first. The next year's range ends the day before `rowsStart ?? span.start` and starts at the later of its 1 January and `NBG_ARCHIVE_START`. The English tables of the first day of each month in the range give the year's codes (their union); one CSV over the range with `csvRequestCodes` of them; an empty export is `empty_export`. `writeArchiveRows` with one item per publication, then `extendRowsStart(range start)`; a run stopped part way through a year leaves `rowsStart` where it was. `complete` once `rowsStart` is `NBG_ARCHIVE_START`, after which it asks nothing. Fresh-until is never touched.

- [ ] **Step 1: Write the failing tests**

- A span starting 2026-10-01 and a fake with synthetic tables across 2025 and 2026, one of which adds `XYZ` from 2025-06-02 to 2025-07-31 only: run 1 fills 2026-01-01 to 2026-09-30 and 2025 (`rowsStart` `2025-01-01`), and 2025's CSV requests `XYZ`; the requests per year are the months' English tables and one CSV, 500 ms apart.
- 2007: its CSV leaves AZN out and its rows are written without AZN; 2008's CSV includes AZN.
- A deadline after the month tables of a year: no rows of that year written, `rowsStart` unchanged; the next run fills it.
- With `rowsStart` at 1996-01-01 the next run fills 1995-10-14 to 1995-12-31 and reports `complete`; the run after asks nothing.
- The fill on a stale mirror leaves fresh-until unchanged.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/shell/sync-archive.test.ts`
Expected: FAIL on the fill cases.

- [ ] **Step 3: Implement `runArchiveFill` and call it from the hourly kind**

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shell/sync-archive.ts src/shell/sync.ts src/shell/sync-archive.test.ts
git commit -m "Fill the archive's CSV rows back to 1995 once" -- src/shell/sync-archive.ts src/shell/sync.ts src/shell/sync-archive.test.ts
```

### Task 14: Equivalence and the request budget

**Files:**
- Create: `src/shell/mirror-equivalence.test.ts`, `src/shell/sync-budget.test.ts`

**Interfaces:**
- Consumes: everything above; `createServer` with `InMemoryTransport` as `server.test.ts` connects it.

The mirror is built by `runSync` alone (an hourly bootstrap on 2026-10-08, then hourly runs until the archive fill is `complete`) over a fake NBG holding: the recorded tables 2026-10-01 to 2026-10-07 (Georgian from `ka-2026-10-07` for that day, `georgianTwin` for the others); synthetic tables for 1995-10-14 to 1995-10-16 (USD only), 2005-03-15 (recorded, with BGN), 2006-06-01, 2007-12-28, 2008-01-02 (with AZN), every day 2021-09-01 to 2021-09-11 and the business days 2021-09-13 to 2021-09-17 (the changeover), 2024-03-15 and 2024-03-16, 2025-12-30 and 2025-12-31 (BGN's last), 2026-01-03 (after the New Year holidays), and 2026-09-25 (Friday) and 2026-09-26 (published the next Monday, present by the time of the check). Past tables are written by the cases themselves, through the mirrored service.

- [ ] **Step 1: Write the tests**

`mirror-equivalence.test.ts`, the mirror fresh, at 2026-10-08 10:00 and again at 17:30 after the fake publishes 2026-10-09 and a window run commits it: for each case, `nbg_get_rates` (English, Georgian, with codes), `nbg_convert`, `nbg_convert_many`, `nbg_list_currencies`, `nbg_rate_history` and `resources/read` of `nbg://rates/<date>` give the same result through a server over the mirrored service as through one over `createRatesService` on the same fake, and past-date cases are asked twice (the first fills, the second reads the copy):
- a business day (2026-10-07), tomorrow before and after publication, a Sunday and a Monday carried over (2026-10-04, 2026-10-05), the day after a holiday (2026-01-02), the late publication (2026-09-28), a pre-September-2021 daily row (2021-09-05), the archive start (1995-10-14), an unknown code (`XXX`), history across the changeover (2021-09-01 to 2021-09-17), BGN history 2025-12-01 to 2025-12-31 and 2026-01-01 to 2026-01-10 (`unknown_currency` both ways), a past date and a later date carried over from it (2024-03-16 and 2024-03-18), and, on a second mirror whose fill stopped at 2025-01-01, a history starting 2025-01-10 (its lookback falls before the rows, so the live path answers, and the result is equal).
- The accepted difference, side by side: AZN history 2006-06-01 to 2006-06-10 is `no_data_for_date` live and `unknown_currency` from the mirror; AZN 2008-01-05 to 2008-01-10 is `no_data_for_date` live and a series from the mirror.

`sync-budget.test.ts`: with the archive fill already complete, a simulated Tbilisi day of runs at every scheduled minute over a fake publishing at 17:00:05 with a second write at 17:01:02, counting the fake's requests: a typical weekday 50 to 70, a weekday holiday 65 to 85, a weekend day 35 to 55 (the spec's about 60, 75 and 45). Separately, the fill from a span starting 2026-10-01 back to 1995-10-14 over a fake with one table a month makes 350 to 450 requests.

- [ ] **Step 2: Run them**

Run: `npx vitest run --project unit src/shell/mirror-equivalence.test.ts src/shell/sync-budget.test.ts`
Expected: PASS. A failure here is a defect in Tasks 9 to 13: fix it there, test first, and never adjust an expectation to make the paths agree.

- [ ] **Step 3: Run the gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shell/mirror-equivalence.test.ts src/shell/sync-budget.test.ts
git commit -m "Prove the mirror answers as NBG does and keeps its budget" -- src/shell/mirror-equivalence.test.ts src/shell/sync-budget.test.ts
```

### Task 15: The Lambda entry

**Files:**
- Modify: `src/lambda.ts`, `src/lambda.test.ts`, `src/shell/environment.ts`, `src/shell/environment.test.ts`

**Interfaces:**
- Consumes: `createMirroredRatesService` (Task 9), `runSync`, `notConfiguredLine` (Task 10), `createDynamoMirrorStore` (Task 8), `createLookupScopes` (Task 6).
- Produces:

```ts
// src/shell/environment.ts
export const SHORT_ATTEMPT_TIMEOUT_MS = 3_000;
export function mirrorTableFromEnvironment(env: Readonly<Record<string, string | undefined>>): string | undefined;
export function createNbgClientFromEnvironment(
    version: string,
    env: Readonly<Record<string, string | undefined>>,
    options?: { readonly timeoutMs?: number; readonly retry?: boolean },
): { readonly client: NbgClient; readonly baseUrl: string };
export function createServiceFromEnvironment(
    version: string,
    env: Readonly<Record<string, string | undefined>>,
    mirror?: { readonly store: MirrorRequestStore; readonly scopes: LookupScopes },
): EnvironmentService;

// src/lambda.ts
export interface LambdaContext { getRemainingTimeInMillis(): number }
export interface LambdaHandlerDeps {
    readonly http: (request: Request) => Promise<Response>;
    /** Undefined when no table is configured. */
    readonly sync: ((event: SyncEvent, remainingMs: () => number) => Promise<SyncLogLine>) | undefined;
    readonly log: (line: SyncLogLine) => void;
    readonly now: () => Date;
}
export function createLambdaHandler(
    deps: LambdaHandlerDeps,
): (event: unknown, context?: LambdaContext) => Promise<ApiGatewayV2Result | undefined>;
export const handler: ReturnType<typeof createLambdaHandler>;
```

A sync event is `{ "nbgRatesSync": "hourly" | "window", "scheduledTime": "<ISO 8601>" }` (zod). An event with `requestContext.http` goes the API Gateway way, as today. Anything else throws `Error('unrecognized event')`, which Lambda counts in `Errors` (Part B uses it). Without a table, a sync event logs `notConfiguredLine`. With a table, `lambda.ts` loads `./shell/mirror-dynamodb.js` with a top-level `await import`, builds one store, one `createLookupScopes()` shared by the service and `createHttpHandler`, the short client (`SHORT_ATTEMPT_TIMEOUT_MS`, `retry: false`) and the sync client (`SYNC_REQUEST_TIMEOUT_MS`), and `remainingMs` from `context.getRemainingTimeInMillis`. The service receives the store typed `MirrorRequestStore`; only the sync gets `MirrorStore`. Sync lines go to `console.log(JSON.stringify(line))` like request lines.

- [ ] **Step 1: Write the failing tests**

- `environment.test.ts`: `mirrorTableFromEnvironment` gives `undefined` for unset, `''` and `'  '`, and the trimmed name otherwise; with a mirror, `createServiceFromEnvironment` answers a fresh covered date from a memory store with no request to `NBG_RATES_BASE_URL`.
- `lambda.test.ts`, through `createLambdaHandler` with fakes: a sync event reaches `sync` with its kind and a `Date` and returns `undefined`; with `sync` undefined it logs a `mirror_not_configured` line; `{ "nbgRatesSync": "backfill" }` and `{ "foo": 1 }` reject with `unrecognized event`; an API Gateway event still answers through `http`. The existing module-level tests stay green with the variable unset.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit src/lambda.test.ts src/shell/environment.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the entry and the environment helpers**

Update the module comment of `lambda.ts` (two ways in; the mirror only with the variable).

- [ ] **Step 4: Run every gate**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: PASS; `build-lambda.test.ts` still finds `dist/lambda.js` and no `@aws-sdk` in the zip.

- [ ] **Step 5: Commit**

```bash
git add src/lambda.ts src/lambda.test.ts src/shell/environment.ts src/shell/environment.test.ts
git commit -m "Run the sync and read the mirror from the Lambda entry" -- src/lambda.ts src/lambda.test.ts src/shell/environment.ts src/shell/environment.test.ts
```

### Task 16: The privacy sentence and the documents

**Files:**
- Modify: `src/shell/site/copy-en.ts`, `src/shell/site/copy-ka.ts`, `README.md`, `docs/directory-listings.md`, `docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md`, `docs/superpowers/specs/2026-10-15-nbg-failure-alarm-design.md`, and any test that pins the old sentence (`grep -rn "never records" src test`)

- [ ] **Step 1: Change the privacy sentence in every copy**

- `copy-en.ts` privacy line 1, and `docs/directory-listings.md` line 268: the Global Constraints text verbatim ("The connector needs no account and never records ..." in the first; the listing's "The connector never records the amounts or currencies you ask about. For a past date it keeps a copy of NBG's table the first time anyone asks; the copy does not say who asked or when." in the second).
- `README.md` line 42 and `docs/directory-listings.md` line 95, in their "asked" form: "It needs no account and never records the amounts or currencies asked; for a past date it keeps a copy of NBG's table the first time anyone asks, and the copy does not say who asked or when." (the listing without "It needs no account and").
- `copy-ka.ts` privacy line 1, as the owner confirmed it on 2026-10-17: `'კონექტორს რეგისტრაცია არ სჭირდება და არასოდეს ინახავს თანხებს ან ვალუტებს, რომლებზეც კითხულობთ. წარსული თარიღისთვის ის ინახავს ეროვნული ბანკის ცხრილის ასლს, როცა ვინმე მას პირველად მოითხოვს; ასლიდან არ ჩანს, ვინ ან როდის მოითხოვა.'`
- Update the tests that pin the sentence to the new text.

- [ ] **Step 2: Amend the hosted endpoint spec**

Under `### src/lambda.ts`: the handler takes a scheduled sync event as well as an API Gateway one, and an unrecognized event throws. Under `### Environment variables`: `NBG_RATES_MIRROR_TABLE`, Lambda only, unset or empty meaning no mirror. In the paragraph on `src/shell/environment.ts`: with the variable, the rates service reads the mirror first, and a request may write a past table. Each addition says "(added 2026-10-17, `2026-10-16-nbg-mirror-design.md`)".

- [ ] **Step 3: Point the alarm spec's non-goal at the mirror**

After the bullet "A scheduled probe of NBG from AWS", add: "Superseded on 2026-10-17 by the scheduled sync of `2026-10-16-nbg-mirror-design.md`, accepted there at about 45 to 75 requests a day and a one-off fill of about 400."

- [ ] **Step 4: Name the variable in the README's Lambda paragraph (line 117)**

Append: "Optionally, `NBG_RATES_MIRROR_TABLE` names a DynamoDB table that the same function fills from NBG on a schedule and then answers from; unset, every lookup goes to NBG."

- [ ] **Step 5: Check and commit**

Run: `npm run format:check && npm test && grep -rn "amounts, dates or currencies" src README.md docs/directory-listings.md; grep -cP '[\x{2013}\x{2014}]' README.md docs/directory-listings.md docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md docs/superpowers/specs/2026-10-15-nbg-failure-alarm-design.md`
Expected: format clean and tests pass; the first grep prints nothing; counts `0`.

```bash
git add src/shell/site/copy-en.ts src/shell/site/copy-ka.ts README.md docs/directory-listings.md docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md docs/superpowers/specs/2026-10-15-nbg-failure-alarm-design.md <pinned tests>
git commit -m "Say what the mirror keeps in the privacy text and the docs" -- src/shell/site/copy-en.ts src/shell/site/copy-ka.ts README.md docs/directory-listings.md docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md docs/superpowers/specs/2026-10-15-nbg-failure-alarm-design.md <pinned tests>
```

### Task 17: Release 0.7.0

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `package-lock.json` (the two root `version` fields), `manifest.json`, `server.json` (both `version` fields)

- [ ] **Step 1: Write the CHANGELOG entry**

Above `## 0.6.4`, with the commit's date:

```markdown
## 0.7.0 - <YYYY-MM-DD>

Added: the hosted endpoint can answer from a mirror of NBG's data in DynamoDB, named by `NBG_RATES_MIRROR_TABLE`. A scheduled sync in the same function keeps the recent tables and the whole archive's CSV rows equal to NBG (hourly, and every minute from 17:00 on weekdays until the next day's table settles), and the first request for a past date keeps a copy of that date's table once it matches the rows. When the mirror is out of date or lacks a date, requests ask NBG as before, and during an NBG outage they get the mirror's rate. Without the variable nothing changes, and local installs never use it.

Changed: the privacy text says that the hosted copy keeps NBG's table for a past date the first time anyone asks, without noting who asked or when.
```

- [ ] **Step 2: Bump the version to 0.7.0**

Run: `grep -n '"version"' package.json manifest.json server.json && sed -n '1,12p' package-lock.json | grep -n version`
Expected: every listed field reads `0.7.0`.

- [ ] **Step 3: Run the gates and the release checks**

Run: the gates with `test:dynamodb`, then `bash scripts/build-bundle.sh && npx tsx scripts/check-release.ts 0.7.0`, then `grep -cP '[\x{2013}\x{2014}]' CHANGELOG.md`
Expected: all pass; count `0`.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md package.json package-lock.json manifest.json server.json
git commit -m "Release 0.7.0" -- CHANGELOG.md package.json package-lock.json manifest.json server.json
```

---

## Part B: release and infrastructure (in session, with the owner's go-ahead at each outward step)

### B1. Watch a real 17:00 publication

On a weekday before B5, a scratch script (`scratchpad/YYYY-MM-DD-HHMM-watch-publication.ts`, run with `npx tsx`) asks tomorrow's English and Georgian tables and the CSV export (every code of today's table) every 20 seconds from 16:59 to 17:15, about 150 requests, and writes one JSON line per poll. Report: when each source first shows the new table, whether a second write comes and what it changes (rates, names, diffs, stamps), and how far apart the sources are. If a value changes after the tenth quiet minute, or the Georgian table changes a rate the English one does not, stop and bring it to the owner: the window check or the commit rule needs adjusting first. Repeat on the next late publication seen.

### B2. Tag and release 0.7.0

1. Push `main` and watch CI, the `dynamodb` job included, to its end.
2. Right before the tag, `node scripts/smoke-http.ts https://nbg-rates.env.ge/mcp 0.6.4` passes (no deploy during an NBG outage).
3. Tag `v0.7.0` (signed, annotated, message `v0.7.0`), push it, and watch the release run, deploy included, to its end.
4. The footer and `initialize` report 0.7.0, and both landing pages show the new privacy sentence.

### B3. A real sync line, and the metric filter patterns

1. `aws lambda invoke --function-name nbg-rates-mcp --qualifier live --invocation-type Event --cli-binary-format raw-in-base64-out --payload '{"nbgRatesSync":"hourly","scheduledTime":"<now, ISO 8601>"}' /dev/null` writes a `mirror_not_configured` line.
2. Read it with `aws logs filter-log-events --log-group-name /aws/lambda/nbg-rates-mcp --start-time <ms> --filter-pattern '{ $.syncRun = "hourly" }' --max-items 1 --query 'events[0].message' --output json`.
3. `aws logs test-metric-filter` with `{ $.syncResult = "failed" }` matches that line and not the line with `"syncResult":"ok"`; `{ $.checked IS TRUE }` matches the line edited to `"checked":true` and not the real one; neither matches a request line nor START, END or REPORT lines.

### B4. Infrastructure in `personal/iac` (spec step 2)

Before editing, ask the Personal IaC sessions whether the aws root is free, and build on what is committed there then. In `terraform/aws/nbg-rates-mcp.tf`, in its style, each new resource with an import block:
- `aws_dynamodb_table` `${local.nbg_rates_mcp_name}-mirror`: `PAY_PER_REQUEST`, hash `pk` and range `sk` (both `S`), deletion protection on, point-in-time recovery off, with a comment saying why (the spec's privacy reason).
- An inline policy on the function role: `dynamodb:GetItem`, `Query`, `PutItem`, `DeleteItem` and `BatchWriteItem` on the table; the role's description no longer says "logs only".
- `aws_lambda_function_event_invoke_config` on qualifier `live`: `maximum_retry_attempts = 0`, `maximum_event_age_in_seconds = 60`.
- One scheduler role trusted by `scheduler.amazonaws.com` (condition `aws:SourceAccount`), allowed `lambda:InvokeFunction` on the alias ARN.
- Two `aws_scheduler_schedule`s, `Asia/Tbilisi`, flexible window `OFF`, target the alias ARN, `retry_policy` 0 retries and 60 seconds, `input` the literal string `{"nbgRatesSync":"<kind>","scheduledTime":"<aws.scheduler.scheduled-time>"}` (corrected on 2026-10-20: `jsonencode` writes `<` and `>` as `\u003c` and `\u003e`, so Scheduler sent its placeholder unreplaced and the first hourly run was rejected as an unrecognized event): `-sync-hourly` `cron(0 * * * ? *)` and `-sync-window` `cron(0-30 17 ? * MON-FRI *)`; `state` from a new variable `nbg_rates_mcp_sync_enabled` (default `false`).
- Metric filters `-sync-failures` (`{ ($.syncRun = "hourly") && ($.syncResult = "failed") }`, metric `SyncFailures`; `{ $.syncResult = "failed" }` until 2026-10-30, see the spec) and `-sync-checks` (`{ $.checked IS TRUE }`, metric `SyncChecks`), namespace `local.nbg_rates_mcp_name`, no default value.
- Alarms in the style of the four, each with both actions on `aws_sns_topic.notify_me`: `-sync-failed` (`FILL(failures, 0)` of `SyncFailures`, Sum, 3600 s, at least 1 in 2 of 2 periods, missing not breaching; changed from 300 s on 2026-10-20 and to `FILL` on 2026-10-30, see the spec); `-sync-window-failed` (added 2026-10-20: `WindowSyncFailures` from `{ ($.syncRun = "window") && ($.syncResult = "failed") }`, Sum, 3600 s, at least 10, missing not breaching; read through `FILL(failures, 0)` since 2026-10-31); `-function-errors` (`AWS/Lambda` `Errors`, dimension `FunctionName`, Sum, 300 s, at least 1, missing not breaching); `-mirror-stale` (`SyncChecks`, Sum, 1800 s, less than 1, 4 of 4, missing breaching, `actions_enabled = var.nbg_rates_mcp_sync_enabled` so it is silent while the schedules are off).
- The budget's service filter gains `Amazon DynamoDB` and the scheduler's Cost Explorer name, read from `aws ce get-dimension-values --dimension SERVICE` or the billing console before it is written.
- A variable `nbg_rates_mcp_mirror` (default `false`) that adds `NBG_RATES_MIRROR_TABLE` to the environment when true.
- The file's top comment and `docs/aws.md` name the table, the schedules, the three alarms, the release order and the rollback rule.

`terraform plan`, review with the owner, apply.

### B5. Switch the mirror on (spec step 3)

Set `nbg_rates_mcp_mirror = true` in `variables.tf`, commit, apply. Promote the new version by the `docs/aws.md` procedure: compare `CodeSha256` of the new version with `--qualifier live` and run `update-alias` only when they match. Before `update-alias`, invoke the new version by its number (`--qualifier <version>`, `--invocation-type RequestResponse`) with `{"nbgRatesSync":"hourly","scheduledTime":"2026-01-01T00:00:00Z"}`: the response carries no `FunctionError` and the log line is `skipped` with `syncDetail` `late`. With the variable set, the module imports `@aws-sdk/client-dynamodb` when it starts, so this proves the runtime provides it; a runtime without it fails every invocation of that version, API requests included, and the alias stays where it is. `aws lambda get-alias --function-name nbg-rates-mcp --name live` shows that version, and `get-function-configuration --qualifier live` lists the variable. Requests still go to NBG: the mirror has no span yet.

### B6. Enable the schedules (spec step 4) and prove the rest

1. `nbg_rates_mcp_sync_enabled = true`, commit, apply.
2. The first hourly run's line is `ok` with `checked: true` and a span ending tomorrow: the runtime's DynamoDB client is proven on the deployed function. Over the next two days or so the lines' `rowsStart` moves back about one year per hourly run until it reaches 1995-10-14: within the 29 s limit a run fits about one year's requests, and the fill resumes where the last run stopped.
3. A hosted conversion for today succeeds, and over the next day the sync lines' `nbgRequests` add up to the budget of Task 14 plus the fill's one-off count.
4. `aws cloudwatch set-alarm-state` sends each new alarm to `ALARM` and back to `OK`; the owner confirms the mails. Invoke the alias once with `{"foo":1}` and see `-function-errors` fire.
5. Before any later move of the alias to a version below 0.7.0, set `nbg_rates_mcp_sync_enabled = false` and apply first.
