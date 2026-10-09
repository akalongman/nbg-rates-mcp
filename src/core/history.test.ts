import { describe, expect, it } from 'vitest';
import { code, date } from '../../test/helpers/values.js';
import { enumerateDays } from './dates.js';
import { assembleHistory } from './history.js';
import { NBG_CSV_HEADER, parseNbgCsv, type NbgCsvRow } from './nbg-csv.js';
import type { CalendarDate } from './types.js';

const OCTOBER_2026 = [
    NBG_CSV_HEADER,
    'USD,1,2.6021,0.0004,აშშ დოლარი,10/7/2026,10/8/2026',
    'USD,1,2.6025,0.0007,აშშ დოლარი,10/6/2026,10/7/2026',
    'USD,1,2.6032,0.0007,აშშ დოლარი,10/5/2026,10/6/2026',
    'USD,1,2.6039,0.0003,აშშ დოლარი,10/2/2026,10/3/2026',
    'USD,1,2.6042,0.0005,აშშ დოლარი,10/1/2026,10/2/2026',
    'USD,1,2.6047,0.0004,აშშ დოლარი,9/30/2026,10/1/2026',
].join('\n');

/** AMD rows for the same publications, so OCTOBER_2026 can serve as the USD publication calendar. */
const AMD_OCTOBER_2026 = [
    'AMD,1000,7.1748,0.0035,სომხური დრამი,10/7/2026,10/8/2026',
    'AMD,1000,7.1783,0.0004,სომხური დრამი,10/6/2026,10/7/2026',
    'AMD,1000,7.1779,0.0017,სომხური დრამი,10/5/2026,10/6/2026',
    'AMD,1000,7.1762,0.0120,სომხური დრამი,10/2/2026,10/3/2026',
    'AMD,1000,7.1642,0.0038,სომხური დრამი,10/1/2026,10/2/2026',
    'AMD,1000,7.1680,0.0013,სომხური დრამი,9/30/2026,10/1/2026',
];

/**
 * The CSV export's first EUR row is valid from 2001-05-05, while USD has a row for every earlier day.
 * Copied from a live answer for EUR and USD, 2001-05-01 to 2001-05-07 (probed 2026-10-09).
 */
const EUR_FIRST_QUOTED = [
    NBG_CSV_HEADER,
    'EUR,1,1.8408,0.0000,ევრო,5/7/2001,5/7/2001',
    'USD,1,2.0635,0.0000,აშშ დოლარი,5/7/2001,5/7/2001',
    'EUR,1,1.8408,0.0000,ევრო,5/6/2001,5/6/2001',
    'USD,1,2.0635,0.0000,აშშ დოლარი,5/6/2001,5/6/2001',
    'EUR,1,1.8408,0.0000,ევრო,5/5/2001,5/5/2001',
    'USD,1,2.0635,0.0000,აშშ დოლარი,5/5/2001,5/5/2001',
    'USD,1,2.0550,0.0000,აშშ დოლარი,5/4/2001,5/4/2001',
    'USD,1,2.0610,0.0000,აშშ დოლარი,5/3/2001,5/3/2001',
    'USD,1,2.0610,0.0000,აშშ დოლარი,5/2/2001,5/2/2001',
    'USD,1,2.0500,0.0000,აშშ დოლარი,5/1/2001,5/1/2001',
].join('\n');

/** Bulgaria adopted the euro on 2026-01-01: the publication valid from 2025-12-31 is the last one with BGN. */
const BGN_EURO_CHANGEOVER = [
    NBG_CSV_HEADER,
    'USD,1,2.6968,0.0005,აშშ დოლარი,1/5/2026,1/6/2026',
    'USD,1,2.6963,0.0012,აშშ დოლარი,12/31/2025,1/1/2026',
    'BGN,1,1.6227,0.0000,ბულგარული ლევი,12/30/2025,12/31/2025',
    'USD,1,2.6951,0.0004,აშშ დოლარი,12/30/2025,12/31/2025',
    'BGN,1,1.6227,0.0003,ბულგარული ლევი,12/29/2025,12/30/2025',
    'USD,1,2.6955,0.0004,აშშ დოლარი,12/29/2025,12/30/2025',
].join('\n');

/** Before the September 2021 changeover NBG stored a row for every calendar day, Sunday 5 September included. */
const CHANGEOVER_2021 = [
    NBG_CSV_HEADER,
    'USD,1,3.1132,0.0064,აშშ დოლარი,9/6/2021,9/7/2021',
    'USD,1,3.1196,0.0000,აშშ დოლარი,9/6/2021,9/6/2021',
    'USD,1,3.1196,0.0000,აშშ დოლარი,9/5/2021,9/5/2021',
    'USD,1,3.1196,0.0013,აშშ დოლარი,9/3/2021,9/4/2021',
    'USD,1,3.1183,0.0035,აშშ დოლარი,9/2/2021,9/3/2021',
].join('\n');

/**
 * NBG published no table for Saturday 2026-09-26 on Friday; on Monday 2026-09-28 at 17:01 it published one valid
 * from that Saturday, after the day itself. Copied from test/fixtures/csv-USD.csv.
 */
const LATE_SATURDAY_2026 = [
    NBG_CSV_HEADER,
    'USD,1,2.6051,0.0004,აშშ დოლარი,9/29/2026,9/30/2026',
    'USD,1,2.6055,0.0025,აშშ დოლარი,9/28/2026,9/29/2026',
    'USD,1,2.6080,0.0138,აშშ დოლარი,9/28/2026,9/26/2026',
    'USD,1,2.6218,0.0011,აშშ დოლარი,9/24/2026,9/25/2026',
    'USD,1,2.6229,0.0125,აშშ დოლარი,9/23/2026,9/24/2026',
].join('\n');

function rows(text: string): ReadonlyArray<NbgCsvRow> {
    const parsed = parseNbgCsv(text);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.error));
    }
    return parsed.value;
}

function days(from: string, to: string): ReadonlyArray<CalendarDate> {
    const result = enumerateDays(date(from), date(to));
    if (!result.ok) {
        throw new Error('range');
    }
    return result.value;
}

const TODAY = date('2026-10-08');

describe('assembleHistory', () => {
    it('returns one point per calendar day, carrying Saturday over to Sunday and Monday', () => {
        const result = assembleHistory(code('USD'), days('2026-10-01', '2026-10-07'), rows(OCTOBER_2026), TODAY);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toMatchObject({ currency: 'USD', from: '2026-10-01', to: '2026-10-07' });
            expect(result.value.days).toEqual([
                { date: '2026-10-01', effectiveDate: '2026-10-01', rate: 2.6047, carriedOver: false },
                { date: '2026-10-02', effectiveDate: '2026-10-02', rate: 2.6042, carriedOver: false },
                { date: '2026-10-03', effectiveDate: '2026-10-03', rate: 2.6039, carriedOver: false },
                { date: '2026-10-04', effectiveDate: '2026-10-03', rate: 2.6039, carriedOver: true },
                { date: '2026-10-05', effectiveDate: '2026-10-03', rate: 2.6039, carriedOver: true },
                { date: '2026-10-06', effectiveDate: '2026-10-06', rate: 2.6032, carriedOver: false },
                { date: '2026-10-07', effectiveDate: '2026-10-07', rate: 2.6025, carriedOver: false },
            ]);
        }
    });

    it('finds the rate in force on a range that starts on a carried-over day', () => {
        const result = assembleHistory(code('USD'), days('2026-10-04', '2026-10-06'), rows(OCTOBER_2026), TODAY);
        expect(result.ok && result.value.days[0]).toEqual({
            date: '2026-10-04',
            effectiveDate: '2026-10-03',
            rate: 2.6039,
            carriedOver: true,
        });
    });

    it('names the New Year publication on every day of the five-day gap after it, not only over a weekend', () => {
        // In BGN_EURO_CHANGEOVER the USD publication valid from 2026-01-01 stays in force until 2026-01-06.
        const result = assembleHistory(code('USD'), days('2025-12-31', '2026-01-06'), rows(BGN_EURO_CHANGEOVER), TODAY);
        expect(result.ok && result.value.days).toEqual([
            { date: '2025-12-31', effectiveDate: '2025-12-31', rate: 2.6951, carriedOver: false },
            { date: '2026-01-01', effectiveDate: '2026-01-01', rate: 2.6963, carriedOver: false },
            { date: '2026-01-02', effectiveDate: '2026-01-01', rate: 2.6963, carriedOver: true },
            { date: '2026-01-03', effectiveDate: '2026-01-01', rate: 2.6963, carriedOver: true },
            { date: '2026-01-04', effectiveDate: '2026-01-01', rate: 2.6963, carriedOver: true },
            { date: '2026-01-05', effectiveDate: '2026-01-01', rate: 2.6963, carriedOver: true },
            { date: '2026-01-06', effectiveDate: '2026-01-06', rate: 2.6968, carriedOver: false },
        ]);
    });

    it('uses a table NBG published after the day it is valid from', () => {
        const result = assembleHistory(code('USD'), days('2026-09-24', '2026-09-30'), rows(LATE_SATURDAY_2026), TODAY);
        expect(result.ok && result.value.days).toEqual([
            { date: '2026-09-24', effectiveDate: '2026-09-24', rate: 2.6229, carriedOver: false },
            { date: '2026-09-25', effectiveDate: '2026-09-25', rate: 2.6218, carriedOver: false },
            { date: '2026-09-26', effectiveDate: '2026-09-26', rate: 2.608, carriedOver: false },
            { date: '2026-09-27', effectiveDate: '2026-09-26', rate: 2.608, carriedOver: true },
            { date: '2026-09-28', effectiveDate: '2026-09-26', rate: 2.608, carriedOver: true },
            { date: '2026-09-29', effectiveDate: '2026-09-29', rate: 2.6055, carriedOver: false },
            { date: '2026-09-30', effectiveDate: '2026-09-30', rate: 2.6051, carriedOver: false },
        ]);
    });

    it('carries nothing over before the September 2021 changeover', () => {
        const result = assembleHistory(code('USD'), days('2021-09-03', '2021-09-07'), rows(CHANGEOVER_2021), TODAY);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.days.map((point) => point.effectiveDate)).toEqual([
                '2021-09-03',
                '2021-09-04',
                '2021-09-05',
                '2021-09-06',
                '2021-09-07',
            ]);
            expect(result.value.days.some((point) => point.carriedOver)).toBe(false);
        }
    });

    it('includes tomorrow once NBG published it', () => {
        const result = assembleHistory(
            code('USD'),
            days('2026-10-07', '2026-10-08'),
            rows(OCTOBER_2026),
            date('2026-10-07'),
        );
        expect(result.ok && result.value.days[1]).toMatchObject({ date: '2026-10-08', effectiveDate: '2026-10-08' });
    });

    it('fails on an unpublished tail instead of repeating the last rate', () => {
        const withoutTomorrow = OCTOBER_2026.split('\n')
            .filter((line) => !line.endsWith('10/8/2026'))
            .join('\n');
        const result = assembleHistory(
            code('USD'),
            days('2026-10-07', '2026-10-08'),
            rows(withoutTomorrow),
            date('2026-10-07'),
        );
        expect(result).toEqual({
            ok: false,
            error: { kind: 'rate_not_published', date: '2026-10-08', latestEffectiveDate: '2026-10-07' },
        });
    });

    it('fails with no_data_for_date on a day before the first row in force', () => {
        const result = assembleHistory(code('USD'), days('2026-09-29', '2026-10-02'), rows(OCTOBER_2026), TODAY);
        expect(result).toEqual({
            ok: false,
            error: { kind: 'no_data_for_date', date: '2026-09-29', currency: 'USD' },
        });
    });

    it('fails with unknown_currency when the calendar has publications but none quotes the code', () => {
        expect(assembleHistory(code('XXX'), days('2026-10-01', '2026-10-02'), rows(OCTOBER_2026), TODAY)).toEqual({
            ok: false,
            error: { kind: 'unknown_currency', code: 'XXX' },
        });
    });

    it('fails with no_data_for_date when the export has no publication at all (before the archive)', () => {
        expect(assembleHistory(code('USD'), days('1995-10-01', '1995-10-13'), rows(NBG_CSV_HEADER), TODAY)).toEqual({
            ok: false,
            error: { kind: 'no_data_for_date', date: '1995-10-01', currency: 'USD' },
        });
    });

    it('starts at the first publication that quotes a currency, failing a range that begins earlier', () => {
        const eur = rows(EUR_FIRST_QUOTED);
        const firstDays = assembleHistory(code('EUR'), days('2001-05-05', '2001-05-07'), eur, TODAY);
        expect(firstDays.ok && firstDays.value.days.map((point) => point.rate)).toEqual([1.8408, 1.8408, 1.8408]);
        expect(assembleHistory(code('EUR'), days('2001-05-03', '2001-05-06'), eur, TODAY)).toEqual({
            ok: false,
            error: { kind: 'no_data_for_date', date: '2001-05-03', currency: 'EUR' },
        });
    });

    it('stops at the last publication that quotes a currency instead of repeating its rate', () => {
        const bgn = rows(BGN_EURO_CHANGEOVER);
        const lastDays = assembleHistory(code('BGN'), days('2025-12-30', '2025-12-31'), bgn, TODAY);
        expect(lastDays.ok && lastDays.value.days.map((point) => point.rate)).toEqual([1.6227, 1.6227]);
        expect(assembleHistory(code('BGN'), days('2025-12-30', '2026-01-02'), bgn, TODAY)).toEqual({
            ok: false,
            error: { kind: 'no_data_for_date', date: '2026-01-01', currency: 'BGN' },
        });
    });

    it('fails on a publication missing from the currency rows instead of bridging the gap', () => {
        const amdWithGap = AMD_OCTOBER_2026.filter((line) => !line.endsWith('10/6/2026'));
        const exported = rows([OCTOBER_2026, ...amdWithGap].join('\n'));
        const complete = assembleHistory(code('AMD'), days('2026-10-03', '2026-10-05'), exported, TODAY);
        expect(complete.ok && complete.value.days.map((point) => point.rate)).toEqual([
            0.0071762, 0.0071762, 0.0071762,
        ]);
        expect(assembleHistory(code('AMD'), days('2026-10-05', '2026-10-07'), exported, TODAY)).toEqual({
            ok: false,
            error: { kind: 'no_data_for_date', date: '2026-10-06', currency: 'AMD' },
        });
    });

    it('throws when given no days (programmer error: enumerateDays always returns at least one)', () => {
        expect(() => assembleHistory(code('USD'), [], rows(OCTOBER_2026), TODAY)).toThrow();
    });
});
