import { TBILISI_TIME_ZONE, parseCalendarDate } from './dates.js';
import type { CalendarDate } from './types.js';

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

const MINUTE_MILLIS = 60_000;
const MINUTES_PER_HOUR = 60;
const FRIDAY = 5;
const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The h23 cycle pins midnight to 00; `hour12: false` has read it as 24 under some ICU versions. */
const TBILISI_CLOCK_FORMAT = new Intl.DateTimeFormat('en-US', {
    timeZone: TBILISI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

/** Uses formatToParts, as todayIn does, rather than a locale's string format. */
export function tbilisiClock(at: Date): TbilisiClock {
    const parts = TBILISI_CLOCK_FORMAT.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((candidate) => candidate.type === type)?.value ?? '';
    const parsed = parseCalendarDate(`${part('year')}-${part('month')}-${part('day')}`);
    const weekday = WEEKDAYS[part('weekday')];
    const time = CLOCK_TIME.exec(`${part('hour')}:${part('minute')}`);
    if (!parsed.ok || weekday === undefined || time === null) {
        throw new Error(`Intl produced an unexpected clock: ${parts.map((candidate) => candidate.value).join('')}`);
    }
    return { date: parsed.value, weekday, minuteOfDay: Number(time[1]) * MINUTES_PER_HOUR + Number(time[2]) };
}

function inWindow(clock: TbilisiClock): boolean {
    return (
        clock.weekday <= FRIDAY && clock.minuteOfDay >= WINDOW_FIRST_MINUTE && clock.minuteOfDay <= WINDOW_LAST_MINUTE
    );
}

function windowRunsOn(clock: TbilisiClock, windowStoppedOn: CalendarDate | undefined): boolean {
    return clock.weekday <= FRIDAY && clock.date !== windowStoppedOn;
}

/** Monday to Friday, 17:00 to 17:30 Tbilisi, both ends included, whether or not the window stopped that day. */
export function isWindowMinute(at: Date): boolean {
    return inWindow(tbilisiClock(at));
}

/**
 * The first hourly or window run due after `after`, skipping the window on its stopped date.
 * Due runs fall on whole minutes strictly after `after`. Stepping the instant by whole minutes keeps the Tbilisi
 * clock in step because Tbilisi has kept one UTC offset since 2005. Only the current day's window can come before
 * the next hour, so later days are never looked at.
 */
export function nextCheckDue(after: Date, windowStoppedOn: CalendarDate | undefined): Date {
    const firstMinute = (Math.floor(after.getTime() / MINUTE_MILLIS) + 1) * MINUTE_MILLIS;
    const clock = tbilisiClock(new Date(firstMinute));
    const minutesToHour = (MINUTES_PER_HOUR - (clock.minuteOfDay % MINUTES_PER_HOUR)) % MINUTES_PER_HOUR;
    const minutesToWindow =
        windowRunsOn(clock, windowStoppedOn) && clock.minuteOfDay <= WINDOW_LAST_MINUTE
            ? Math.max(0, WINDOW_FIRST_MINUTE - clock.minuteOfDay)
            : Number.POSITIVE_INFINITY;
    return new Date(firstMinute + Math.min(minutesToHour, minutesToWindow) * MINUTE_MILLIS);
}

/**
 * When a table stored by the check scheduled at `checkScheduledAt` stops being fresh: the next due check plus
 * WINDOW_MARGIN_MS when that check is a window minute the window still runs on, and plus HOURLY_MARGIN_MS otherwise.
 */
export function freshUntilAfter(checkScheduledAt: Date, windowStoppedOn: CalendarDate | undefined): Date {
    const due = nextCheckDue(checkScheduledAt, windowStoppedOn);
    const clock = tbilisiClock(due);
    const margin = inWindow(clock) && windowRunsOn(clock, windowStoppedOn) ? WINDOW_MARGIN_MS : HOURLY_MARGIN_MS;
    return new Date(due.getTime() + margin);
}
