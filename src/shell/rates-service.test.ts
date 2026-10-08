import { describe, expect, it } from 'vitest';
import { csvExport, loadFixture } from '../../test/helpers/fixtures.js';
import { code, date } from '../../test/helpers/values.js';
import { parseNbgCsv } from '../core/nbg-csv.js';
import { parseNbgResponse, type NbgDay } from '../core/nbg-schema.js';
import { err, ok, type Language, type RatesError, type Result } from '../core/types.js';
import { createSnapshotCache } from './cache.js';
import type { NbgClient } from './nbg-client.js';
import { createRatesService } from './rates-service.js';

function fixtureDay(language: Language, value: string): Result<NbgDay, RatesError> {
    const parsed = parseNbgResponse(loadFixture(`${language}-${value}`));
    if (!parsed.ok) {
        return parsed;
    }
    const day = parsed.value[0];
    return day === undefined ? err({ kind: 'no_data_for_date', date: date(value), currency: undefined }) : ok(day);
}

const RECORDED = new Set([
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2021-09-05',
    '2005-03-15',
    '1995-01-01',
]);

/** Fake client: serves recorded fixtures, answers unknown dates with the latest table like NBG, counts calls, can fail. */
function fakeClient(options: { failDate?: string; failRange?: boolean } = {}) {
    const calls: string[] = [];
    const client: NbgClient = {
        fetchDay(requested, language) {
            calls.push(`day:${language}:${requested}`);
            if (requested === options.failDate) {
                return Promise.resolve(err({ kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' }));
            }
            const value = RECORDED.has(requested) && language === 'en' ? requested : '2026-10-07';
            return Promise.resolve(fixtureDay(language === 'ka' ? 'ka' : 'en', value));
        },
        fetchRange(currencies, start, end) {
            calls.push(`range:${currencies.join(',')}:${start}:${end}`);
            if (options.failRange === true) {
                return Promise.resolve(err({ kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' }));
            }
            return Promise.resolve(parseNbgCsv(csvExport(currencies, start, end)));
        },
    };
    return { client, calls };
}

// 2026-10-08 10:00 in Tbilisi (UTC+4): today is 2026-10-08, tomorrow's rate is not published yet.
const NOW = new Date('2026-10-08T06:00:00Z');

function service(options: { failDate?: string; failRange?: boolean; now?: () => Date } = {}) {
    const { client, calls } = fakeClient(options);
    const now = options.now ?? (() => NOW);
    return { service: createRatesService({ client, cache: createSnapshotCache(), now }), calls };
}

describe('getSnapshot', () => {
    it('returns the full table and caches it, so a second call with a filter fetches nothing', async () => {
        const { service: rates, calls } = service();
        const full = await rates.getSnapshot({ date: date('2026-10-07'), language: 'en' });
        expect(full.ok).toBe(true);
        const filtered = await rates.getSnapshot({
            date: date('2026-10-07'),
            language: 'en',
            codes: [code('USD'), code('XXX')],
        });
        expect(filtered.ok).toBe(true);
        if (filtered.ok) {
            expect(filtered.value.rates.map((entry) => entry.code)).toEqual(['USD']);
            expect(filtered.value.unknownCodes).toEqual(['XXX']);
        }
        expect(calls).toEqual(['day:en:2026-10-07']);
    });

    it('answers a Monday with the Saturday table, carried over', async () => {
        const { service: rates } = service();
        const result = await rates.getSnapshot({ date: date('2026-10-05'), language: 'en' });
        expect(result.ok && result.value).toMatchObject({ effectiveDate: '2026-10-03', carriedOver: true });
    });

    it('refuses tomorrow before NBG published it, naming the latest effective date', async () => {
        const { service: rates } = service();
        const result = await rates.getSnapshot({ date: date('2026-10-09'), language: 'en' });
        expect(result).toEqual({
            ok: false,
            error: { kind: 'rate_not_published', date: '2026-10-09', latestEffectiveDate: '2026-10-07' },
        });
    });

    it('refuses a far-future date without asking NBG', async () => {
        const { service: rates, calls } = service();
        const result = await rates.getSnapshot({ date: date('2099-01-01'), language: 'en' });
        expect(result.ok === false && result.error.kind).toBe('rate_not_published');
        expect(calls).toEqual([]);
    });

    it('does not cache a not-yet-published answer, so the date is asked again after midnight', async () => {
        let clock = new Date('2026-10-08T19:59:00Z'); // 23:59 in Tbilisi
        const { service: rates, calls } = service({ now: () => clock });
        const before = await rates.getSnapshot({ date: date('2026-10-09'), language: 'en' });
        expect(before.ok === false && before.error.kind).toBe('rate_not_published');
        clock = new Date('2026-10-08T20:01:00Z'); // 00:01 on 2026-10-09
        await rates.getSnapshot({ date: date('2026-10-09'), language: 'en' });
        expect(calls).toEqual(['day:en:2026-10-09', 'day:en:2026-10-09']);
    });

    it('rejects a table valid after the requested date (NBG ignoring the date) and does not cache it', async () => {
        const { service: rates, calls } = service();
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = await rates.getSnapshot({ date: date('2010-01-04'), language: 'en' });
            expect(result.ok === false && result.error.kind).toBe('upstream_shape_changed');
        }
        expect(calls).toEqual(['day:en:2010-01-04', 'day:en:2010-01-04']);
    });

    it('passes upstream errors through', async () => {
        const { service: rates } = service({ failDate: '2026-10-07' });
        const result = await rates.getSnapshot({ date: date('2026-10-07'), language: 'en' });
        expect(result).toEqual({ ok: false, error: { kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' } });
    });
});

describe('getHistory', () => {
    it('makes one CSV request with a 31-day lookback and returns every calendar day', async () => {
        const { service: rates, calls } = service();
        const result = await rates.getHistory({
            currency: code('USD'),
            from: date('2026-10-01'),
            to: date('2026-10-07'),
        });
        expect(calls).toEqual(['range:USD:2026-08-31:2026-10-07']);
        expect(result.ok && result.value.days[0]).toEqual({
            date: '2026-10-01',
            effectiveDate: '2026-10-01',
            rate: 2.6047,
            carriedOver: false,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.days.map((point) => point.date)).toEqual([
                '2026-10-01',
                '2026-10-02',
                '2026-10-03',
                '2026-10-04',
                '2026-10-05',
                '2026-10-06',
                '2026-10-07',
            ]);
            expect(result.value.days.filter((point) => point.carriedOver).map((point) => point.date)).toEqual([
                '2026-10-04',
                '2026-10-05',
            ]);
        }
    });

    it('asks for the USD publication calendar alongside any other currency', async () => {
        const { service: rates, calls } = service();
        const result = await rates.getHistory({
            currency: code('AMD'),
            from: date('2026-10-03'),
            to: date('2026-10-05'),
        });
        expect(calls).toEqual(['range:AMD,USD:2026-09-02:2026-10-05']);
        expect(result.ok && result.value.days.map((point) => point.rate)).toEqual([0.0071762, 0.0071762, 0.0071762]);
    });

    it('starts a range on a Sunday with the Saturday rate found through the lookback', async () => {
        const { service: rates } = service();
        const result = await rates.getHistory({
            currency: code('USD'),
            from: date('2026-10-04'),
            to: date('2026-10-06'),
        });
        expect(result.ok && result.value.days[0]).toMatchObject({ effectiveDate: '2026-10-03', carriedOver: true });
    });

    it('rejects a range longer than 366 days before any request', async () => {
        const { service: rates, calls } = service();
        const result = await rates.getHistory({
            currency: code('USD'),
            from: date('2024-01-01'),
            to: date('2025-01-01'),
        });
        expect(result).toEqual({ ok: false, error: { kind: 'range_too_long', days: 367, max: 366 } });
        expect(calls).toHaveLength(0);
    });

    it('rejects a range ending after tomorrow before any request', async () => {
        const { service: rates, calls } = service();
        const result = await rates.getHistory({
            currency: code('USD'),
            from: date('2026-10-01'),
            to: date('2026-10-10'),
        });
        expect(result.ok === false && result.error.kind).toBe('rate_not_published');
        expect(calls).toHaveLength(0);
    });

    it('answers a range ending before the archive start with no data for its first day and no request', async () => {
        const { service: rates, calls } = service();
        const yearZero = await rates.getHistory({
            currency: code('USD'),
            from: date('0000-01-15'),
            to: date('0000-01-20'),
        });
        expect(yearZero).toEqual({
            ok: false,
            error: { kind: 'no_data_for_date', date: '0000-01-15', currency: 'USD' },
        });
        const dayBeforeArchive = await rates.getHistory({
            currency: code('USD'),
            from: date('1995-10-01'),
            to: date('1995-10-13'),
        });
        expect(dayBeforeArchive).toEqual({
            ok: false,
            error: { kind: 'no_data_for_date', date: '1995-10-01', currency: 'USD' },
        });
        expect(calls).toEqual([]);
    });

    it('reports unknown_currency for a code NBG never published', async () => {
        const { service: rates } = service();
        const result = await rates.getHistory({
            currency: code('XXX'),
            from: date('2026-10-01'),
            to: date('2026-10-02'),
        });
        expect(result).toEqual({ ok: false, error: { kind: 'unknown_currency', code: 'XXX' } });
    });

    it('passes an upstream failure through', async () => {
        const { service: rates } = service({ failRange: true });
        const result = await rates.getHistory({
            currency: code('USD'),
            from: date('2026-10-01'),
            to: date('2026-10-02'),
        });
        expect(result.ok === false && result.error.kind).toBe('upstream_unavailable');
    });
});
