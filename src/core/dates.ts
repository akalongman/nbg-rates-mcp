import { err, ok, type CalendarDate, type RatesError, type Result } from './types.js';

export const TBILISI_TIME_ZONE = 'Asia/Tbilisi';
export const MAX_HISTORY_DAYS = 366;
/** The first day the NBG archive has any rate (USD only); 1995-10-13 and earlier are empty. Probed 2026-10-08. */
export const NBG_ARCHIVE_START = '1995-10-14';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MILLIS = 86_400_000;

function isRealDate(year: number, month: number, day: number): boolean {
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return (
        candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day
    );
}

export function parseCalendarDate(input: string): Result<CalendarDate, RatesError> {
    const match = DATE_PATTERN.exec(input);
    if (match === null) {
        return err({ kind: 'invalid_date', value: input, reason: 'expected YYYY-MM-DD' });
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isRealDate(year, month, day)) {
        return err({ kind: 'invalid_date', value: input, reason: 'not a real calendar date' });
    }
    return ok(input as CalendarDate);
}

/**
 * Takes the calendar date out of an NBG timestamp without going through a Date object.
 * NBG stamps Tbilisi wall-clock values with a "Z" suffix, so a Date object would shift the day.
 */
export function calendarDateFromTimestamp(timestamp: string): CalendarDate {
    const parsed = parseCalendarDate(timestamp.slice(0, 10));
    if (!parsed.ok) {
        throw new Error(`not a timestamp: ${timestamp}`);
    }
    return parsed.value;
}

/** Uses formatToParts, not a locale's string format: the en-CA output format has changed between ICU versions. */
export function todayIn(timeZone: string, now: Date): CalendarDate {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((candidate) => candidate.type === type)?.value ?? '';
    const formatted = `${part('year')}-${part('month')}-${part('day')}`;
    const parsed = parseCalendarDate(formatted);
    if (!parsed.ok) {
        throw new Error(`Intl produced an unexpected date: ${formatted}`);
    }
    return parsed.value;
}

function toUtcMillis(date: CalendarDate): number {
    const [year, month, day] = date.split('-').map(Number);
    return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
    const shifted = new Date(toUtcMillis(date) + days * DAY_MILLIS);
    return calendarDateFromTimestamp(shifted.toISOString());
}

export function enumerateDays(from: CalendarDate, to: CalendarDate): Result<ReadonlyArray<CalendarDate>, RatesError> {
    if (from > to) {
        return err({ kind: 'invalid_date', value: `${from}..${to}`, reason: 'from is after to' });
    }
    const days = Math.round((toUtcMillis(to) - toUtcMillis(from)) / DAY_MILLIS) + 1;
    if (days > MAX_HISTORY_DAYS) {
        return err({ kind: 'range_too_long', days, max: MAX_HISTORY_DAYS });
    }
    const result: CalendarDate[] = [];
    for (let offset = 0; offset < days; offset += 1) {
        result.push(addDays(from, offset));
    }
    return ok(result);
}

/**
 * The rate in force on `requested` can no longer change: the day is today or earlier (NBG publishes at most one
 * day ahead), or NBG already published a rate valid from it.
 */
export function isSettled(requested: CalendarDate, effective: CalendarDate, today: CalendarDate): boolean {
    return requested <= today || effective >= requested;
}

/** No rate for a date after tomorrow can exist yet, so it is rejected before any request. */
export function rejectBeyondTomorrow(date: CalendarDate, today: CalendarDate): Result<CalendarDate, RatesError> {
    if (date > addDays(today, 1)) {
        return err({ kind: 'rate_not_published', date, latestEffectiveDate: undefined });
    }
    return ok(date);
}
