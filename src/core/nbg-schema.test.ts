import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/helpers/fixtures.js';
import { hasAtMostFourDecimals, isPowerOfTen, parseNbgResponse } from './nbg-schema.js';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        code: 'USD',
        quantity: 1,
        rate: 2.6,
        diff: 0,
        name: 'US Dollar',
        date: '2026-10-06T17:01:00.000Z',
        validFromDate: '2026-10-07T00:00:00.000Z',
        ...overrides,
    };
}

function table(rows: ReadonlyArray<Record<string, unknown>>): unknown {
    return [{ date: '2026-10-07T00:00:00.000Z', currencies: rows }];
}

describe('parseNbgResponse', () => {
    it('parses a current weekday table', () => {
        const result = parseNbgResponse(loadFixture('en-2026-10-07'));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toHaveLength(1);
            const day = result.value[0];
            expect(day?.date).toBe('2026-10-07T00:00:00.000Z');
            expect(day?.currencies.length).toBeGreaterThan(30);
            const usd = day?.currencies.find((entry) => entry.code === 'USD');
            expect(usd?.quantity).toBe(1);
            expect(usd?.validFromDate).toBe('2026-10-07T00:00:00.000Z');
        }
    });

    it('parses a 2005 table, whose rows carry validFromDate like every row since 1995', () => {
        const result = parseNbgResponse(loadFixture('en-2005-03-15'));
        expect(result.ok).toBe(true);
        if (result.ok) {
            const usd = result.value[0]?.currencies.find((entry) => entry.code === 'USD');
            expect(usd?.validFromDate).toBe('2005-03-15T00:00:00.000Z');
        }
    });

    it('parses an empty archive answer as an empty list', () => {
        expect(parseNbgResponse(loadFixture('en-1995-01-01'))).toEqual({ ok: true, value: [] });
    });

    it('tolerates extra fields NBG may add', () => {
        const result = parseNbgResponse([
            { date: '2026-10-07T00:00:00.000Z', extra: true, currencies: [row({ newField: 1 })] },
        ]);
        expect(result.ok).toBe(true);
    });

    it('rejects a quantity that is not a positive power of ten as a shape change, never as a rate', () => {
        for (const quantity of [0, 0.5, -10, 3, 20]) {
            const result = parseNbgResponse(table([row({ quantity })]));
            expect(result.ok, String(quantity)).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe('upstream_shape_changed');
            }
        }
    });

    it('rejects a currency code that is not three uppercase ASCII letters as a shape change', () => {
        for (const code of ['usd', 'EURO', 'US', 'U$D', 'ÜSD', '']) {
            const result = parseNbgResponse(table([row({ code })]));
            expect(result.ok === false && result.error.kind, JSON.stringify(code)).toBe('upstream_shape_changed');
        }
    });

    it('rejects a row without validFromDate instead of guessing the effective date', () => {
        const withoutValidFrom = row();
        delete withoutValidFrom['validFromDate'];
        const result = parseNbgResponse(table([withoutValidFrom]));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('upstream_shape_changed');
        }
    });

    it('rejects rows that disagree on validFromDate', () => {
        const result = parseNbgResponse(
            table([row(), row({ code: 'EUR', validFromDate: '2026-10-08T00:00:00.000Z' })]),
        );
        expect(result.ok).toBe(false);
        if (!result.ok && result.error.kind === 'upstream_shape_changed') {
            expect(result.error.detail).toContain('validFromDate');
        }
    });

    it('rejects a table with no rows', () => {
        expect(parseNbgResponse(table([])).ok).toBe(false);
    });

    it('rejects a timestamp that does not start with YYYY-MM-DDT', () => {
        expect(parseNbgResponse(table([row({ validFromDate: '07.10.2026' })])).ok).toBe(false);
    });

    it('rejects a timestamp whose calendar date does not exist, as a shape change rather than a crash', () => {
        const result = parseNbgResponse(table([row({ validFromDate: '2026-02-30T00:00:00.000Z' })]));
        expect(result.ok === false && result.error.kind).toBe('upstream_shape_changed');
    });

    it('rejects a rate that is not positive or has more than four decimals, instead of rounding it', () => {
        for (const rate of [0, -2.6, 2.60191]) {
            const result = parseNbgResponse(table([row({ rate })]));
            expect(result.ok === false && result.error.kind, String(rate)).toBe('upstream_shape_changed');
        }
        expect(parseNbgResponse(table([row({ diff: 0.00001 })])).ok).toBe(false);
    });

    it('rejects a renamed field with a detail naming the path', () => {
        const result = parseNbgResponse([{ date: '2026-10-07T00:00:00.000Z', items: [] }]);
        expect(result.ok).toBe(false);
        if (!result.ok && result.error.kind === 'upstream_shape_changed') {
            expect(result.error.detail).toContain('currencies');
        }
    });

    it('rejects non-JSON-shaped input', () => {
        expect(parseNbgResponse('<html>').ok).toBe(false);
        expect(parseNbgResponse(null).ok).toBe(false);
    });
});

describe('isPowerOfTen', () => {
    it('accepts 1 to 10000 and rejects everything else', () => {
        expect([1, 10, 100, 1000, 10000].every(isPowerOfTen)).toBe(true);
        expect([0, 2, 20, 0.1, -10, 1.5].some(isPowerOfTen)).toBe(false);
    });
});

describe('hasAtMostFourDecimals', () => {
    it('accepts NBG precision and rejects anything finer', () => {
        expect([2.6021, 7.1762, 0.0151, 1, 0].every(hasAtMostFourDecimals)).toBe(true);
        expect([2.60191, 0.00001, 1.23456].some(hasAtMostFourDecimals)).toBe(false);
    });
});
