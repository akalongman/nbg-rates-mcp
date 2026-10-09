import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { code, date } from '../../test/helpers/values.js';
import { GEL } from './currency-code.js';
import { convertAmount } from './convert.js';
import type { RatesSnapshot } from './types.js';

const snapshot: RatesSnapshot = {
    requestedDate: date('2026-10-07'),
    effectiveDate: date('2026-10-07'),
    carriedOver: false,
    rates: [
        { code: code('USD'), name: 'US Dollar', rate: 2.6025, diff: -0.0007, nbgQuantity: 1, nbgRate: 2.6025 },
        { code: code('EUR'), name: 'Euro', rate: 2.9263, diff: 0.001, nbgQuantity: 1, nbgRate: 2.9263 },
        { code: code('AMD'), name: 'Armenian Dram', rate: 0.0071748, diff: 0, nbgQuantity: 1000, nbgRate: 7.1748 },
    ],
    unknownCodes: [],
};

describe('convertAmount', () => {
    it('converts a foreign currency to GEL directly', () => {
        const result = convertAmount(snapshot, 100, code('USD'), GEL);
        expect(result).toEqual({
            ok: true,
            value: {
                amount: 100,
                from: 'USD',
                to: 'GEL',
                result: 260.25,
                rate: 2.6025,
                via: 'direct',
                requestedDate: '2026-10-07',
                effectiveDate: '2026-10-07',
                carriedOver: false,
            },
        });
    });

    it('converts GEL to a foreign currency directly', () => {
        const result = convertAmount(snapshot, 260.25, GEL, code('USD'));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.result).toBeCloseTo(100, 10);
            expect(result.value.rate).toBeCloseTo(1 / 2.6025, 12);
            expect(result.value.via).toBe('direct');
        }
    });

    it('converts a cross pair through GEL', () => {
        const result = convertAmount(snapshot, 100, code('USD'), code('EUR'));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.via).toBe('GEL');
            expect(result.value.rate).toBeCloseTo(2.6025 / 2.9263, 12);
            expect(result.value.result).toBeCloseTo((100 * 2.6025) / 2.9263, 10);
        }
    });

    it('treats identical codes and GEL to GEL as rate 1', () => {
        for (const [from, to] of [
            [code('USD'), code('USD')],
            [GEL, GEL],
        ] as const) {
            const result = convertAmount(snapshot, 42, from, to);
            expect(result).toMatchObject({ ok: true, value: { rate: 1, result: 42, via: 'direct' } });
        }
    });

    it('fails with unknown_currency when either side is missing from the table', () => {
        const missing = convertAmount(snapshot, 1, code('XXX'), GEL);
        expect(missing).toEqual({ ok: false, error: { kind: 'unknown_currency', code: 'XXX' } });
        const missingTo = convertAmount(snapshot, 1, GEL, code('ZZZ'));
        expect(missingTo).toEqual({ ok: false, error: { kind: 'unknown_currency', code: 'ZZZ' } });
    });

    it('fails with result_out_of_range when the result does not fit in a double, either sign', () => {
        // 1e308 USD is about 3.6e310 AMD, beyond the largest double, so the product is Infinity.
        for (const amount of [1e308, -1e308]) {
            expect(convertAmount(snapshot, amount, code('USD'), code('AMD'))).toEqual({
                ok: false,
                error: { kind: 'result_out_of_range', amount, from: 'USD', to: 'AMD' },
            });
        }
    });

    it('property: converting there and back returns the amount within float tolerance', () => {
        const codes = [GEL, code('USD'), code('EUR'), code('AMD')];
        fc.assert(
            fc.property(
                fc.double({ min: -1e9, max: 1e9, noNaN: true, noDefaultInfinity: true }),
                fc.constantFrom(...codes),
                fc.constantFrom(...codes),
                (amount, from, to) => {
                    const there = convertAmount(snapshot, amount, from, to);
                    if (!there.ok) {
                        return false;
                    }
                    const back = convertAmount(snapshot, there.value.result, to, from);
                    return back.ok && Math.abs(back.value.result - amount) <= Math.abs(amount) * 1e-9 + 1e-9;
                },
            ),
        );
    });
});
