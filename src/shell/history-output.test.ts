import { describe, expect, it } from 'vitest';
import { code, date } from '../../test/helpers/values.js';
import { addDays } from '../core/dates.js';
import type { CalendarDate, HistoryPoint } from '../core/types.js';
import { historyOutput } from './history-output.js';

function point(day: string, effective: string, rate: number): HistoryPoint {
    return { date: date(day), effectiveDate: date(effective), rate, carriedOver: effective < day };
}

describe('historyOutput', () => {
    it('keeps date and rate on days with their own rate and adds the source on carried-over days', () => {
        // USD 2026-10-02 (Friday) to 2026-10-06 (Tuesday), as NBG published it: Saturday has its own table.
        const output = historyOutput({
            currency: code('USD'),
            from: date('2026-10-02'),
            to: date('2026-10-06'),
            days: [
                point('2026-10-02', '2026-10-02', 2.6042),
                point('2026-10-03', '2026-10-03', 2.6039),
                point('2026-10-04', '2026-10-03', 2.6039),
                point('2026-10-05', '2026-10-03', 2.6039),
                point('2026-10-06', '2026-10-06', 2.6032),
            ],
        });

        expect(JSON.stringify(output)).toBe(
            '{"currency":"USD","from":"2026-10-02","to":"2026-10-06","days":[' +
                '{"date":"2026-10-02","rate":2.6042},' +
                '{"date":"2026-10-03","rate":2.6039},' +
                '{"date":"2026-10-04","rate":2.6039,"effectiveDate":"2026-10-03","carriedOver":true},' +
                '{"date":"2026-10-05","rate":2.6039,"effectiveDate":"2026-10-03","carriedOver":true},' +
                '{"date":"2026-10-06","rate":2.6032}]}',
        );
    });

    it('names the publication in force on every day of a carried run longer than a weekend', () => {
        const output = historyOutput({
            currency: code('USD'),
            from: date('2025-12-31'),
            to: date('2026-01-03'),
            days: [
                point('2025-12-31', '2025-12-31', 2.7),
                point('2026-01-01', '2025-12-31', 2.7),
                point('2026-01-02', '2025-12-31', 2.7),
                point('2026-01-03', '2025-12-31', 2.7),
            ],
        });

        expect(output.days.map((day) => ('effectiveDate' in day ? day.effectiveDate : day.date))).toEqual([
            '2025-12-31',
            '2025-12-31',
            '2025-12-31',
            '2025-12-31',
        ]);
    });

    it('keeps a full year of an eight-decimal rate under 21,000 characters', () => {
        // Five days with their own rate, then two carried-over days, every week; 0.00012345 is a rate quoted per 10000.
        const first = date('2025-10-06');
        const days: HistoryPoint[] = [];
        let effective: CalendarDate = first;
        for (let index = 0; index < 366; index += 1) {
            const day = addDays(first, index);
            const carried = index % 7 >= 5;
            if (!carried) {
                effective = day;
            }
            days.push({ date: day, effectiveDate: effective, rate: 0.00012345, carriedOver: carried });
        }

        const text = JSON.stringify(
            historyOutput({ currency: code('XAU'), from: first, to: addDays(first, 365), days }),
        );

        expect(days.filter((day) => day.carriedOver)).toHaveLength(104);
        expect(text).not.toContain('"carriedOver":false');
        expect(text.length).toBeLessThanOrEqual(21_000);
    });
});
