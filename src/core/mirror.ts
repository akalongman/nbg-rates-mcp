import * as z from 'zod';
import { parseCurrencyCode } from './currency-code.js';
import { NBG_ARCHIVE_START, parseCalendarDate } from './dates.js';
import type { SyncKind } from './sync-schedule.js';
import { err, ok, type CalendarDate, type Result } from './types.js';

export interface MirrorSpan {
    readonly start: CalendarDate;
    readonly end: CalendarDate;
}

export interface WindowState {
    readonly date: CalendarDate;
    readonly committed: boolean;
    readonly quietRuns: number;
    readonly stopped: boolean;
    /** Scheduled time of the run that wrote it, epoch ms. */
    readonly at: number;
}

/** The archive rows' fill's progress through the samples of the range it is filling, kept between runs. */
export interface FillProgress {
    /** The last day of the range being filled: the day before rowsStart (the span's start without one) when recorded. */
    readonly rangeEnd: CalendarDate;
    /** Every sample of the range on or before this date is taken; the samples are complete when it equals rangeEnd. */
    readonly sampledThrough: CalendarDate;
    /** The union of the taken samples' currency codes, sorted, without duplicates. */
    readonly codes: ReadonlyArray<string>;
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
    readonly fill?: FillProgress;
}

export const EMPTY_MIRROR_STATE: MirrorState = { revision: 0, unresolved: [], lastRun: {}, refetch: {}, recheck: {} };

const calendarDate = z.string().transform((value, context) => {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        context.addIssue('not a real YYYY-MM-DD calendar date');
        return z.NEVER;
    }
    return parsed.value;
});
/** An uppercase three-letter code as parseCurrencyCode accepts it, unchanged by its normalisation. */
const currencyCode = z.string().refine((value) => {
    const parsed = parseCurrencyCode(value);
    return parsed.ok && parsed.value === value;
}, 'not a currency code');
const epochMillis = z.int().nonnegative();
const count = z.int().nonnegative();

const mirrorStateSchema = z.object({
    revision: count,
    span: z.object({ start: calendarDate, end: calendarDate }).exactOptional(),
    rowsStart: calendarDate.exactOptional(),
    freshUntil: epochMillis.exactOptional(),
    window: z
        .object({ date: calendarDate, committed: z.boolean(), quietRuns: count, stopped: z.boolean(), at: epochMillis })
        .exactOptional(),
    unresolved: z.array(calendarDate),
    lastRun: z.object({
        hourly: epochMillis.exactOptional(),
        window: epochMillis.exactOptional(),
    } satisfies Record<SyncKind, unknown>),
    refetch: z.object({ day: calendarDate.exactOptional(), cursor: calendarDate.exactOptional() }),
    recheck: z.object({
        cycleStartedAt: epochMillis.exactOptional(),
        lastSliceAt: epochMillis.exactOptional(),
        nextYear: z.int().exactOptional(),
    }),
    fill: z
        .object({
            rangeEnd: calendarDate,
            sampledThrough: calendarDate,
            codes: z.array(currencyCode).min(1, 'no currency code'), // a taken sample adds its table's codes
        })
        .refine((fill) => fill.sampledThrough <= fill.rangeEnd, {
            message: 'after the range end',
            path: ['sampledThrough'],
        })
        .exactOptional(),
});

export function parseMirrorState(json: unknown): Result<MirrorState, string> {
    const parsed = mirrorStateSchema.safeParse(json);
    if (!parsed.success) {
        return err(
            parsed.error.issues
                .slice(0, 3)
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('; '),
        );
    }
    return ok(parsed.data);
}

// Forward-only transitions: each returns its input object unchanged when it would move a field back.
// None touches `revision`, which the store bumps on every write.

/** Undefined when a run of this kind scheduled at the same time or later has already claimed the state. */
export function claimRun(state: MirrorState, kind: SyncKind, scheduledAt: number): MirrorState | undefined {
    const last = state.lastRun[kind];
    if (last !== undefined && scheduledAt <= last) {
        return undefined;
    }
    return { ...state, lastRun: { ...state.lastRun, [kind]: scheduledAt } };
}

export function startSpan(state: MirrorState, span: MirrorSpan): MirrorState {
    return state.span === undefined ? { ...state, span } : state;
}

export function extendSpanEnd(state: MirrorState, end: CalendarDate): MirrorState {
    const { span } = state;
    if (span === undefined || end <= span.end) {
        return state;
    }
    return { ...state, span: { start: span.start, end } };
}

/** Moves the rows' start back; the fill's progress goes with it once the new start reaches its range's end. */
export function extendRowsStart(state: MirrorState, start: CalendarDate): MirrorState {
    if (state.rowsStart !== undefined && start >= state.rowsStart) {
        return state;
    }
    const { fill, ...rest } = state;
    return fill !== undefined && start <= fill.rangeEnd
        ? { ...rest, rowsStart: start }
        : { ...state, rowsStart: start };
}

/** The rows from `rowsStart` cover the range ending on `rangeEnd`. */
function isFilled(state: MirrorState, rangeEnd: CalendarDate): boolean {
    return state.rowsStart !== undefined && state.rowsStart <= rangeEnd;
}

function sortedCodes(codes: Iterable<string>): ReadonlyArray<string> {
    return [...new Set(codes)].sort();
}

/**
 * Keeps the fill's progress through its range's samples. Progress for a range the rows already cover is ignored. For
 * the stored range, only a later `sampledThrough` is taken, with the codes of both; progress for another range replaces
 * the stored one only when that range is filled, or when none is stored. The codes are kept sorted and unique.
 */
export function recordFillProgress(state: MirrorState, progress: FillProgress): MirrorState {
    if (isFilled(state, progress.rangeEnd)) {
        return state;
    }
    const stored = state.fill;
    if (stored === undefined || isFilled(state, stored.rangeEnd)) {
        return { ...state, fill: { ...progress, codes: sortedCodes(progress.codes) } };
    }
    if (progress.rangeEnd !== stored.rangeEnd || progress.sampledThrough <= stored.sampledThrough) {
        return state;
    }
    return {
        ...state,
        fill: {
            rangeEnd: stored.rangeEnd,
            sampledThrough: progress.sampledThrough,
            codes: sortedCodes([...stored.codes, ...progress.codes]),
        },
    };
}

export function recordFreshUntil(state: MirrorState, freshUntil: number): MirrorState {
    if (state.freshUntil !== undefined && freshUntil <= state.freshUntil) {
        return state;
    }
    return { ...state, freshUntil };
}

/** A later date replaces the stored window; on the same date only a later scheduled run does. */
export function recordWindow(state: MirrorState, window: WindowState): MirrorState {
    const stored = state.window;
    const newer =
        stored === undefined || window.date > stored.date || (window.date === stored.date && window.at > stored.at);
    return newer ? { ...state, window } : state;
}

/** Keeps `unresolved` a sorted set; YYYY-MM-DD strings sort chronologically. */
export function markUnresolved(state: MirrorState, dates: ReadonlyArray<CalendarDate>): MirrorState {
    const known = new Set(state.unresolved);
    if (dates.every((date) => known.has(date))) {
        return state;
    }
    return { ...state, unresolved: [...new Set([...state.unresolved, ...dates])].sort() };
}

export function markResolved(state: MirrorState, dates: ReadonlyArray<CalendarDate>): MirrorState {
    const resolved = new Set(dates);
    const remaining = state.unresolved.filter((date) => !resolved.has(date));
    return remaining.length === state.unresolved.length ? state : { ...state, unresolved: remaining };
}

export function isFresh(state: MirrorState, now: Date): boolean {
    return state.freshUntil !== undefined && now.getTime() < state.freshUntil;
}

/** Inside the span: both tables and the rows are stored. */
export function inSpan(state: MirrorState, date: CalendarDate): boolean {
    const { span } = state;
    return span !== undefined && span.start <= date && date <= span.end;
}

/** Between the rows' start and the span: covered when the past table is stored. */
export function isPastDate(state: MirrorState, date: CalendarDate): boolean {
    const { span, rowsStart } = state;
    return span !== undefined && rowsStart !== undefined && rowsStart <= date && date < span.start;
}

/** A date in `unresolved` lies in [start, end]: there the mirror may not hold what NBG answers now. */
export function hasUnresolvedBetween(state: MirrorState, start: CalendarDate, end: CalendarDate): boolean {
    return state.unresolved.some((date) => start <= date && date <= end);
}

/**
 * The rows from `start` to `end` are all stored and none is unresolved: the interval lies between the rows' start
 * (the span's start without one) and the span's end, and holds no unresolved date. A start before the rows' start is
 * covered when the rows start at NBG_ARCHIVE_START, because NBG has nothing earlier.
 */
export function coversInterval(state: MirrorState, start: CalendarDate, end: CalendarDate): boolean {
    const { span } = state;
    if (span === undefined || end > span.end || hasUnresolvedBetween(state, start, end)) {
        return false;
    }
    const first = state.rowsStart ?? span.start;
    return start >= first || first === NBG_ARCHIVE_START;
}
