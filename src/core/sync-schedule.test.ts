import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { addDays } from './dates.js';
import { freshUntilAfter, isWindowMinute, nextCheckDue, tbilisiClock } from './sync-schedule.js';
import type { CalendarDate } from './types.js';
import { date } from '../../test/helpers/values.js';

// Tbilisi is UTC+4 all year, so every instant below is written in UTC, four hours before the Tbilisi wall clock.

describe('tbilisiClock', () => {
    it('reads 13:00 UTC on Friday 2026-10-16 as 17:00 in Tbilisi', () => {
        expect(tbilisiClock(new Date('2026-10-16T13:00:00Z'))).toEqual({
            date: '2026-10-16',
            weekday: 5,
            minuteOfDay: 1020,
        });
    });

    it('is already Sunday 00:30 in Tbilisi at 20:30 UTC on Saturday', () => {
        expect(tbilisiClock(new Date('2026-10-17T20:30:00Z'))).toEqual({
            date: '2026-10-18',
            weekday: 7,
            minuteOfDay: 30,
        });
    });
});

describe('isWindowMinute', () => {
    it('includes both ends of the window on a Friday', () => {
        expect(isWindowMinute(new Date('2026-10-16T13:00:00Z'))).toBe(true);
        expect(isWindowMinute(new Date('2026-10-16T13:30:00Z'))).toBe(true);
    });

    it('excludes the minutes just before and just after the window', () => {
        expect(isWindowMinute(new Date('2026-10-16T12:59:00Z'))).toBe(false);
        expect(isWindowMinute(new Date('2026-10-16T13:31:00Z'))).toBe(false);
    });

    it('excludes Saturday', () => {
        expect(isWindowMinute(new Date('2026-10-17T13:05:00Z'))).toBe(false);
    });
});

describe('nextCheckDue', () => {
    it('is strictly after its input, also when the input is itself a due minute', () => {
        expect(nextCheckDue(new Date('2026-10-16T12:00:00Z'), undefined)).toEqual(new Date('2026-10-16T13:00:00Z'));
        expect(nextCheckDue(new Date('2026-10-16T13:00:00Z'), undefined)).toEqual(new Date('2026-10-16T13:01:00Z'));
    });

    it('rounds an input inside a minute up to the next whole minute', () => {
        expect(nextCheckDue(new Date('2026-10-16T13:04:30.250Z'), undefined)).toEqual(new Date('2026-10-16T13:05:00Z'));
        expect(nextCheckDue(new Date('2026-10-16T12:59:59.999Z'), undefined)).toEqual(new Date('2026-10-16T13:00:00Z'));
    });

    it('keeps the last window minute, 17:30, due', () => {
        expect(nextCheckDue(new Date('2026-10-16T13:29:00Z'), undefined)).toEqual(new Date('2026-10-16T13:30:00Z'));
    });

    it('falls back to the next hour after the window ends or once it stopped for the day', () => {
        expect(nextCheckDue(new Date('2026-10-16T13:30:00Z'), undefined)).toEqual(new Date('2026-10-16T14:00:00Z'));
        expect(nextCheckDue(new Date('2026-10-16T13:12:00Z'), date('2026-10-16'))).toEqual(
            new Date('2026-10-16T14:00:00Z'),
        );
    });

    it('property: the due check is the first whole minute after the input that is on the hour or an open window', () => {
        // The oracle walks minute by minute; a stopped date is drawn from the input's own Tbilisi day or the day before.
        const isDue = (minute: Date, windowStoppedOn: CalendarDate | undefined): boolean =>
            tbilisiClock(minute).minuteOfDay % 60 === 0 ||
            (isWindowMinute(minute) && tbilisiClock(minute).date !== windowStoppedOn);
        const anyInstant = fc.date({
            min: new Date('2026-01-01T00:00:00Z'),
            max: new Date('2027-12-31T00:00:00Z'),
            noInvalidDate: true,
        });
        // Four weeks of 15:30 to 18:30 Tbilisi, from Monday 2026-10-12, so the window and its edges are drawn often.
        const nearWindow = fc
            .tuple(fc.integer({ min: 0, max: 27 }), fc.integer({ min: 0, max: 3 * 3_600_000 }))
            .map(([day, offset]) => new Date(Date.parse('2026-10-12T11:30:00Z') + day * 86_400_000 + offset));
        fc.assert(
            fc.property(
                fc.oneof(anyInstant, nearWindow),
                fc.constantFrom('none', 'same day', 'day before'),
                (after, stopped) => {
                    const today = tbilisiClock(after).date;
                    const windowStoppedOn =
                        stopped === 'none' ? undefined : stopped === 'same day' ? today : addDays(today, -1);
                    let expected = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
                    while (!isDue(expected, windowStoppedOn)) {
                        expected = new Date(expected.getTime() + 60_000);
                    }
                    return nextCheckDue(after, windowStoppedOn).getTime() === expected.getTime();
                },
            ),
        );
    });
});

describe('freshUntilAfter', () => {
    const rows: ReadonlyArray<{
        readonly tbilisi: string;
        readonly scheduledAt: string;
        readonly stoppedOn: string | undefined;
        readonly freshUntil: string;
    }> = [
        {
            tbilisi: 'Fri 2026-10-16 16:00, window open: 17:02',
            scheduledAt: '2026-10-16T12:00:00Z',
            stoppedOn: undefined,
            freshUntil: '2026-10-16T13:02:00Z',
        },
        {
            tbilisi: 'Fri 2026-10-16 17:00, window open: 17:03',
            scheduledAt: '2026-10-16T13:00:00Z',
            stoppedOn: undefined,
            freshUntil: '2026-10-16T13:03:00Z',
        },
        {
            tbilisi: 'Fri 2026-10-16 17:12, window stopped that day: 18:05',
            scheduledAt: '2026-10-16T13:12:00Z',
            stoppedOn: '2026-10-16',
            freshUntil: '2026-10-16T14:05:00Z',
        },
        {
            tbilisi: 'Fri 2026-10-16 17:30, the last window minute: 18:05',
            scheduledAt: '2026-10-16T13:30:00Z',
            stoppedOn: undefined,
            freshUntil: '2026-10-16T14:05:00Z',
        },
        {
            tbilisi: 'Fri 2026-10-16 23:00, across midnight: Sat 00:05',
            scheduledAt: '2026-10-16T19:00:00Z',
            stoppedOn: undefined,
            freshUntil: '2026-10-16T20:05:00Z',
        },
        {
            tbilisi: 'Sat 2026-10-17 16:00, no window on a weekend: 17:05',
            scheduledAt: '2026-10-17T12:00:00Z',
            stoppedOn: undefined,
            freshUntil: '2026-10-17T13:05:00Z',
        },
        {
            tbilisi: 'Mon 2026-10-19 10:00, outside the window: 11:05',
            scheduledAt: '2026-10-19T06:00:00Z',
            stoppedOn: undefined,
            freshUntil: '2026-10-19T07:05:00Z',
        },
        {
            tbilisi: 'Wed 2026-10-14 16:00, a holiday the schedule does not know: 17:02',
            scheduledAt: '2026-10-14T12:00:00Z',
            stoppedOn: undefined,
            freshUntil: '2026-10-14T13:02:00Z',
        },
        {
            tbilisi: 'Fri 2026-10-16 16:00, window stopped the day before: 17:02',
            scheduledAt: '2026-10-16T12:00:00Z',
            stoppedOn: '2026-10-15',
            freshUntil: '2026-10-16T13:02:00Z',
        },
    ];

    it.each(rows)('$tbilisi', ({ scheduledAt, stoppedOn, freshUntil }) => {
        const windowStoppedOn = stoppedOn === undefined ? undefined : date(stoppedOn);
        expect(freshUntilAfter(new Date(scheduledAt), windowStoppedOn)).toEqual(new Date(freshUntil));
    });

    it('gives the 17:00 check the hourly margin on a day the window stopped', () => {
        // Fri 2026-10-16 16:00 with the window stopped that day: the 17:00 run is the hourly one, so 17:05.
        expect(freshUntilAfter(new Date('2026-10-16T12:00:00Z'), date('2026-10-16'))).toEqual(
            new Date('2026-10-16T13:05:00Z'),
        );
    });
});
