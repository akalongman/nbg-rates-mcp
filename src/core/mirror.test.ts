import { describe, expect, it } from 'vitest';
import {
    EMPTY_MIRROR_STATE,
    claimRun,
    coversInterval,
    extendRowsStart,
    extendSpanEnd,
    inSpan,
    isFresh,
    isPastDate,
    markResolved,
    markUnresolved,
    parseMirrorState,
    recordFreshUntil,
    recordWindow,
    startSpan,
    type MirrorState,
    type WindowState,
} from './mirror.js';
import { date } from '../../test/helpers/values.js';

// Tbilisi is UTC+4 all year, so every instant below is written in UTC, four hours before the Tbilisi wall clock.

function windowOn(day: string, at: number): WindowState {
    return { date: date(day), committed: false, quietRuns: 0, stopped: false, at };
}

const spanned: MirrorState = {
    ...EMPTY_MIRROR_STATE,
    revision: 7,
    span: { start: date('2026-10-01'), end: date('2026-10-09') },
    rowsStart: date('2025-01-01'),
    unresolved: [date('2026-10-05')],
};

describe('claimRun', () => {
    const claimed: MirrorState = { ...EMPTY_MIRROR_STATE, lastRun: { hourly: 1000, window: 5000 } };

    it('refuses a scheduled time that is not later than the last claimed one of its kind', () => {
        expect(claimRun(claimed, 'hourly', 1000)).toBeUndefined();
        expect(claimRun(claimed, 'hourly', 999)).toBeUndefined();
    });

    it('claims a later scheduled time and leaves the other kind untouched', () => {
        expect(claimRun(claimed, 'hourly', 1001)?.lastRun).toEqual({ hourly: 1001, window: 5000 });
    });

    it('claims the first run of a kind', () => {
        expect(claimRun(EMPTY_MIRROR_STATE, 'window', 1)?.lastRun).toEqual({ window: 1 });
    });
});

describe('startSpan', () => {
    it('sets the span when none exists', () => {
        const span = { start: date('2026-10-01'), end: date('2026-10-09') };
        expect(startSpan(EMPTY_MIRROR_STATE, span).span).toEqual(span);
    });

    it('returns the input when a span exists', () => {
        expect(startSpan(spanned, { start: date('2026-10-05'), end: date('2026-10-12') })).toBe(spanned);
    });
});

describe('extendSpanEnd', () => {
    it('moves the end forward and keeps the start', () => {
        expect(extendSpanEnd(spanned, date('2026-10-12')).span).toEqual({
            start: date('2026-10-01'),
            end: date('2026-10-12'),
        });
    });

    it('returns the input for an earlier or equal end', () => {
        expect(extendSpanEnd(spanned, date('2026-10-08'))).toBe(spanned);
        expect(extendSpanEnd(spanned, date('2026-10-09'))).toBe(spanned);
    });

    it('returns the input when there is no span to extend', () => {
        expect(extendSpanEnd(EMPTY_MIRROR_STATE, date('2026-10-12'))).toBe(EMPTY_MIRROR_STATE);
    });
});

describe('extendRowsStart', () => {
    const rows: MirrorState = { ...EMPTY_MIRROR_STATE, rowsStart: date('2026-01-01') };

    it('moves the start backwards', () => {
        expect(extendRowsStart(rows, date('2025-01-01')).rowsStart).toBe('2025-01-01');
    });

    it('returns the input for a later or equal start', () => {
        expect(extendRowsStart(rows, date('2026-02-01'))).toBe(rows);
        expect(extendRowsStart(rows, date('2026-01-01'))).toBe(rows);
    });

    it('sets the start when none exists', () => {
        expect(extendRowsStart(EMPTY_MIRROR_STATE, date('2026-01-01')).rowsStart).toBe('2026-01-01');
    });
});

describe('recordFreshUntil', () => {
    const fresh: MirrorState = { ...EMPTY_MIRROR_STATE, freshUntil: 2000 };

    it('moves forward', () => {
        expect(recordFreshUntil(fresh, 3000).freshUntil).toBe(3000);
        expect(recordFreshUntil(EMPTY_MIRROR_STATE, 2000).freshUntil).toBe(2000);
    });

    it('returns the input for an earlier or equal time', () => {
        expect(recordFreshUntil(fresh, 1999)).toBe(fresh);
        expect(recordFreshUntil(fresh, 2000)).toBe(fresh);
    });
});

describe('recordWindow', () => {
    const stored = windowOn('2026-10-16', 2000);
    const windowed: MirrorState = { ...EMPTY_MIRROR_STATE, window: stored };

    it('records the first window', () => {
        expect(recordWindow(EMPTY_MIRROR_STATE, stored).window).toBe(stored);
    });

    it('replaces a window of an earlier date, whatever its time', () => {
        const next = windowOn('2026-10-19', 1000);
        expect(recordWindow(windowed, next).window).toBe(next);
    });

    it('replaces a window of the same date written by an earlier run', () => {
        const next = { ...windowOn('2026-10-16', 3000), quietRuns: 1 };
        expect(recordWindow(windowed, next).window).toBe(next);
    });

    it('returns the input for a window of the same date and time, a same-date earlier run or an earlier date', () => {
        expect(recordWindow(windowed, { ...windowOn('2026-10-16', 2000), quietRuns: 1 })).toBe(windowed);
        expect(recordWindow(windowed, windowOn('2026-10-16', 1999))).toBe(windowed);
        expect(recordWindow(windowed, windowOn('2026-10-15', 9000))).toBe(windowed);
    });
});

describe('markUnresolved and markResolved', () => {
    it('keep the unresolved dates a sorted set', () => {
        const once = markUnresolved(EMPTY_MIRROR_STATE, [date('2026-10-09'), date('2026-10-08')]);
        const twice = markUnresolved(once, [date('2026-10-08'), date('2026-10-07')]);
        expect(twice.unresolved).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
        expect(markResolved(twice, [date('2026-10-08')]).unresolved).toEqual(['2026-10-07', '2026-10-09']);
    });

    it('hold a date marked twice once', () => {
        const once = markUnresolved(EMPTY_MIRROR_STATE, [date('2026-10-08')]);
        expect(markUnresolved(once, [date('2026-10-08')]).unresolved).toEqual(['2026-10-08']);
        expect(markUnresolved(EMPTY_MIRROR_STATE, [date('2026-10-08'), date('2026-10-08')]).unresolved).toEqual([
            '2026-10-08',
        ]);
    });

    it('return the input when nothing changes', () => {
        const once = markUnresolved(EMPTY_MIRROR_STATE, [date('2026-10-08')]);
        expect(markUnresolved(once, [date('2026-10-08')])).toBe(once);
        expect(markResolved(once, [date('2026-10-09')])).toBe(once);
    });
});

describe('isFresh', () => {
    // Fresh until Fri 2026-10-16 17:02:00 Tbilisi.
    const fresh: MirrorState = { ...EMPTY_MIRROR_STATE, freshUntil: Date.parse('2026-10-16T13:02:00Z') };

    it('is fresh up to the last millisecond before fresh-until and stale from it', () => {
        expect(isFresh(fresh, new Date('2026-10-16T13:01:59.999Z'))).toBe(true);
        expect(isFresh(fresh, new Date('2026-10-16T13:02:00Z'))).toBe(false);
    });

    it('is stale without a fresh-until time', () => {
        expect(isFresh(EMPTY_MIRROR_STATE, new Date('2026-10-16T13:01:00Z'))).toBe(false);
    });
});

describe('inSpan and isPastDate', () => {
    it('inSpan includes both ends of the span, and an unresolved date inside it', () => {
        expect(inSpan(spanned, date('2026-10-01'))).toBe(true);
        expect(inSpan(spanned, date('2026-10-09'))).toBe(true);
        expect(inSpan(spanned, date('2026-10-05'))).toBe(true);
        expect(inSpan(spanned, date('2026-09-30'))).toBe(false);
        expect(inSpan(spanned, date('2026-10-10'))).toBe(false);
    });

    it('isPastDate runs from the rows start to the day before the span', () => {
        expect(isPastDate(spanned, date('2025-01-01'))).toBe(true);
        expect(isPastDate(spanned, date('2026-09-30'))).toBe(true);
        expect(isPastDate(spanned, date('2024-12-31'))).toBe(false);
        expect(isPastDate(spanned, date('2026-10-01'))).toBe(false);
    });

    it('are both false without a span', () => {
        const noSpan: MirrorState = { ...EMPTY_MIRROR_STATE, rowsStart: date('2025-01-01') };
        expect(inSpan(noSpan, date('2026-10-05'))).toBe(false);
        expect(isPastDate(noSpan, date('2025-06-01'))).toBe(false);
    });
});

describe('coversInterval', () => {
    it('covers an interval from the rows start to the end of the span', () => {
        expect(coversInterval(spanned, date('2025-01-01'), date('2026-10-09'))).toBe(true);
        expect(coversInterval(spanned, date('2024-12-31'), date('2026-10-09'))).toBe(false);
        expect(coversInterval(spanned, date('2025-01-01'), date('2026-10-10'))).toBe(false);
    });

    it('starts from the span start without a rows start', () => {
        const spanOnly: MirrorState = {
            ...EMPTY_MIRROR_STATE,
            span: { start: date('2026-10-01'), end: date('2026-10-09') },
        };
        expect(coversInterval(spanOnly, date('2026-10-01'), date('2026-10-09'))).toBe(true);
        expect(coversInterval(spanOnly, date('2026-09-30'), date('2026-10-09'))).toBe(false);
    });

    it('covers an interval reaching before the archive when the rows start with it', () => {
        const archive: MirrorState = { ...spanned, rowsStart: date('1995-10-14') };
        expect(coversInterval(archive, date('1995-09-13'), date('1995-10-20'))).toBe(true);
    });

    it('covers nothing without a span', () => {
        expect(coversInterval(EMPTY_MIRROR_STATE, date('2026-10-01'), date('2026-10-01'))).toBe(false);
    });
});

describe('transitions', () => {
    it('never touch the revision', () => {
        const moved = [
            claimRun(spanned, 'hourly', 1),
            extendSpanEnd(spanned, date('2026-10-12')),
            extendRowsStart(spanned, date('2024-01-01')),
            recordFreshUntil(spanned, 1),
            recordWindow(spanned, windowOn('2026-10-09', 1)),
            markUnresolved(spanned, [date('2026-10-06')]),
            markResolved(spanned, [date('2026-10-05')]),
        ];
        expect(moved.map((state) => state?.revision)).toEqual([7, 7, 7, 7, 7, 7, 7]);
    });
});

describe('parseMirrorState', () => {
    it('round-trips a state with every field set through JSON', () => {
        const full: MirrorState = {
            revision: 42,
            span: { start: date('2026-09-01'), end: date('2026-10-17') },
            rowsStart: date('1995-10-14'),
            freshUntil: Date.parse('2026-10-16T13:02:00Z'),
            window: {
                date: date('2026-10-16'),
                committed: true,
                quietRuns: 3,
                stopped: false,
                at: Date.parse('2026-10-16T13:05:00Z'),
            },
            unresolved: [date('2026-10-08'), date('2026-10-09')],
            lastRun: { hourly: Date.parse('2026-10-16T12:00:00Z'), window: Date.parse('2026-10-16T13:05:00Z') },
            refetch: { day: date('2026-10-16'), cursor: date('2026-10-12') },
            recheck: {
                cycleStartedAt: Date.parse('2026-10-12T00:00:00Z'),
                lastSliceAt: Date.parse('2026-10-16T05:00:00Z'),
                nextYear: 2003,
            },
        };
        expect(parseMirrorState(JSON.parse(JSON.stringify(full)))).toEqual({ ok: true, value: full });
    });

    it('round-trips the empty state', () => {
        expect(parseMirrorState(JSON.parse(JSON.stringify(EMPTY_MIRROR_STATE)))).toEqual({
            ok: true,
            value: EMPTY_MIRROR_STATE,
        });
    });

    it('rejects a revision that is not a number', () => {
        const result = parseMirrorState({ revision: 'x' });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('revision');
        }
    });

    it('rejects a date that is not a real calendar date', () => {
        const result = parseMirrorState({ ...EMPTY_MIRROR_STATE, rowsStart: '2026-02-30' });
        expect(result).toEqual({ ok: false, error: 'rowsStart: not a real YYYY-MM-DD calendar date' });
    });
});
