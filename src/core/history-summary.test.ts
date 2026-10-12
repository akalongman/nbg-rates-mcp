import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { date } from '../../test/helpers/values.js';
import { addDays } from './dates.js';
import { summarizeHistory } from './history-summary.js';
import type { HistoryPoint } from './types.js';

function point(day: string, effective: string, rate: number): HistoryPoint {
    return { date: date(day), effectiveDate: date(effective), rate, carriedOver: effective < day };
}

describe('summarizeHistory', () => {
    it('reports first, last, exact change, extremes with their first dates and the calendar-day mean', () => {
        // USD 2026-10-02 to 2026-10-06: Saturday has its own table, Sunday and Monday carry it.
        const summary = summarizeHistory([
            point('2026-10-02', '2026-10-02', 2.6042),
            point('2026-10-03', '2026-10-03', 2.6039),
            point('2026-10-04', '2026-10-03', 2.6039),
            point('2026-10-05', '2026-10-03', 2.6039),
            point('2026-10-06', '2026-10-06', 2.6032),
        ]);
        // Sum 13.0191 over 5 days is 2.60382, half up at four decimals 2.6038; change -0.0010 arrives as -0.001.
        expect(summary).toEqual({
            first: 2.6042,
            last: 2.6032,
            change: -0.001,
            min: 2.6032,
            minDate: '2026-10-06',
            max: 2.6042,
            maxDate: '2026-10-02',
            average: 2.6038,
        });
    });

    it('names the first day an extreme occurs on, and rounds at the most precise rate', () => {
        const summary = summarizeHistory([
            point('2026-09-01', '2026-09-01', 0.00717),
            point('2026-09-02', '2026-09-02', 0.0071783),
            point('2026-09-03', '2026-09-03', 0.0071783),
            point('2026-09-04', '2026-09-04', 0.00717),
        ]);
        expect(summary).toMatchObject({ min: 0.00717, minDate: '2026-09-01', max: 0.0071783, maxDate: '2026-09-02' });
        // (0.00717 * 2 + 0.0071783 * 2) / 4 = 0.00717415, half up at seven decimals 0.0071742.
        expect(summary.average).toBe(0.0071742);
        expect(summary.change).toBe(0);
    });

    it('is bounded by the extremes and consistent for any series', () => {
        fc.assert(
            fc.property(
                fc.array(fc.integer({ min: 1, max: 99_999 }), { minLength: 1, maxLength: 366 }),
                (scaledRates) => {
                    const days = scaledRates.map((scaled, offset) =>
                        point(addDays(date('2026-01-01'), offset), addDays(date('2026-01-01'), offset), scaled / 10000),
                    );
                    const summary = summarizeHistory(days);
                    expect(summary.min).toBeLessThanOrEqual(summary.average);
                    expect(summary.average).toBeLessThanOrEqual(summary.max);
                    expect(summary.first).toBe(days[0]?.rate);
                    expect(summary.last).toBe(days[days.length - 1]?.rate);
                    expect(Math.abs(summary.change - (summary.last - summary.first))).toBeLessThan(0.00005);
                },
            ),
        );
    });

    it('throws on an empty series, which assembleHistory never produces', () => {
        expect(() => summarizeHistory([])).toThrow();
    });
});
