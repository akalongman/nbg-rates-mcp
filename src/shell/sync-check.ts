import { addDays } from '../core/dates.js';
import {
    extendSpanEnd,
    inSpan,
    markUnresolved,
    recordFreshUntil,
    recordWindow,
    startSpan,
    type MirrorSpan,
    type MirrorState,
    type WindowState,
} from '../core/mirror.js';
import {
    changedPublications,
    csvRequestCodes,
    exportRows,
    groupByValidFrom,
    sameTable,
    tableCodes,
    tableValidFrom,
} from '../core/mirror-publication.js';
import { freshUntilAfter, QUIET_RUNS_TO_STOP } from '../core/sync-schedule.js';
import { err, ok, type CalendarDate, type CurrencyCode, type Result } from '../core/types.js';
import {
    applyToState,
    resolvePublication,
    SYNC_REQUEST_SPACING_MS,
    SYNC_REQUEST_WORST_MS,
    syncNbgFailure,
    type SyncContext,
    type SyncFailure,
} from './sync-publication.js';

/** The late-publication window's days before today; cache.ts keeps the same value as LATE_PUBLICATION_DAYS. */
const LATE_PUBLICATION_DAYS = 7;
/** The longest range one CSV request of the check covers. */
const CSV_CHUNK_DAYS = 31;

export interface CheckOutcome {
    readonly checked: boolean;
    readonly deadline: boolean;
    /** The failure that ended the retries of unresolved dates outside the checked range, after the check succeeded. */
    readonly retryFailure?: SyncFailure;
}

interface Chunk {
    readonly start: CalendarDate;
    readonly end: CalendarDate;
}

/** How the check's chunks ended: verified to tomorrow, held short of a date the sources disagree on, or out of time. */
type Coverage = 'complete' | 'short' | 'deadline';

type ChunkResolution =
    | {
          readonly kind: 'resolved';
          /** The dates left unresolved, ascending. */
          readonly unresolved: ReadonlyArray<CalendarDate>;
          /** The export's earliest publication. */
          readonly first: CalendarDate | undefined;
      }
    | { readonly kind: 'deadline' };

function earlier(left: CalendarDate, right: CalendarDate): CalendarDate {
    return left < right ? left : right;
}

function chunksOf(start: CalendarDate, end: CalendarDate): ReadonlyArray<Chunk> {
    const chunks: Chunk[] = [];
    let chunkStart = start;
    while (chunkStart <= end) {
        const chunkEnd = earlier(addDays(chunkStart, CSV_CHUNK_DAYS - 1), end);
        chunks.push({ start: chunkStart, end: chunkEnd });
        chunkStart = addDays(chunkEnd, 1);
    }
    return chunks;
}

/** The Tbilisi date whose window the state records as stopped, if any. */
export function stoppedWindowDate(state: MirrorState): CalendarDate | undefined {
    return state.window?.stopped === true ? state.window.date : undefined;
}

/** The codes of NBG's English table for today, for a chunk: what the bootstrap asks the CSV for. */
async function todaysCodes(
    context: SyncContext,
    chunk: Chunk,
): Promise<Result<ReadonlyArray<CurrencyCode> | 'deadline', SyncFailure>> {
    const latest = await context.fetchDay(context.today, 'en');
    if (latest.kind === 'deadline') {
        return ok('deadline');
    }
    if (latest.kind === 'nbg_error') {
        return err(syncNbgFailure(latest.error));
    }
    return ok(csvRequestCodes(tableCodes(latest.value), chunk.start, chunk.end));
}

/** The codes of the latest stored table on or before the chunk's end; today's table at NBG when none is stored. */
async function chunkCodes(
    context: SyncContext,
    chunk: Chunk,
): Promise<Result<ReadonlyArray<CurrencyCode> | 'deadline', SyncFailure>> {
    const inForce = await context.store.readRowsInForce(chunk.end, context.signal());
    if (!inForce.ok) {
        return inForce;
    }
    if (inForce.value !== undefined) {
        const table = await context.store.readTable(inForce.value.validFrom, 'en', context.signal());
        if (!table.ok) {
            return table;
        }
        if (table.value !== undefined) {
            return ok(csvRequestCodes(tableCodes(table.value.day), chunk.start, chunk.end));
        }
    }
    return todaysCodes(context, chunk);
}

/**
 * The export's dates for which the mirror holds no publication's table pair. With the dates whose stored rows differ
 * from the export's, these are the ones no earlier run committed as they stand: a commit writes the rows and both
 * tables together, after the three sources agreed.
 */
async function withoutTables(
    context: SyncContext,
    chunk: Chunk,
    fetched: ReadonlyMap<CalendarDate, unknown>,
): Promise<Result<ReadonlyArray<CalendarDate>, SyncFailure>> {
    const tables = await context.store.readTablesBetween(chunk.start, chunk.end, context.signal());
    if (!tables.ok) {
        return tables;
    }
    const stored = new Set(tables.value.map((pair) => pair.validFrom));
    return ok([...fetched.keys()].filter((validFrom) => !stored.has(validFrom)));
}

/**
 * One CSV export over the chunk, compared with the mirror's rows for the same chunk and codes; then each date that
 * changed, each date already unresolved in the chunk, and with `everyPublication` each date in the export that an
 * earlier run has not committed (withoutTables), is resolved in date order. So a bootstrap cut short by the deadline
 * fetches only what it has not yet committed when the next run takes it up.
 */
async function resolveChunk(
    context: SyncContext,
    state: MirrorState,
    chunk: Chunk,
    codes: ReadonlyArray<CurrencyCode>,
    everyPublication: boolean,
): Promise<Result<ChunkResolution, SyncFailure>> {
    const exported = await context.fetchRange(codes, chunk.start, chunk.end);
    if (exported.kind === 'deadline') {
        return ok({ kind: 'deadline' });
    }
    if (exported.kind === 'nbg_error') {
        return err(syncNbgFailure(exported.error));
    }
    if (exported.value.length === 0) {
        return err({ kind: 'empty_export' }); // never read as removals
    }
    const stored = await context.store.readRowsBetween(chunk.start, chunk.end, context.signal());
    if (!stored.ok) {
        return stored;
    }
    const fetched = groupByValidFrom(exported.value);
    // The mirror's rows as the same request would list them: a stored row of a code not asked is not a removal.
    const held = groupByValidFrom(exportRows(stored.value, codes, chunk.start, chunk.end));
    const inChunk = state.unresolved.filter((date) => date >= chunk.start && date <= chunk.end);
    const uncommitted = everyPublication ? await withoutTables(context, chunk, fetched) : ok([]);
    if (!uncommitted.ok) {
        return uncommitted;
    }
    const dates = new Set([...changedPublications(fetched, held), ...inChunk, ...uncommitted.value]);
    const unresolved: CalendarDate[] = [];
    for (const validFrom of [...dates].sort()) {
        const outcome = await resolvePublication(context, validFrom, fetched.get(validFrom) ?? [], codes);
        if (!outcome.ok) {
            return outcome;
        }
        if (outcome.value === 'deadline') {
            return ok({ kind: 'deadline' });
        }
        if (outcome.value === 'unresolved') {
            unresolved.push(validFrom);
        }
    }
    return ok({ kind: 'resolved', unresolved, first: [...fetched.keys()].sort()[0] });
}

/**
 * Without a span: today's English table gives the codes, one CSV covers the window, every publication in it is
 * resolved but one an earlier attempt already committed as the export lists it, and the span starts at the earliest
 * one and ends at tomorrow only when all of them agree.
 */
async function bootstrap(
    context: SyncContext,
    state: MirrorState,
    window: Chunk,
): Promise<Result<Coverage, SyncFailure>> {
    const codes = await todaysCodes(context, window);
    if (!codes.ok) {
        return codes;
    }
    if (codes.value === 'deadline') {
        return ok('deadline');
    }
    const resolved = await resolveChunk(context, state, window, codes.value, true);
    if (!resolved.ok) {
        return resolved;
    }
    if (resolved.value.kind === 'deadline') {
        return ok('deadline');
    }
    const { unresolved, first } = resolved.value;
    if (unresolved.length > 0 || first === undefined) {
        return ok('short');
    }
    const span: MirrorSpan = { start: first, end: window.end };
    const started = await applyToState(context, (current) => extendSpanEnd(startSpan(current, span), span.end));
    if (!started.ok) {
        return started;
    }
    return ok(started.value.kind === 'deadline' ? 'deadline' : 'complete');
}

/**
 * With a span: chunk by chunk from `start` to tomorrow, each chunk's dates resolved and the span's end moved to the
 * chunk's end, or to the day before the first new date (after the span's end) left unresolved, where the check stops.
 */
async function catchUp(
    context: SyncContext,
    state: MirrorState,
    span: MirrorSpan,
    start: CalendarDate,
    tomorrow: CalendarDate,
): Promise<Result<Coverage, SyncFailure>> {
    let spanEnd = span.end;
    for (const chunk of chunksOf(start, tomorrow)) {
        const codes = await chunkCodes(context, chunk);
        if (!codes.ok) {
            return codes;
        }
        if (codes.value === 'deadline') {
            return ok('deadline');
        }
        const resolved = await resolveChunk(context, state, chunk, codes.value, false);
        if (!resolved.ok) {
            return resolved;
        }
        if (resolved.value.kind === 'deadline') {
            return ok('deadline'); // the span stays where it was: every date it covers is verified
        }
        const end = spanEnd;
        const blocking = resolved.value.unresolved.find((date) => date > end);
        const target = blocking === undefined ? chunk.end : addDays(blocking, -1);
        const extended = await applyToState(context, (current) => extendSpanEnd(current, target));
        if (!extended.ok) {
            return extended;
        }
        if (extended.value.kind === 'deadline') {
            return ok('deadline');
        }
        spanEnd = extended.value.state.span?.end ?? target;
        if (blocking !== undefined) {
            return ok('short');
        }
    }
    return ok('complete');
}

/**
 * Retries each unresolved date outside the checked range, oldest first, while the deadline allows. A failure ends the
 * retries; the date stays unresolved for the next run.
 */
async function retryOutside(
    context: SyncContext,
    state: MirrorState,
    range: Chunk,
): Promise<Result<'done' | 'deadline', SyncFailure>> {
    for (const validFrom of state.unresolved) {
        if (validFrom >= range.start && validFrom <= range.end) {
            continue;
        }
        const outcome = await resolvePublication(context, validFrom, undefined, []);
        if (!outcome.ok) {
            return outcome;
        }
        if (outcome.value === 'deadline') {
            return ok('deadline');
        }
    }
    return ok('done');
}

/**
 * The hourly check, from `state` as the run claimed it. Without a span it bootstraps one over the last
 * LATE_PUBLICATION_DAYS days and tomorrow; with one it covers from `min(span.end, today) - LATE_PUBLICATION_DAYS` to
 * tomorrow in CSV chunks of at most CSV_CHUNK_DAYS days. A check whose span reaches tomorrow records the fresh-until
 * time due after the scheduled time and is `checked`. Unresolved dates outside the range are retried after it; a
 * failure there is answered as `retryFailure` beside the check's own outcome, which stands.
 */
export async function runHourlyCheck(
    context: SyncContext,
    state: MirrorState,
): Promise<Result<CheckOutcome, SyncFailure>> {
    const tomorrow = addDays(context.today, 1);
    const { span } = state;
    const start = addDays(
        span === undefined ? context.today : earlier(span.end, context.today),
        -LATE_PUBLICATION_DAYS,
    );
    const range: Chunk = { start, end: tomorrow };
    const coverage =
        span === undefined
            ? await bootstrap(context, state, range)
            : await catchUp(context, state, span, start, tomorrow);
    if (!coverage.ok) {
        return coverage;
    }
    if (coverage.value === 'deadline') {
        return ok({ checked: false, deadline: true });
    }
    let checked = false;
    if (coverage.value === 'complete') {
        const recorded = await applyToState(context, (current) =>
            recordFreshUntil(current, freshUntilAfter(context.scheduledAt, stoppedWindowDate(current)).getTime()),
        );
        if (!recorded.ok) {
            return recorded;
        }
        if (recorded.value.kind === 'deadline') {
            return ok({ checked: false, deadline: true });
        }
        checked = true;
    }
    const retried = await retryOutside(context, state, range);
    if (!retried.ok) {
        return ok({ checked, deadline: false, retryFailure: retried.error });
    }
    return ok({ checked, deadline: retried.value === 'deadline' });
}

/** What one window run saw of tomorrow's publication. */
type TomorrowSeen =
    /**
     * Quiet: NBG's English table for tomorrow is the stored one (write stamps aside), and tomorrow is not unresolved.
     * `storedObservedAt` is the stored table's observation, which dates the commit the run compared against.
     */
    | { readonly quiet: true; readonly storedObservedAt: number | undefined }
    /** Anything else; `committed` when the mirror holds tomorrow's publication as NBG's sources agree on it. */
    | { readonly quiet: false; readonly committed: boolean };

const NOT_THERE: TomorrowSeen = { quiet: false, committed: false };

/**
 * Both of tomorrow's tables are there and the CSV for tomorrow alone lists nothing yet: the CSV runs behind the JSON,
 * so tomorrow stays unresolved for the next run instead of failing this one.
 */
async function csvBehind(
    context: SyncContext,
    tomorrow: CalendarDate,
): Promise<Result<TomorrowSeen | 'deadline', SyncFailure>> {
    const marked = await applyToState(context, (current) => markUnresolved(current, [tomorrow]));
    if (!marked.ok) {
        return marked;
    }
    return ok(marked.value.kind === 'deadline' ? 'deadline' : NOT_THERE);
}

/**
 * The window's first step. NBG's English table for tomorrow: one valid from an earlier date is NBG's JSON answering
 * its latest table, so tomorrow's is not there yet and nothing is stored. One equal to the stored table, with tomorrow
 * not unresolved, is a quiet run. Otherwise the Georgian table and the CSV for tomorrow decide, through
 * resolvePublication, with the observation taken before the English request.
 */
async function checkTomorrow(
    context: SyncContext,
    state: MirrorState,
    tomorrow: CalendarDate,
): Promise<Result<TomorrowSeen | 'deadline', SyncFailure>> {
    const observedAt = context.now().getTime();
    const fetched = await context.fetchDay(tomorrow, 'en');
    if (fetched.kind === 'deadline') {
        return ok('deadline');
    }
    if (fetched.kind === 'nbg_error') {
        return err(syncNbgFailure(fetched.error));
    }
    const en = fetched.value;
    if (tableValidFrom(en) !== tomorrow) {
        return ok(NOT_THERE);
    }
    if (!state.unresolved.includes(tomorrow)) {
        const stored = await context.store.readTable(tomorrow, 'en', context.signal());
        if (!stored.ok) {
            return stored;
        }
        if (stored.value !== undefined && sameTable(stored.value.day, en)) {
            return ok({ quiet: true, storedObservedAt: stored.value.observedAt });
        }
    }
    const codes = csvRequestCodes(tableCodes(en), tomorrow, tomorrow);
    const outcome = await resolvePublication(context, tomorrow, undefined, codes, { observedAt, en });
    if (!outcome.ok) {
        // With the English table valid from tomorrow, the only empty export is the CSV for tomorrow alone.
        return outcome.error.kind === 'empty_export' ? csvBehind(context, tomorrow) : outcome;
    }
    if (outcome.value === 'deadline') {
        return ok('deadline');
    }
    return ok({ quiet: false, committed: outcome.value === 'committed' || outcome.value === 'unchanged' });
}

/**
 * The longest a stored table's content can postdate its observation: the observation is taken before the English
 * request, and one request (spaced on the hourly path) can still answer a write NBG makes before it returns.
 */
const CONTENT_AFTER_OBSERVATION_MS = SYNC_REQUEST_SPACING_MS + SYNC_REQUEST_WORST_MS;

/**
 * A quiet run's count. It continues the stored window's count only when the table the run matched was observed more
 * than CONTENT_AFTER_OBSERVATION_MS before that window's run was due: the table's content then predates the due time,
 * so that run, which asked NBG at or after its due time, already compared against content at least as new. Any other
 * commit is one the count may predate (a run that committed a change and has not yet written its window, or whose
 * English request answered a write landing after the next run asked), and the count starts again at 1. This rests on
 * no event being processed before its due time; under that assumption every error the rule makes is a later stop,
 * never an earlier one. An event delivered early, which the early check admits up to MAX_EVENT_AGE_MS ahead for clock
 * skew, stays outside the bound.
 */
function quietCount(previous: WindowState | undefined, storedObservedAt: number | undefined): number {
    const counted =
        previous !== undefined &&
        storedObservedAt !== undefined &&
        storedObservedAt + CONTENT_AFTER_OBSERVATION_MS < previous.at;
    return counted ? previous.quietRuns + 1 : 1;
}

/**
 * The window state this run leaves, from the window the state holds for the same Tbilisi date: a quiet run counts
 * on (quietCount) and any other run sets the count to 0; once committed, the publication stays committed for the day.
 */
function nextWindow(current: MirrorState, seen: TomorrowSeen, today: CalendarDate, at: number): WindowState {
    const previous = current.window?.date === today ? current.window : undefined;
    const quietRuns = seen.quiet ? quietCount(previous, seen.storedObservedAt) : 0;
    const committed = seen.quiet || seen.committed || previous?.committed === true;
    return { date: today, committed, quietRuns, stopped: committed && quietRuns >= QUIET_RUNS_TO_STOP, at };
}

/**
 * One run of the publication window, from `state` as the run claimed it: tomorrow's English table, committing
 * tomorrow's publication when it appears or changes; then each unresolved date other than tomorrow, oldest first,
 * while the deadline allows. Then one state write records the window, stopped once tomorrow's publication is
 * committed and QUIET_RUNS_TO_STOP runs in a row saw no change, and, when the span covers tomorrow, the fresh-until
 * time due after the scheduled time, which makes the run `checked`. Both are computed from the state the write reads,
 * so a newer run's count is kept and an older run changes nothing. A failure in tomorrow's step, or the deadline
 * during it, writes neither.
 *
 * A failed retry still makes that write, as the hourly check records its fresh-until before its retries, and is
 * answered as `retryFailure`, which fails the run. A failed run does not count towards the quiet runs, so its quiet
 * sight leaves the stored window's count and time as they are; any other sight is recorded as on a successful run
 * (a commit, for one, starts the count again at 0, since the count is of runs that saw the committed publication
 * unchanged), which can only make the stop later.
 */
export async function runWindowCheck(
    context: SyncContext,
    state: MirrorState,
): Promise<Result<CheckOutcome, SyncFailure>> {
    const tomorrow = addDays(context.today, 1);
    const sighted = await checkTomorrow(context, state, tomorrow);
    if (!sighted.ok) {
        return sighted;
    }
    if (sighted.value === 'deadline') {
        return ok({ checked: false, deadline: true });
    }
    const seen = sighted.value;
    const retried = await retryOutside(context, state, { start: tomorrow, end: tomorrow });
    const retryFailure = retried.ok ? undefined : { retryFailure: retried.error };
    const scheduledAt = context.scheduledAt.getTime();
    const recorded = await applyToState(context, (current) => {
        const withWindow =
            retryFailure !== undefined && seen.quiet
                ? current
                : recordWindow(current, nextWindow(current, seen, context.today, scheduledAt));
        if (!inSpan(withWindow, tomorrow)) {
            return withWindow;
        }
        const freshUntil = freshUntilAfter(context.scheduledAt, stoppedWindowDate(withWindow));
        return recordFreshUntil(withWindow, freshUntil.getTime());
    });
    if (!recorded.ok) {
        return recorded;
    }
    if (recorded.value.kind === 'deadline') {
        return ok({ checked: false, deadline: true, ...retryFailure });
    }
    const checked = inSpan(recorded.value.state, tomorrow);
    return ok({ checked, deadline: retried.ok && retried.value === 'deadline', ...retryFailure });
}
