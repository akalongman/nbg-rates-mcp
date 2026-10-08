import { describe, expect, it } from 'vitest';
import { TBILISI_TIME_ZONE, addDays, calendarDateFromTimestamp, todayIn } from '../../src/core/dates.js';
import { hasAtMostFourDecimals, type NbgDay } from '../../src/core/nbg-schema.js';
import type { CalendarDate } from '../../src/core/types.js';
import { createSnapshotCache } from '../../src/shell/cache.js';
import { createNbgClient } from '../../src/shell/nbg-client.js';
import { createRatesService } from '../../src/shell/rates-service.js';
import { code, date } from '../helpers/values.js';

const LIVE = process.env['NBG_LIVE'] === '1';

const requestLog: string[] = [];
const client = createNbgClient({
    baseUrl: process.env['NBG_RATES_BASE_URL'] ?? 'https://nbg.gov.ge',
    userAgent: 'nbg-rates-mcp/contract-test (+https://github.com/akalongman/nbg-rates-mcp)',
    log: (line) => requestLog.push(line),
});
const service = createRatesService({ client, cache: createSnapshotCache(), now: () => new Date() });

/** The day a table is valid from: the first ten characters of the validFromDate its rows share. */
function validFrom(day: NbgDay): CalendarDate {
    const [first] = day.currencies;
    if (first === undefined) {
        throw new Error(`a table without rows: ${day.date}`);
    }
    return calendarDateFromTimestamp(first.validFromDate);
}

describe.skipIf(!LIVE)('nbg.gov.ge contract', () => {
    it('serves today with USD, power-of-ten quantities and four-decimal raw rates', async () => {
        const result = await service.getSnapshot({ date: todayIn(TBILISI_TIME_ZONE, new Date()), language: 'en' });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) {
            expect(result.value.rates.length).toBeGreaterThan(30);
            expect(result.value.rates.some((entry) => entry.code === 'USD')).toBe(true);
            for (const entry of result.value.rates) {
                expect([1, 10, 100, 1000, 10000], entry.code).toContain(entry.nbgQuantity);
                expect(hasAtMostFourDecimals(entry.nbgRate), entry.code).toBe(true);
                expect(Number.isFinite(entry.rate)).toBe(true);
            }
        }
    });

    it('gives Saturday 2026-10-03 its own table and carries it to Sunday and Monday', async () => {
        for (const requested of ['2026-10-03', '2026-10-04', '2026-10-05']) {
            const result = await service.getSnapshot({ date: date(requested), language: 'en', codes: [code('USD')] });
            expect(result.ok, requested).toBe(true);
            if (result.ok) {
                expect(result.value.effectiveDate, requested).toBe('2026-10-03');
                expect(result.value.carriedOver, requested).toBe(requested !== '2026-10-03');
            }
        }
    });

    it('gives the old-era Sunday 2021-09-05 its own row', async () => {
        const result = await service.getSnapshot({ date: date('2021-09-05'), language: 'en', codes: [code('USD')] });
        expect(result.ok && result.value).toMatchObject({ effectiveDate: '2021-09-05', carriedOver: false });
    });

    it('answers a future date with its latest table, valid from no later than tomorrow', async () => {
        const today = todayIn(TBILISI_TIME_ZONE, new Date());
        // Today's table first: a publication landing between the two requests can only move the later one forward.
        const inForce = await client.fetchDay(today, 'en');
        const latest = await client.fetchDay(addDays(today, 7), 'en');
        expect(inForce.ok, JSON.stringify(inForce).slice(0, 300)).toBe(true);
        expect(latest.ok, JSON.stringify(latest).slice(0, 300)).toBe(true);
        if (inForce.ok && latest.ok) {
            const latestFrom = validFrom(latest.value);
            expect(latestFrom <= addDays(today, 1), `latest table valid from ${latestFrom}`).toBe(true);
            expect(latestFrom >= validFrom(inForce.value), `latest table valid from ${latestFrom}`).toBe(true);
        }
    });

    it('starts the archive on 1995-10-14', async () => {
        const before = await client.fetchDay(date('1995-10-13'), 'en');
        expect(before.ok === false && before.error.kind).toBe('no_data_for_date');
        const first = await service.getSnapshot({ date: date('1995-10-14'), language: 'en' });
        expect(first.ok && first.value.rates.map((entry) => entry.code)).toEqual(['USD']);
    });

    it('serves the 2005 archive with validFromDate on every row', async () => {
        const result = await client.fetchDay(date('2005-03-15'), 'en');
        expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(true);
        if (result.ok) {
            expect(result.value.currencies.every((row) => row.validFromDate.startsWith('2005-03-15'))).toBe(true);
        }
    });

    it('serves Georgian names', async () => {
        const result = await service.getSnapshot({ date: date('2026-10-07'), language: 'ka', codes: [code('USD')] });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) {
            expect(result.value.rates.map((entry) => entry.code)).toEqual(['USD']);
            expect(result.value.rates[0]?.name).toMatch(/[\u10A0-\u10FF]/);
        }
    });

    it('ends BGN with the publication valid from 2025-12-31 (euro adoption), without repeating it', async () => {
        const last = await service.getHistory({
            currency: code('BGN'),
            from: date('2025-12-29'),
            to: date('2025-12-31'),
        });
        expect(last.ok, JSON.stringify(last).slice(0, 300)).toBe(true);
        expect(last.ok && last.value.days.at(-1)).toMatchObject({ date: '2025-12-31', effectiveDate: '2025-12-31' });
        const after = await service.getHistory({
            currency: code('BGN'),
            from: date('2025-12-29'),
            to: date('2026-01-02'),
        });
        expect(after).toEqual({ ok: false, error: { kind: 'no_data_for_date', date: '2026-01-01', currency: 'BGN' } });
    });

    it('serves the CSV export with its header, M/D/YYYY dates and the ValidFromDate filter', async () => {
        const result = await client.fetchRange([code('USD')], date('2026-10-03'), date('2026-10-05'));
        expect(result).toMatchObject({
            ok: true,
            value: [{ code: 'USD', quantity: 1, publishedOn: '2026-10-02', validFrom: '2026-10-03' }],
        });
    });

    it('answers an unknown code in the CSV export with the header only', async () => {
        expect(await client.fetchRange([code('XXX')], date('2026-10-01'), date('2026-10-07'))).toEqual({
            ok: true,
            value: [],
        });
    });

    it('returns a year of history from one request', async () => {
        const to = addDays(todayIn(TBILISI_TIME_ZONE, new Date()), -1);
        const from = addDays(to, -365);
        const before = requestLog.length;
        const result = await service.getHistory({ currency: code('USD'), from, to });
        const attempts = requestLog.slice(before);
        console.error(`[contract] 366-day history: ${attempts.join(' | ')}`);
        expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(true);
        if (result.ok) {
            expect(result.value.days).toHaveLength(366);
            expect(result.value.days.some((point) => point.carriedOver)).toBe(true);
        }
        // The client logs every attempt as "GET <url> -> ...": one transient retry repeats the URL of one request.
        expect(attempts.length, attempts.join(' | ')).toBeGreaterThanOrEqual(1);
        expect(attempts.length, attempts.join(' | ')).toBeLessThanOrEqual(2);
        expect(new Set(attempts.map((line) => line.split(' ')[1])).size, attempts.join(' | ')).toBe(1);
    });
});
