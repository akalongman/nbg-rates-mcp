import { describe, expect, it } from 'vitest';
import { parseNbgCsv, type NbgCsvRow } from '../../src/core/nbg-csv.js';
import { err, ok } from '../../src/core/types.js';
import { createFakeNbg } from './fake-nbg.js';
import { csvExport } from './fixtures.js';
import { publication, rowsFromTable, syntheticTable, tableFixture } from './publications.js';
import { code, date } from './values.js';

const KA_2026_10_07 = tableFixture('ka', '2026-10-07');
/** The recorded publications of 2026-10-01 to 2026-10-07: 10-04 and 10-05 repeat the table valid from 10-03. */
const OCTOBER = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07'].map((day) =>
    publication(tableFixture('en', day), day === '2026-10-07' ? { ka: KA_2026_10_07 } : {}),
);
const OCTOBER_08 = publication(syntheticTable('2026-10-08', { AMD: 7.1, USD: 2.61 }));
const USD = code('USD');
const AMD = code('AMD');

/** NBG's recorded CSV export for these codes and dates. */
function recordedExport(codes: ReadonlyArray<string>, start: string, end: string): ReadonlyArray<NbgCsvRow> {
    const parsed = parseNbgCsv(csvExport(codes, start, end));
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.error));
    }
    return parsed.value;
}

describe('createFakeNbg', () => {
    it('answers a day with the table of the latest valid-from date on or before it, as NBG did', async () => {
        const { client } = createFakeNbg(OCTOBER);
        expect(await client.fetchDay(date('2026-10-05'), 'en')).toEqual(ok(tableFixture('en', '2026-10-05')));
        expect(await client.fetchDay(date('2026-10-06'), 'en')).toEqual(ok(tableFixture('en', '2026-10-06')));
    });

    it('answers a date after every table with the latest table', async () => {
        const { client } = createFakeNbg(OCTOBER);
        expect(await client.fetchDay(date('2026-10-20'), 'en')).toEqual(ok(tableFixture('en', '2026-10-07')));
    });

    it('answers no_data_for_date before the first table', async () => {
        const { client } = createFakeNbg(OCTOBER);
        expect(await client.fetchDay(date('2026-09-30'), 'en')).toEqual(
            err({ kind: 'no_data_for_date', date: '2026-09-30', currency: undefined }),
        );
    });

    it('answers in the language asked', async () => {
        const { client } = createFakeNbg(OCTOBER);
        expect(await client.fetchDay(date('2026-10-07'), 'ka')).toEqual(ok(KA_2026_10_07));
    });

    it('exports the codes in request order, newest first per code, inclusive at both ends, as NBG did', async () => {
        const { client } = createFakeNbg(OCTOBER);
        const rows = await client.fetchRange([USD, AMD], date('2026-10-02'), date('2026-10-06'));
        expect(rows).toEqual(ok(recordedExport(['USD', 'AMD'], '2026-10-02', '2026-10-06')));
        expect(rows.ok ? rows.value.map((row) => `${row.code} ${row.validFrom}`) : []).toEqual([
            'USD 2026-10-06',
            'USD 2026-10-03',
            'USD 2026-10-02',
            'AMD 2026-10-06',
            'AMD 2026-10-03',
            'AMD 2026-10-02',
        ]);
    });

    it('exports nothing at all when AZN is asked over a range reaching into the gap', async () => {
        const { client } = createFakeNbg([
            publication(syntheticTable('2007-12-15', { AZN: 1.2, USD: 1.6 })),
            publication(syntheticTable('2008-01-03', { AZN: 1.21, USD: 1.59 })),
        ]);
        const azn = code('AZN');
        expect(await client.fetchRange([USD, azn], date('2007-12-01'), date('2008-01-05'))).toEqual(ok([]));
        const usd = await client.fetchRange([USD], date('2007-12-01'), date('2008-01-05'));
        expect(usd.ok ? usd.value.map((row) => row.validFrom) : []).toEqual(['2008-01-03', '2007-12-15']);
        const after = await client.fetchRange([azn], date('2008-01-01'), date('2008-01-05'));
        expect(after.ok ? after.value.map((row) => `${row.code} ${row.validFrom}`) : []).toEqual(['AZN 2008-01-03']);
    });

    it('records every request when it is made, in order', async () => {
        const fake = createFakeNbg(OCTOBER);
        await fake.client.fetchDay(date('2026-10-07'), 'en');
        await fake.client.fetchRange([AMD, USD], date('2026-10-01'), date('2026-10-09'));
        expect(fake.requests).toEqual(['day:en:2026-10-07', 'range:AMD,USD:2026-10-01:2026-10-09']);
    });

    it('publish adds or replaces a publication in both views', async () => {
        const fake = createFakeNbg(OCTOBER);
        fake.publish(OCTOBER_08);
        expect(await fake.client.fetchDay(date('2026-10-08'), 'en')).toEqual(ok(OCTOBER_08.en));
        expect(await fake.client.fetchRange([USD], date('2026-10-08'), date('2026-10-08'))).toEqual(
            ok(OCTOBER_08.rows.filter((row) => row.code === 'USD')),
        );

        const revised = publication(syntheticTable('2026-10-08', { AMD: 7.2, USD: 2.62 }));
        fake.publish(revised);
        expect(await fake.client.fetchDay(date('2026-10-08'), 'ka')).toEqual(ok(revised.ka));
        expect(await fake.client.fetchRange([AMD, USD], date('2026-10-08'), date('2026-10-08'))).toEqual(
            ok(revised.rows),
        );
    });

    it('publishJson changes the JSON view only', async () => {
        const fake = createFakeNbg(OCTOBER);
        fake.publishJson(OCTOBER_08);
        expect(await fake.client.fetchDay(date('2026-10-08'), 'en')).toEqual(ok(OCTOBER_08.en));
        expect(await fake.client.fetchRange([AMD, USD], date('2026-10-08'), date('2026-10-09'))).toEqual(ok([]));
    });

    it('publishCsv changes the CSV view only', async () => {
        const fake = createFakeNbg(OCTOBER);
        fake.publishCsv(OCTOBER_08);
        expect(await fake.client.fetchRange([AMD, USD], date('2026-10-08'), date('2026-10-09'))).toEqual(
            ok(OCTOBER_08.rows),
        );
        expect(await fake.client.fetchDay(date('2026-10-08'), 'en')).toEqual(ok(tableFixture('en', '2026-10-07')));
    });

    it('withdraw removes a publication from both views', async () => {
        const fake = createFakeNbg(OCTOBER);
        fake.withdraw(date('2026-10-07'));
        expect(await fake.client.fetchDay(date('2026-10-07'), 'en')).toEqual(ok(tableFixture('en', '2026-10-06')));
        expect(await fake.client.fetchRange([USD], date('2026-10-07'), date('2026-10-07'))).toEqual(ok([]));
    });

    it('answers every request with the failWith error until cleared, still recording it', async () => {
        const fake = createFakeNbg(OCTOBER);
        const outage = { kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' } as const;
        fake.failWith(outage);
        expect(await fake.client.fetchDay(date('2026-10-07'), 'en')).toEqual(err(outage));
        expect(await fake.client.fetchRange([USD], date('2026-10-07'), date('2026-10-07'))).toEqual(err(outage));
        fake.failWith(undefined);
        expect(await fake.client.fetchDay(date('2026-10-07'), 'en')).toEqual(ok(tableFixture('en', '2026-10-07')));
        expect(fake.requests).toEqual(['day:en:2026-10-07', 'range:USD:2026-10-07:2026-10-07', 'day:en:2026-10-07']);
    });

    it('holds requests until released and answers them from the data at release', async () => {
        const fake = createFakeNbg(OCTOBER);
        const release = fake.hold();
        let settled = false;
        const held = fake.client.fetchDay(date('2026-10-08'), 'en').then((result) => {
            settled = true;
            return result;
        });
        expect(fake.requests).toEqual(['day:en:2026-10-08']);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        fake.publish(OCTOBER_08);
        release();
        expect(await held).toEqual(ok(OCTOBER_08.en));
        expect(await fake.client.fetchRange([USD], date('2026-10-08'), date('2026-10-08'))).toEqual(
            ok(rowsFromTable(OCTOBER_08.en).filter((row) => row.code === 'USD')),
        );
    });
});
