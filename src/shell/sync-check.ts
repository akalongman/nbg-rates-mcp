import { addDays } from '../core/dates.js';
import { extendSpanEnd, recordFreshUntil, startSpan, type MirrorSpan, type MirrorState } from '../core/mirror.js';
import {
    changedPublications,
    csvRequestCodes,
    exportRows,
    groupByValidFrom,
    tableCodes,
} from '../core/mirror-publication.js';
import { freshUntilAfter } from '../core/sync-schedule.js';
import { err, ok, type CalendarDate, type CurrencyCode, type Result } from '../core/types.js';
import {
    applyToState,
    resolvePublication,
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

function stoppedWindowDate(state: MirrorState): CalendarDate | undefined {
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
 * One CSV export over the chunk, compared with the mirror's rows for the same chunk and codes; then each date that
 * changed, each date already unresolved in the chunk, and with `everyPublication` each date in the export, is
 * resolved in date order.
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
    const dates = new Set([
        ...changedPublications(fetched, held),
        ...inChunk,
        ...(everyPublication ? fetched.keys() : []),
    ]);
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
 * resolved, and the span starts at the earliest one and ends at tomorrow only when all of them agree.
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
