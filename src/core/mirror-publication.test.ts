import { describe, expect, it } from 'vitest';
import { csvExport } from '../../test/helpers/fixtures.js';
import {
    georgianTwin,
    publication,
    rowsFromTable,
    syntheticTable,
    tableFixture,
} from '../../test/helpers/publications.js';
import { code, date } from '../../test/helpers/values.js';
import {
    changedPublications,
    checkAgreement,
    checkTableAgainstRows,
    csvRequestCodes,
    exportRows,
    groupByValidFrom,
    parseStoredRows,
    sameRows,
    sameTable,
    tableValidFrom,
    type MirrorPublication,
} from './mirror-publication.js';
import { parseNbgCsv, type NbgCsvRow } from './nbg-csv.js';
import type { NbgCurrencyRow, NbgDay } from './nbg-schema.js';
import { err, ok, type CalendarDate, type Result } from './types.js';

function agreement(subject: MirrorPublication): Result<void, string> {
    return checkAgreement(subject.validFrom, subject.en, subject.ka, subject.rows);
}

function withRow(table: NbgDay, rowCode: string, change: Partial<NbgCurrencyRow>): NbgDay {
    return {
        ...table,
        currencies: table.currencies.map((row) => (row.code === rowCode ? { ...row, ...change } : row)),
    };
}

function withoutCode(table: NbgDay, rowCode: string): NbgDay {
    return { ...table, currencies: table.currencies.filter((row) => row.code !== rowCode) };
}

function csvRow(rowCode: string, quantity: number, rate: number, publishedOn: string, validFrom: string): NbgCsvRow {
    return { code: rowCode, quantity, rate, publishedOn: date(publishedOn), validFrom: date(validFrom) };
}

/** NBG's recorded CSV export for AMD and USD over a range of valid-from dates. */
function recordedExport(start: string, end: string): ReadonlyArray<NbgCsvRow> {
    const parsed = parseNbgCsv(csvExport(['AMD', 'USD'], start, end));
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.error));
    }
    return parsed.value;
}

const EN_2026_10_07 = tableFixture('en', '2026-10-07');
const KA_2026_10_07 = tableFixture('ka', '2026-10-07');
const ROWS_2026_10_07 = rowsFromTable(EN_2026_10_07);

/** One English table per publication: the 2026-10-04 and 2026-10-05 tables repeat the one valid from 2026-10-03. */
const OCTOBER_PUBLICATIONS: ReadonlyMap<CalendarDate, NbgDay> = new Map(
    ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
        .map((day) => tableFixture('en', day))
        .map((table) => [tableValidFrom(table), table]),
);

describe('checkAgreement', () => {
    it('agrees on the recorded 2026-10-07 publication, and each table alone agrees with its rows', () => {
        const recorded = publication(EN_2026_10_07, { ka: KA_2026_10_07 });
        expect(agreement(recorded)).toEqual(ok(undefined));
        expect(checkTableAgainstRows(recorded.validFrom, recorded.en, recorded.rows)).toEqual(ok(undefined));
        expect(checkTableAgainstRows(recorded.validFrom, recorded.ka, recorded.rows)).toEqual(ok(undefined));
    });

    describe('with the float noise in the recorded 2005-03-15 table (AED 4.9830000000000005)', () => {
        const noisy = tableFixture('en', '2005-03-15');
        const rows = rowsFromTable(noisy);

        it('agrees with rows that carry the rates at four decimals, as the export lists them', () => {
            expect(noisy.currencies.find((row) => row.code === 'AED')?.rate).toBe(4.9830000000000005);
            expect(rows.find((row) => row.code === 'AED')?.rate).toBe(4.983);
            expect(checkTableAgainstRows(date('2005-03-15'), noisy, rows)).toEqual(ok(undefined));
            const cleanGeorgian = withRow(georgianTwin(noisy), 'AED', { rate: 4.983 });
            expect(agreement(publication(noisy, { ka: cleanGeorgian }))).toEqual(ok(undefined));
        });

        it('still disagrees on a difference of one in the fourth decimal', () => {
            const changed = rows.map((row) => (row.code === 'AED' ? { ...row, rate: 4.9831 } : row));
            expect(agreement(publication(noisy, { rows: changed }))).toEqual(
                err('English table: AED rate 4.9830000000000005 in the table, 4.9831 in the rows'),
            );
        });
    });

    it.each<readonly [string, NbgDay, NbgDay, ReadonlyArray<NbgCsvRow>, string]>([
        [
            'the 2026-10-06 table checked as 2026-10-07',
            tableFixture('en', '2026-10-06'),
            KA_2026_10_07,
            ROWS_2026_10_07,
            'English table: table valid from 2026-10-06, not 2026-10-07',
        ],
        [
            'a Georgian table without AMD',
            EN_2026_10_07,
            withoutCode(KA_2026_10_07, 'AMD'),
            ROWS_2026_10_07,
            'Georgian table: AMD in the rows, not in the table',
        ],
        [
            'rows without AMD',
            EN_2026_10_07,
            KA_2026_10_07,
            ROWS_2026_10_07.filter((row) => row.code !== 'AMD'),
            'English table: AMD in the table, not in the rows',
        ],
        [
            'an extra XYZ row',
            EN_2026_10_07,
            KA_2026_10_07,
            [...ROWS_2026_10_07, csvRow('XYZ', 1, 1.5, '2026-10-06', '2026-10-07')],
            'English table: XYZ in the rows, not in the table',
        ],
        [
            'a CSV USD rate of 2.6026 against 2.6025',
            EN_2026_10_07,
            KA_2026_10_07,
            ROWS_2026_10_07.map((row) => (row.code === 'USD' ? { ...row, rate: 2.6026 } : row)),
            'English table: USD rate 2.6025 in the table, 2.6026 in the rows',
        ],
        [
            'a CSV quantity of 10 for USD',
            EN_2026_10_07,
            KA_2026_10_07,
            ROWS_2026_10_07.map((row) => (row.code === 'USD' ? { ...row, quantity: 10 } : row)),
            'English table: USD quantity 1 in the table, 10 in the rows',
        ],
        [
            'a Georgian USD rate of 2.6026',
            EN_2026_10_07,
            withRow(KA_2026_10_07, 'USD', { rate: 2.6026 }),
            ROWS_2026_10_07,
            'Georgian table: USD rate 2.6026 in the table, 2.6025 in the rows',
        ],
    ])('names the cause for %s', (_case, en, ka, rows, cause) => {
        expect(checkAgreement(date('2026-10-07'), en, ka, rows)).toEqual(err(cause));
    });

    it('refuses rows of another publication', () => {
        expect(
            checkTableAgainstRows(date('2026-10-07'), EN_2026_10_07, rowsFromTable(tableFixture('en', '2026-10-06'))),
        ).toEqual(err('AED row valid from 2026-10-06, not 2026-10-07'));
    });

    it('excuses AZN missing from the rows inside the gap, and only there', () => {
        const inGap = syntheticTable('2006-06-01', { AZN: 1.9989, USD: 1.8 });
        const afterGap = syntheticTable('2008-01-02', { AZN: 1.9989, USD: 1.8 });
        const usdOnly = (table: NbgDay): ReadonlyArray<NbgCsvRow> =>
            rowsFromTable(table).filter((row) => row.code === 'USD');
        expect(agreement(publication(inGap, { rows: usdOnly(inGap) }))).toEqual(ok(undefined));
        expect(agreement(publication(afterGap, { rows: usdOnly(afterGap) }))).toEqual(
            err('English table: AZN in the table, not in the rows'),
        );
    });

    it('compares the two tables on AZN where the rows cannot', () => {
        const inGap = syntheticTable('2006-06-01', { AZN: 1.9989, USD: 1.8 });
        const rows = rowsFromTable(inGap).filter((row) => row.code === 'USD');
        const kaRate = withRow(georgianTwin(inGap), 'AZN', { rate: 1.999 });
        expect(agreement(publication(inGap, { ka: kaRate, rows }))).toEqual(
            err('English and Georgian tables: AZN rate 1.9989 in English, 1.999 in Georgian'),
        );
        expect(agreement(publication(inGap, { ka: withoutCode(georgianTwin(inGap), 'AZN'), rows }))).toEqual(
            err('English and Georgian tables: AZN in English, not in Georgian'),
        );
    });

    const duplicates = [
        csvRow('USD', 1, 2.6025, '2026-10-06', '2026-10-07'),
        csvRow('USD', 1, 2.7, '2026-10-08', '2026-10-07'),
    ];

    it.each([
        ['as listed', duplicates],
        ['listed the other way round', [...duplicates].reverse()],
    ])('compares a table with the row published last for its code, %s', (_order, rows) => {
        expect(agreement(publication(syntheticTable('2026-10-07', { USD: 2.7 }), { rows }))).toEqual(ok(undefined));
        expect(agreement(publication(syntheticTable('2026-10-07', { USD: 2.6025 }), { rows }))).toEqual(
            err('English table: USD rate 2.6025 in the table, 2.7 in the rows'),
        );
    });
});

describe('csvRequestCodes', () => {
    it.each([
        ['2007-12-01', '2007-12-31', ['USD']],
        ['2008-01-01', '2008-01-31', ['AZN', 'USD']],
        ['2005-12-01', '2006-01-05', ['USD']],
    ])('leaves AZN out only when %s to %s reaches into the gap', (start, end, expected) => {
        expect(csvRequestCodes(['AZN', 'USD'], date(start), date(end))).toEqual(expected);
    });
});

describe('sameTable', () => {
    const table = syntheticTable('2026-10-07', { USD: 2.6025, EUR: 3.0412 });

    it('ignores write stamps', () => {
        const rewritten = syntheticTable(
            '2026-10-07',
            { USD: 2.6025, EUR: 3.0412 },
            { writtenAt: '2026-10-06T17:45:00.000Z' },
        );
        expect(rewritten.currencies[0]?.date).not.toBe(table.currencies[0]?.date);
        expect(sameTable(table, rewritten)).toBe(true);
    });

    it('sees a changed name', () => {
        expect(sameTable(table, withRow(table, 'EUR', { name: 'Euro (renamed)' }))).toBe(false);
    });

    it('sees two rows swapped', () => {
        expect(sameTable(table, { ...table, currencies: [...table.currencies].reverse() })).toBe(false);
    });
});

describe('sameRows', () => {
    const usd = csvRow('USD', 1, 2.6025, '2026-10-06', '2026-10-07');
    const amd = csvRow('AMD', 1000, 7.1783, '2026-10-06', '2026-10-07');

    it('ignores order', () => {
        expect(sameRows([usd, amd], [amd, usd])).toBe(true);
    });

    it('sees a changed publishedOn', () => {
        expect(sameRows([usd, amd], [{ ...usd, publishedOn: date('2026-10-07') }, amd])).toBe(false);
    });

    it('counts repeated rows', () => {
        expect(sameRows([usd, usd, amd], [usd, amd, amd])).toBe(false);
    });
});

describe('groupByValidFrom', () => {
    it('groups the rows by publication, keeping the listed order', () => {
        const grouped = groupByValidFrom(recordedExport('2026-10-01', '2026-10-07'));
        expect([...grouped.keys()]).toEqual(['2026-10-07', '2026-10-06', '2026-10-03', '2026-10-02', '2026-10-01']);
        expect(grouped.get(date('2026-10-07'))?.map((row) => row.code)).toEqual(['AMD', 'USD']);
    });
});

describe('changedPublications', () => {
    const rowsOf = (validFrom: string, rate: number): ReadonlyArray<NbgCsvRow> =>
        rowsFromTable(syntheticTable(validFrom, { USD: rate }));
    const a = rowsOf('2026-10-06', 2.6032);
    const b = rowsOf('2026-10-07', 2.6025);
    const b2 = rowsOf('2026-10-07', 2.6026);
    const c = rowsOf('2026-10-08', 2.6021);
    const stored = new Map([
        [date('2026-10-06'), a],
        [date('2026-10-07'), b],
        [date('2026-10-08'), c],
    ]);

    it('lists the dates that differ or are missing from what was fetched', () => {
        const fetched = new Map([
            [date('2026-10-06'), a],
            [date('2026-10-07'), b2],
        ]);
        expect(changedPublications(fetched, stored)).toEqual(['2026-10-07', '2026-10-08']);
    });

    it('lists a new date, in ascending order', () => {
        const fetched = new Map([
            [date('2026-10-09'), rowsOf('2026-10-09', 2.6019)],
            [date('2026-10-06'), a],
            [date('2026-10-07'), b2],
        ]);
        expect(changedPublications(fetched, stored)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    });

    it('lists nothing when nothing changed', () => {
        expect(changedPublications(stored, stored)).toEqual([]);
    });
});

describe('rowsFromTable', () => {
    it('lists the rows of the recorded tables that NBG recorded in its export', () => {
        expect([...OCTOBER_PUBLICATIONS.keys()]).toEqual([
            '2026-10-01',
            '2026-10-02',
            '2026-10-03',
            '2026-10-06',
            '2026-10-07',
        ]);
        const fromTables = [...OCTOBER_PUBLICATIONS.values()]
            .flatMap(rowsFromTable)
            .filter((row) => row.code === 'AMD' || row.code === 'USD');
        const recorded = recordedExport('2026-10-01', '2026-10-07');
        expect(recorded).toHaveLength(10);
        expect(sameRows(fromTables, recorded)).toBe(true);
    });
});

describe('exportRows', () => {
    it('answers as the recorded export does, newest publication first', () => {
        const stored = [...OCTOBER_PUBLICATIONS].map(([validFrom, table]) => ({
            validFrom,
            rows: rowsFromTable(table),
        }));
        const exported = exportRows(stored, [code('AMD'), code('USD')], date('2026-10-02'), date('2026-10-06'));
        expect(sameRows(exported, recordedExport('2026-10-02', '2026-10-06'))).toBe(true);
        expect(exported.map((row) => row.validFrom)).toEqual([
            '2026-10-06',
            '2026-10-06',
            '2026-10-03',
            '2026-10-03',
            '2026-10-02',
            '2026-10-02',
        ]);
    });
});

describe('parseStoredRows', () => {
    it('reads back the rows it was given', () => {
        expect(parseStoredRows(JSON.parse(JSON.stringify(ROWS_2026_10_07)))).toEqual(ok(ROWS_2026_10_07));
    });

    it('rejects a lowercase code', () => {
        const result = parseStoredRows([
            { code: 'usd', quantity: 1, rate: 2.6025, publishedOn: '2026-10-06', validFrom: '2026-10-07' },
        ]);
        expect(result.ok).toBe(false);
        expect(result.ok ? undefined : result.error).toMatch(/^0\.code: /);
    });
});
