import { addDays, NBG_ARCHIVE_START, parseCalendarDate } from '../core/dates.js';
import { extendRowsStart, inSpan, type MirrorState } from '../core/mirror.js';
import {
    changedPublications,
    csvRequestCodes,
    exportRows,
    groupByValidFrom,
    sameTable,
    tableCodes,
} from '../core/mirror-publication.js';
import type { NbgCsvRow } from '../core/nbg-csv.js';
import {
    ARCHIVE_YEARS_PER_RUN,
    DAILY_REFETCH_FROM_HOUR,
    RECHECK_CYCLE_DAYS,
    RECHECK_SLICE_EVERY_HOURS,
    tbilisiClock,
} from '../core/sync-schedule.js';
import { err, ok, type CalendarDate, type Result } from '../core/types.js';
import { STORE_OPERATION_TIMEOUT_MS, type StoredRows, type StoredTables } from './mirror-store.js';
import {
    applyToState,
    resolvePublication,
    syncNbgFailure,
    type SyncContext,
    type SyncFailure,
    type SyncFetch,
} from './sync-publication.js';

/** The late-publication window's days before today; sync-check.ts and cache.ts keep the same value. */
const LATE_PUBLICATION_DAYS = 7;
/** The re-check reaches to the day before the hourly check's range. */
const RECHECK_LAST_DAY_OFFSET = LATE_PUBLICATION_DAYS + 1;
const MINUTES_PER_HOUR = 60;
const HOUR_MILLIS = 3_600_000;
const DAY_MILLIS = 86_400_000;

/** What one of the hourly kind's steps after its check did: its work, nothing because it was not due, or stopped. */
export type StepOutcome = 'done' | 'not_due' | 'deadline';

interface DateRange {
    readonly start: CalendarDate;
    readonly end: CalendarDate;
}

/** A fetch that ended the work: the deadline, or a failure. */
function stoppedBy(fetched: Exclude<SyncFetch<unknown>, { readonly kind: 'ok' }>): Result<'deadline', SyncFailure> {
    return fetched.kind === 'deadline' ? ok('deadline') : err(syncNbgFailure(fetched.error));
}

function later(left: CalendarDate, right: CalendarDate): CalendarDate {
    return left > right ? left : right;
}

function earlier(left: CalendarDate, right: CalendarDate): CalendarDate {
    return left < right ? left : right;
}

function yearOf(date: CalendarDate): number {
    return Number(date.slice(0, 4));
}

function monthOf(date: CalendarDate): number {
    return Number(date.slice(5, 7));
}

/** A valid `MM-DD` of a year from 0 to 9999, which every caller's year is: it comes from a CalendarDate. */
function dayOfYear(year: number, monthDay: string): CalendarDate {
    const parsed = parseCalendarDate(`${String(year).padStart(4, '0')}-${monthDay}`);
    if (!parsed.ok) {
        throw new Error(`no ${monthDay} in the year ${year}`);
    }
    return parsed.value;
}

/** NBG_ARCHIVE_START as a CalendarDate. */
const ARCHIVE_START = dayOfYear(Number(NBG_ARCHIVE_START.slice(0, 4)), NBG_ARCHIVE_START.slice(5));

/** Saves the next publication to refetch, unless a run has already finished today's refetch. */
function withRefetchCursor(state: MirrorState, today: CalendarDate, cursor: CalendarDate): MirrorState {
    const { day } = state.refetch;
    if (day !== undefined && day >= today) {
        return state;
    }
    return { ...state, refetch: { ...state.refetch, cursor } };
}

/** Records today's refetch as finished, with no cursor. */
function withRefetchDone(state: MirrorState, today: CalendarDate): MirrorState {
    const { day, cursor } = state.refetch;
    if (day !== undefined && day >= today && cursor === undefined) {
        return state;
    }
    return { ...state, refetch: { day: today } };
}

/**
 * Both tables of one stored publication again. When either differs from the stored one (write stamps aside), the
 * publication is resolved with both tables as fetched, observed before the first of the two requests, so only its CSV
 * is asked.
 */
async function refetchPublication(
    context: SyncContext,
    stored: StoredTables,
): Promise<Result<'done' | 'deadline', SyncFailure>> {
    const observedAt = context.now().getTime();
    const en = await context.fetchDay(stored.validFrom, 'en');
    if (en.kind !== 'ok') {
        return stoppedBy(en);
    }
    const ka = await context.fetchDay(stored.validFrom, 'ka');
    if (ka.kind !== 'ok') {
        return stoppedBy(ka);
    }
    if (sameTable(stored.en, en.value) && sameTable(stored.ka, ka.value)) {
        return ok('done');
    }
    const resolved = await resolvePublication(context, stored.validFrom, undefined, tableCodes(stored.en), {
        observedAt,
        en: en.value,
        ka: ka.value,
    });
    if (!resolved.ok) {
        return resolved;
    }
    return ok(resolved.value === 'deadline' ? 'deadline' : 'done');
}

/**
 * The daily refetch, from `state` as the run claimed it. Due with a span, from DAILY_REFETCH_FROM_HOUR Tbilisi time
 * on the scheduled time's date, while `refetch.day` is not that date. Refetches each stored publication from the later
 * of `today - LATE_PUBLICATION_DAYS` and the cursor to tomorrow, oldest first (refetchPublication), saving the next
 * one's date as the cursor after each but the last; then one write records the day, with no cursor. A failure or the
 * deadline leaves the cursor at the publication it stopped on, for the next hourly run.
 */
export async function runDailyRefetch(
    context: SyncContext,
    state: MirrorState,
): Promise<Result<StepOutcome, SyncFailure>> {
    const hour = Math.floor(tbilisiClock(context.scheduledAt).minuteOfDay / MINUTES_PER_HOUR);
    if (state.span === undefined || hour < DAILY_REFETCH_FROM_HOUR || state.refetch.day === context.today) {
        return ok('not_due');
    }
    if (!context.allows(STORE_OPERATION_TIMEOUT_MS)) {
        return ok('deadline');
    }
    const windowStart = addDays(context.today, -LATE_PUBLICATION_DAYS);
    const { cursor } = state.refetch;
    const start = cursor === undefined ? windowStart : later(windowStart, cursor);
    const stored = await context.store.readTablesBetween(start, addDays(context.today, 1), context.signal());
    if (!stored.ok) {
        return stored;
    }
    const publications = stored.value;
    for (const [index, publication] of publications.entries()) {
        const refetched = await refetchPublication(context, publication);
        if (!refetched.ok) {
            return refetched;
        }
        if (refetched.value === 'deadline') {
            return ok('deadline');
        }
        const next = publications[index + 1];
        if (next === undefined) {
            break;
        }
        const saved = await applyToState(context, (current) =>
            withRefetchCursor(current, context.today, next.validFrom),
        );
        if (!saved.ok) {
            return saved;
        }
        if (saved.value.kind === 'deadline') {
            return ok('deadline');
        }
    }
    const done = await applyToState(context, (current) => withRefetchDone(current, context.today));
    if (!done.ok) {
        return done;
    }
    return ok(done.value.kind === 'deadline' ? 'deadline' : 'done');
}

/** The year one re-check slice covers, in the cycle it belongs to. */
interface DueSlice {
    readonly year: number;
    /** Scheduled time of the run that started the cycle, epoch ms; this run's when the slice starts one. */
    readonly cycleStartedAt: number;
}

/**
 * The slice this run is due to re-check, from the state as the run claimed it. None without a span, or within
 * RECHECK_SLICE_EVERY_HOURS of the last slice. A cycle starts at the year of the rows' start (the span's without one)
 * when none ran, or when the last one has finished and started RECHECK_CYCLE_DAYS ago or more. A cycle has finished
 * once its next year is after the year of the re-check's last day; until then it runs on, however old.
 */
function dueSlice(context: SyncContext, state: MirrorState, lastDay: CalendarDate): DueSlice | undefined {
    const { span } = state;
    if (span === undefined) {
        return undefined;
    }
    const scheduledAt = context.scheduledAt.getTime();
    const { cycleStartedAt, lastSliceAt, nextYear } = state.recheck;
    if (lastSliceAt !== undefined && scheduledAt - lastSliceAt < RECHECK_SLICE_EVERY_HOURS * HOUR_MILLIS) {
        return undefined;
    }
    const firstYear = yearOf(state.rowsStart ?? span.start);
    if (cycleStartedAt === undefined || nextYear === undefined) {
        return { year: firstYear, cycleStartedAt: scheduledAt };
    }
    if (nextYear <= yearOf(lastDay)) {
        return { year: nextYear, cycleStartedAt };
    }
    if (scheduledAt - cycleStartedAt >= RECHECK_CYCLE_DAYS * DAY_MILLIS) {
        return { year: firstYear, cycleStartedAt: scheduledAt };
    }
    return undefined;
}

/** The year clipped to `[first, last]`, or undefined when nothing is left. */
function sliceRange(year: number, first: CalendarDate, last: CalendarDate): DateRange | undefined {
    if (year < yearOf(first) || year > yearOf(last)) {
        return undefined;
    }
    const start = year === yearOf(first) ? first : dayOfYear(year, '01-01');
    const end = year === yearOf(last) ? last : dayOfYear(year, '12-31');
    return start <= end ? { start, end } : undefined;
}

/** Rewrites (or removes) an archive publication's rows and deletes its past tables, while the deadline allows. */
async function replaceArchiveRows(
    context: SyncContext,
    validFrom: CalendarDate,
    rows: ReadonlyArray<NbgCsvRow> | undefined,
    observedAt: number,
): Promise<Result<'done' | 'deadline', SyncFailure>> {
    if (!context.allows(STORE_OPERATION_TIMEOUT_MS)) {
        return ok('deadline');
    }
    const replaced = await context.store.replaceArchivePublication(validFrom, rows, observedAt, context.signal());
    if (!replaced.ok) {
        return replaced;
    }
    if (replaced.value === 'replaced') {
        context.counts.committed += 1;
    }
    return ok('done');
}

/**
 * One CSV export over the range, naming the codes of the rows the mirror stores in it (AZN left out inside its filter
 * gap), compared with those stored rows. An empty export fails as empty_export, never read as removals. Each date
 * that changed, and each date of the claimed state's `unresolved` in the range, is then handled in date order: one in
 * the span or unresolved through resolvePublication with the export's rows for it (none when it lists none), one
 * before the span by rewriting its archive rows from the export (removing them when it lists none), observed before
 * the CSV request. A range with no stored row asks nothing.
 */
async function recheckRange(
    context: SyncContext,
    state: MirrorState,
    range: DateRange,
): Promise<Result<'done' | 'deadline', SyncFailure>> {
    if (!context.allows(STORE_OPERATION_TIMEOUT_MS)) {
        return ok('deadline');
    }
    const stored = await context.store.readRowsBetween(range.start, range.end, context.signal());
    if (!stored.ok) {
        return stored;
    }
    const storedCodes = new Set(stored.value.flatMap((item) => item.rows.map((row) => row.code)));
    const codes = csvRequestCodes([...storedCodes].sort(), range.start, range.end);
    if (codes.length === 0) {
        return ok('done');
    }
    const observedAt = context.now().getTime();
    const exported = await context.fetchRange(codes, range.start, range.end);
    if (exported.kind !== 'ok') {
        return stoppedBy(exported);
    }
    if (exported.value.length === 0) {
        return err({ kind: 'empty_export' });
    }
    const fetched = groupByValidFrom(exported.value);
    // The mirror's rows as the same request would list them: a stored row of a code not asked is not a removal.
    const held = groupByValidFrom(exportRows(stored.value, codes, range.start, range.end));
    const unresolved = state.unresolved.filter((date) => date >= range.start && date <= range.end);
    const dates = new Set([...changedPublications(fetched, held), ...unresolved]);
    for (const validFrom of [...dates].sort()) {
        const rows = fetched.get(validFrom);
        if (inSpan(state, validFrom) || unresolved.includes(validFrom)) {
            const resolved = await resolvePublication(context, validFrom, rows ?? [], codes);
            if (!resolved.ok) {
                return resolved;
            }
            if (resolved.value === 'deadline') {
                return ok('deadline');
            }
        } else {
            const replaced = await replaceArchiveRows(context, validFrom, rows, observedAt);
            if (!replaced.ok || replaced.value === 'deadline') {
                return replaced;
            }
        }
    }
    return ok('done');
}

/** Records the slice as done: the next year of its cycle, due RECHECK_SLICE_EVERY_HOURS after this run's time. */
function withSliceDone(state: MirrorState, slice: DueSlice, scheduledAt: number): MirrorState {
    const { lastSliceAt } = state.recheck;
    if (lastSliceAt !== undefined && lastSliceAt >= scheduledAt) {
        return state; // a run scheduled at the same time or later has recorded its slice
    }
    return {
        ...state,
        recheck: { cycleStartedAt: slice.cycleStartedAt, lastSliceAt: scheduledAt, nextYear: slice.year + 1 },
    };
}

/**
 * One slice of the weekly re-check, from `state` as the run claimed it (dueSlice): its year clipped to the stored rows
 * (from `rowsStart`, or the span's start without one, to the span's end) and to `today - RECHECK_LAST_DAY_OFFSET`,
 * re-checked by recheckRange. Every date in it is thus before the span or in it; a span ending earlier leaves the dates
 * after it to the check's catch-up. A slice clipped to nothing asks nothing. Only a slice done moves the cycle on to
 * its next year, so one the deadline or a failure stops is done again by the next hourly run.
 */
export async function runRecheckSlice(
    context: SyncContext,
    state: MirrorState,
): Promise<Result<StepOutcome, SyncFailure>> {
    const lastDay = addDays(context.today, -RECHECK_LAST_DAY_OFFSET);
    const slice = dueSlice(context, state, lastDay);
    if (slice === undefined || state.span === undefined) {
        return ok('not_due');
    }
    const range = sliceRange(slice.year, state.rowsStart ?? state.span.start, earlier(lastDay, state.span.end));
    if (range !== undefined) {
        const checked = await recheckRange(context, state, range);
        if (!checked.ok) {
            return checked;
        }
        if (checked.value === 'deadline') {
            return ok('deadline');
        }
    }
    const scheduledAt = context.scheduledAt.getTime();
    const recorded = await applyToState(context, (current) => withSliceDone(current, slice, scheduledAt));
    if (!recorded.ok) {
        return recorded;
    }
    return ok(recorded.value.kind === 'deadline' ? 'deadline' : 'done');
}

/** The fill's samples for a range inside one year: each month's first day, or the range's start when that is later. */
function monthSamples(range: DateRange): ReadonlyArray<CalendarDate> {
    const year = yearOf(range.start);
    const first = monthOf(range.start);
    return Array.from({ length: monthOf(range.end) - first + 1 }, (_, index) =>
        later(dayOfYear(year, `${String(first + index).padStart(2, '0')}-01`), range.start),
    );
}

/**
 * The archive rows of a range inside one year. The English tables of its month samples give the codes (their union),
 * one CSV export over the range names them (AZN left out inside its filter gap), and one write stores an item per
 * publication, observed before the CSV request; then the rows' start moves to the range's start. An empty export
 * fails as empty_export. A failure or the deadline anywhere before the state write leaves the rows' start as it was.
 */
async function fillYear(context: SyncContext, range: DateRange): Promise<Result<'done' | 'deadline', SyncFailure>> {
    const codes = new Set<string>();
    for (const sample of monthSamples(range)) {
        const table = await context.fetchDay(sample, 'en');
        if (table.kind !== 'ok') {
            return stoppedBy(table);
        }
        for (const code of tableCodes(table.value)) {
            codes.add(code);
        }
    }
    const observedAt = context.now().getTime();
    const requested = csvRequestCodes([...codes].sort(), range.start, range.end);
    const exported = await context.fetchRange(requested, range.start, range.end);
    if (exported.kind !== 'ok') {
        return stoppedBy(exported);
    }
    if (exported.value.length === 0) {
        return err({ kind: 'empty_export' });
    }
    // One item per publication: DynamoDB refuses a batch that writes one key twice.
    const items: ReadonlyArray<StoredRows> = [...groupByValidFrom(exported.value)]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([validFrom, rows]) => ({ validFrom, rows, observedAt }));
    if (!context.allows(STORE_OPERATION_TIMEOUT_MS)) {
        return ok('deadline');
    }
    const written = await context.store.writeArchiveRows(items, context.signal());
    if (!written.ok) {
        return written;
    }
    const moved = await applyToState(context, (current) => extendRowsStart(current, range.start));
    if (!moved.ok) {
        return moved;
    }
    return ok(moved.value.kind === 'deadline' ? 'deadline' : 'done');
}

/**
 * The archive rows' fill, from `state` as the run claimed it: up to ARCHIVE_YEARS_PER_RUN years, newest first, each
 * by fillYear. The first year's range ends the day before the rows' start (the span's start without one), each later
 * one the day before the previous one's start, and each starts at the later of its 1 January and NBG_ARCHIVE_START.
 * Complete once the rows start at NBG_ARCHIVE_START, which asks and writes nothing when the claimed state already
 * says so. Without a span there is nothing to fill back from: progress, with nothing asked or written. The fill never
 * moves fresh-until and adds nothing to the run's committed count.
 */
export async function runArchiveFill(
    context: SyncContext,
    state: MirrorState,
): Promise<Result<'progress' | 'complete' | 'deadline', SyncFailure>> {
    const { span } = state;
    if (span === undefined) {
        return ok('progress');
    }
    let rowsStart = state.rowsStart ?? span.start;
    for (let filled = 0; filled < ARCHIVE_YEARS_PER_RUN && rowsStart > ARCHIVE_START; filled += 1) {
        const end = addDays(rowsStart, -1);
        const range = { start: later(dayOfYear(yearOf(end), '01-01'), ARCHIVE_START), end };
        const year = await fillYear(context, range);
        if (!year.ok) {
            return year;
        }
        if (year.value === 'deadline') {
            return ok('deadline');
        }
        rowsStart = range.start;
    }
    return ok(rowsStart > ARCHIVE_START ? 'progress' : 'complete');
}
