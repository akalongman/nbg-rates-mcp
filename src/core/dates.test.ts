import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
    MAX_HISTORY_DAYS,
    NBG_ARCHIVE_START,
    TBILISI_TIME_ZONE,
    addDays,
    calendarDateFromTimestamp,
    enumerateDays,
    isSettled,
    parseCalendarDate,
    rejectBeyondTomorrow,
    todayIn,
} from './dates.js';
import { date } from '../../test/helpers/values.js';

describe('parseCalendarDate', () => {
    it('accepts real calendar dates', () => {
        expect(parseCalendarDate('2026-10-08')).toEqual({ ok: true, value: '2026-10-08' });
        expect(parseCalendarDate('2024-02-29')).toEqual({ ok: true, value: '2024-02-29' });
    });

    it('rejects impossible dates that NBG would silently accept', () => {
        for (const value of ['2026-02-30', '2026-13-01', '2023-02-29', '2026-00-10', '2026-10-32']) {
            const result = parseCalendarDate(value);
            expect(result.ok, value).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe('invalid_date');
            }
        }
    });

    it('rejects anything that is not YYYY-MM-DD', () => {
        for (const value of ['bad', '2026-1-5', '08.10.2026', '2026-10-08T00:00:00Z', '']) {
            expect(parseCalendarDate(value).ok, value).toBe(false);
        }
    });

    it('exports the archive start as a valid date', () => {
        expect(parseCalendarDate(NBG_ARCHIVE_START).ok).toBe(true);
    });
});

describe('calendarDateFromTimestamp', () => {
    it('takes the first ten characters and ignores the process time zone', () => {
        expect(calendarDateFromTimestamp('2026-10-08T00:00:00.000Z')).toBe('2026-10-08');
        expect(calendarDateFromTimestamp('2026-10-07T17:01:12.447Z')).toBe('2026-10-07');
    });

    it('reads an NBG publication stamp as the Tbilisi day it shows (the Z suffix is not UTC)', () => {
        // Observed 2026-10-08: published at 13:00 UTC, stamped with the Tbilisi wall clock.
        expect(calendarDateFromTimestamp('2026-10-08T17:00:01.911Z')).toBe('2026-10-08');
    });

    it('throws on a malformed timestamp (programmer error: schema should have caught it)', () => {
        expect(() => calendarDateFromTimestamp('nope')).toThrow();
    });
});

describe('todayIn', () => {
    it('is already tomorrow in Tbilisi when it is late evening in UTC', () => {
        const now = new Date('2026-10-07T21:30:00Z');
        expect(todayIn(TBILISI_TIME_ZONE, now)).toBe('2026-10-08');
        expect(todayIn('UTC', now)).toBe('2026-10-07');
    });

    it('is still today in Tbilisi just before 20:00 UTC', () => {
        expect(todayIn(TBILISI_TIME_ZONE, new Date('2026-10-07T19:59:59Z'))).toBe('2026-10-07');
    });
});

describe('addDays', () => {
    it('crosses month and year boundaries', () => {
        expect(addDays(date('2026-01-31'), 1)).toBe('2026-02-01');
        expect(addDays(date('2026-12-31'), 1)).toBe('2027-01-01');
        expect(addDays(date('2024-03-01'), -1)).toBe('2024-02-29');
    });
});

describe('isSettled', () => {
    const today = date('2026-10-08');

    it('settles every day up to today, carried over or not', () => {
        expect(isSettled(date('2026-10-07'), date('2026-10-07'), today)).toBe(true);
        expect(isSettled(date('2026-10-05'), date('2026-10-03'), today)).toBe(true);
        expect(isSettled(date('2026-10-08'), date('2026-10-07'), today)).toBe(true);
    });

    it('settles tomorrow only once NBG published a rate valid from it', () => {
        expect(isSettled(date('2026-10-09'), date('2026-10-08'), today)).toBe(false);
        expect(isSettled(date('2026-10-09'), date('2026-10-09'), today)).toBe(true);
    });

    it('never settles a far-future date answered with the latest table', () => {
        expect(isSettled(date('2099-01-01'), date('2026-10-08'), today)).toBe(false);
    });
});

describe('rejectBeyondTomorrow', () => {
    const today = date('2026-10-08');

    it('lets today and tomorrow through', () => {
        expect(rejectBeyondTomorrow(date('2026-10-08'), today)).toEqual({ ok: true, value: '2026-10-08' });
        expect(rejectBeyondTomorrow(date('2026-10-09'), today)).toEqual({ ok: true, value: '2026-10-09' });
    });

    it('rejects the day after tomorrow and later as not published, without a latest date', () => {
        expect(rejectBeyondTomorrow(date('2099-01-01'), today)).toEqual({
            ok: false,
            error: { kind: 'rate_not_published', date: '2099-01-01', latestEffectiveDate: undefined },
        });
        expect(rejectBeyondTomorrow(date('2026-10-10'), today).ok).toBe(false);
    });
});

describe('enumerateDays', () => {
    it('includes both ends, in order, across a month boundary and a weekend', () => {
        const result = enumerateDays(date('2026-09-28'), date('2026-10-05'));
        expect(result).toEqual({
            ok: true,
            value: [
                '2026-09-28',
                '2026-09-29',
                '2026-09-30',
                '2026-10-01',
                '2026-10-02',
                '2026-10-03',
                '2026-10-04',
                '2026-10-05',
            ],
        });
    });

    it('accepts a single-day range', () => {
        expect(enumerateDays(date('2026-10-05'), date('2026-10-05'))).toEqual({ ok: true, value: ['2026-10-05'] });
    });

    it('rejects from after to', () => {
        const result = enumerateDays(date('2026-10-06'), date('2026-10-05'));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_date');
        }
    });

    it('accepts exactly 366 days and rejects 367', () => {
        const from = date('2024-01-01');
        expect(enumerateDays(from, addDays(from, MAX_HISTORY_DAYS - 1)).ok).toBe(true);
        const tooLong = enumerateDays(from, addDays(from, MAX_HISTORY_DAYS));
        expect(tooLong).toEqual({ ok: false, error: { kind: 'range_too_long', days: 367, max: 366 } });
    });

    it('property: any valid range yields to - from + 1 unique ordered days', () => {
        fc.assert(
            fc.property(
                fc.date({
                    min: new Date('2000-01-01T00:00:00Z'),
                    max: new Date('2030-12-31T00:00:00Z'),
                    noInvalidDate: true,
                }),
                fc.integer({ min: 0, max: MAX_HISTORY_DAYS - 1 }),
                (start, length) => {
                    const from = calendarDateFromTimestamp(start.toISOString());
                    const to = addDays(from, length);
                    const result = enumerateDays(from, to);
                    if (!result.ok) {
                        return false;
                    }
                    const days = result.value;
                    const sorted = [...days].sort();
                    return (
                        days.length === length + 1 &&
                        new Set(days).size === days.length &&
                        days.every((day, index) => day === sorted[index])
                    );
                },
            ),
        );
    });
});
