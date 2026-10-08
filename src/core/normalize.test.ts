import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/helpers/fixtures.js';
import { code, date } from '../../test/helpers/values.js';
import { parseNbgResponse, type NbgDay } from './nbg-schema.js';
import { normalizeSnapshot, perUnit, requirePublished, selectCurrencies } from './normalize.js';

function day(fixture: string): NbgDay {
    const parsed = parseNbgResponse(loadFixture(fixture));
    if (!parsed.ok || parsed.value[0] === undefined) {
        throw new Error(`fixture ${fixture} has no day`);
    }
    return parsed.value[0];
}

describe('perUnit', () => {
    it('divides by the quantity and rounds to 4 + log10(quantity) decimals', () => {
        expect(perUnit(2.6025, 1)).toBe(2.6025);
        expect(perUnit(7.0844, 10)).toBe(0.70844);
        expect(perUnit(1.2345, 100)).toBe(0.012345);
        expect(perUnit(7.1762, 1000)).toBe(0.0071762);
        expect(perUnit(1.2345, 10000)).toBe(0.00012345);
        expect(perUnit(-0.0035, 1000)).toBe(-0.0000035);
    });

    it('never leaves float noise', () => {
        expect(String(perUnit(7.1748, 1000))).toBe('0.0071748');
    });
});

describe('normalizeSnapshot', () => {
    it('maps a weekday table with per-unit rates and the raw NBG pair, and no timestamp field', () => {
        const snapshot = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-07'));
        expect(snapshot.requestedDate).toBe('2026-10-07');
        expect(snapshot.effectiveDate).toBe('2026-10-07');
        expect(snapshot.carriedOver).toBe(false);
        expect(snapshot).not.toHaveProperty('publishedAt');
        expect(snapshot.unknownCodes).toEqual([]);
        expect(snapshot.rates).toHaveLength(42);
        for (const entry of snapshot.rates) {
            expect(Number.isFinite(entry.rate), entry.code).toBe(true);
            expect(Number.isFinite(entry.diff), entry.code).toBe(true);
        }
        // Worked by hand from test/fixtures/en-2026-10-07.json: USD is quoted per 1, AMD per 1000.
        expect(snapshot.rates.find((entry) => entry.code === 'USD')).toEqual({
            code: 'USD',
            name: 'US Dollar',
            rate: 2.6025,
            diff: -0.0007,
            nbgQuantity: 1,
            nbgRate: 2.6025,
        });
        expect(snapshot.rates.find((entry) => entry.code === 'AMD')).toEqual({
            code: 'AMD',
            name: 'Armenian Dram',
            rate: 0.0071783,
            diff: 0.0000004,
            nbgQuantity: 1000,
            nbgRate: 7.1783,
        });
    });

    it('gives Saturday its own table (published Friday)', () => {
        const snapshot = normalizeSnapshot(day('en-2026-10-03'), date('2026-10-03'));
        expect(snapshot.effectiveDate).toBe('2026-10-03');
        expect(snapshot.carriedOver).toBe(false);
    });

    it('carries the Saturday table over to Sunday and Monday', () => {
        for (const requested of ['2026-10-04', '2026-10-05']) {
            const snapshot = normalizeSnapshot(day(`en-${requested}`), date(requested));
            expect(snapshot.requestedDate, requested).toBe(requested);
            expect(snapshot.effectiveDate, requested).toBe('2026-10-03');
            expect(snapshot.carriedOver, requested).toBe(true);
        }
    });

    it('gives an old-era Sunday (before September 2021) its own row', () => {
        const snapshot = normalizeSnapshot(day('en-2021-09-05'), date('2021-09-05'));
        expect(snapshot.effectiveDate).toBe('2021-09-05');
        expect(snapshot.carriedOver).toBe(false);
    });

    it('reads the 2005 archive', () => {
        const snapshot = normalizeSnapshot(day('en-2005-03-15'), date('2005-03-15'));
        expect(snapshot.effectiveDate).toBe('2005-03-15');
        expect(snapshot.carriedOver).toBe(false);
    });

    it('flags a far-future request answered with the current table as carried over (requirePublished rejects it)', () => {
        const snapshot = normalizeSnapshot(day('en-2026-10-07'), date('2099-01-01'));
        expect(snapshot.effectiveDate).toBe('2026-10-07');
        expect(snapshot.carriedOver).toBe(true);
    });

    it('keeps Georgian names when given the ka table, with identical numbers', () => {
        const georgian = normalizeSnapshot(day('ka-2026-10-07'), date('2026-10-07'));
        const english = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-07'));
        const usd = georgian.rates.find((entry) => entry.code === 'USD');
        expect(usd?.name).toMatch(/[Ⴀ-ჿ]/);
        expect(usd?.rate).toBe(english.rates.find((entry) => entry.code === 'USD')?.rate);
    });
});

describe('requirePublished', () => {
    it('accepts past and current days, carried over or not', () => {
        const monday = normalizeSnapshot(day('en-2026-10-05'), date('2026-10-05'));
        expect(requirePublished(monday, date('2026-10-08'))).toEqual({ ok: true, value: monday });
        const todayCarried = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-08'));
        expect(requirePublished(todayCarried, date('2026-10-08')).ok).toBe(true);
    });

    it('rejects tomorrow before NBG published it, naming the latest effective date', () => {
        // 10:00 Tbilisi on 2026-10-07: a request for 2026-10-08 still gets the table valid from 2026-10-07.
        const tomorrow = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-08'));
        expect(requirePublished(tomorrow, date('2026-10-07'))).toEqual({
            ok: false,
            error: { kind: 'rate_not_published', date: '2026-10-08', latestEffectiveDate: '2026-10-07' },
        });
    });

    it('accepts tomorrow once NBG published a rate valid from it', () => {
        const published = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-07'));
        expect(requirePublished(published, date('2026-10-06')).ok).toBe(true);
    });

    it('rejects a table that took effect after the requested date as a shape change', () => {
        // What NBG would return if it stopped honouring the date parameter: today's table for a 2005 request.
        const wrongTable = normalizeSnapshot(day('en-2026-10-07'), date('2005-03-15'));
        const result = requirePublished(wrongTable, date('2026-10-08'));
        expect(result.ok === false && result.error.kind).toBe('upstream_shape_changed');
        if (!result.ok && result.error.kind === 'upstream_shape_changed') {
            expect(result.error.detail).toContain('2005-03-15');
            expect(result.error.detail).toContain('2026-10-07');
        }
    });

    it('rejects a far-future date', () => {
        const future = normalizeSnapshot(day('en-2026-10-07'), date('2099-01-01'));
        expect(requirePublished(future, date('2026-10-08')).ok).toBe(false);
    });
});

describe('selectCurrencies', () => {
    it('filters in request order and reports unknown codes without failing', () => {
        const full = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-07'));
        const selected = selectCurrencies(full, [code('EUR'), code('XXX'), code('USD')]);
        expect(selected.rates.map((entry) => entry.code)).toEqual(['EUR', 'USD']);
        expect(selected.unknownCodes).toEqual(['XXX']);
        expect(selected.effectiveDate).toBe(full.effectiveDate);
    });

    it('ignores duplicate codes', () => {
        const full = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-07'));
        const selected = selectCurrencies(full, [code('USD'), code(' usd '), code('XXX'), code('XXX')]);
        expect(selected.rates.map((entry) => entry.code)).toEqual(['USD']);
        expect(selected.unknownCodes).toEqual(['XXX']);
    });

    it('returns no rates and all codes unknown when nothing matches', () => {
        const full = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-07'));
        const selected = selectCurrencies(full, [code('XXX')]);
        expect(selected.rates).toEqual([]);
        expect(selected.unknownCodes).toEqual(['XXX']);
    });
});
