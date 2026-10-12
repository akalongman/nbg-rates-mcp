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
                resultRounded: 260.25,
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

    it('fails with result_out_of_range when only the exact rounded result overflows, either sign', () => {
        // 6.14322911137722e307 EUR at 2.9263 is a hair above the largest double: the float product rounds down
        // to Number.MAX_VALUE, while the exact product rounded to two decimals does not fit a double.
        for (const amount of [6.14322911137722e307, -6.14322911137722e307]) {
            expect(Number.isFinite(amount * 2.9263)).toBe(true);
            expect(convertAmount(snapshot, amount, code('EUR'), GEL)).toEqual({
                ok: false,
                error: { kind: 'result_out_of_range', amount, from: 'EUR', to: 'GEL' },
            });
        }
    });

    it('fails with result_out_of_range for a non-finite amount instead of throwing', () => {
        // The tool schemas reject these; a direct caller still gets a Result.
        for (const amount of [Number.POSITIVE_INFINITY, Number.NaN]) {
            expect(convertAmount(snapshot, amount, code('USD'), GEL)).toEqual({
                ok: false,
                error: { kind: 'result_out_of_range', amount, from: 'USD', to: 'GEL' },
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

    it('rounds the exact product half up to two decimals, not the float', () => {
        // 1.5 * 2.6025 = 3.90375: below the half tetri, so 3.90 (which JSON carries as 3.9).
        const belowHalf = convertAmount(snapshot, 1.5, code('USD'), GEL);
        expect(belowHalf.ok && belowHalf.value.resultRounded).toBe(3.9);
        // 10 * 2.6025 = 26.025, a tie at the third decimal: half up gives 26.03, toFixed would give 26.02.
        const half = convertAmount(snapshot, 10, code('USD'), GEL);
        expect(half.ok && half.value.resultRounded).toBe(26.03);
        const negative = convertAmount(snapshot, -10, code('USD'), GEL);
        expect(negative.ok && negative.value.resultRounded).toBe(-26.03);
        // 1,000,000 AMD at 7.1748 per 1000 is 7174.8 exactly.
        const dram = convertAmount(snapshot, 1_000_000, code('AMD'), GEL);
        expect(dram.ok && dram.value.resultRounded).toBe(7174.8);
    });

    it('rounds a division by a rate and a cross pair from the exact quotient', () => {
        // 100 / 2.6025 = 38.4245916...
        const toUsd = convertAmount(snapshot, 100, GEL, code('USD'));
        expect(toUsd.ok && toUsd.value.resultRounded).toBe(38.42);
        // 100 * 2.6025 / 2.9263 = 88.9348...
        const cross = convertAmount(snapshot, 100, code('USD'), code('EUR'));
        expect(cross.ok && cross.value.resultRounded).toBe(88.93);
        const same = convertAmount(snapshot, 42.005, code('USD'), code('USD'));
        expect(same.ok && same.value.resultRounded).toBe(42.01);
        // An exact tie in a quotient: 0.0130125 GEL is 0.005 USD at 2.6025, half up to 0.01, away from zero.
        const tie = convertAmount(snapshot, 0.0130125, GEL, code('USD'));
        expect(tie.ok && tie.value.resultRounded).toBe(0.01);
        const negativeTie = convertAmount(snapshot, -0.0130125, GEL, code('USD'));
        expect(negativeTie.ok && negativeTie.value.resultRounded).toBe(-0.01);
    });

    it('matches an integer-only oracle for any amount and NBG-shaped quote to GEL', () => {
        // The oracle scales amount and rate to integers, multiplies, and rounds half up with integer division.
        fc.assert(
            fc.property(
                fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
                fc.integer({ min: 0, max: 6 }),
                fc.integer({ min: 1, max: 99_999 }),
                fc.integer({ min: 1, max: 4 }),
                fc.constantFrom(1, 10, 100, 1000, 10000),
                (amountScaled, amountDecimals, rateScaled, rateDecimals, quantity) => {
                    const amount = Number(`${amountScaled}e-${amountDecimals}`);
                    const nbgRate = Number(`${rateScaled}e-${rateDecimals}`);
                    const quoted: RatesSnapshot = {
                        ...snapshot,
                        rates: [
                            {
                                code: code('XYZ'),
                                name: 'Test',
                                rate: nbgRate / quantity,
                                diff: 0,
                                nbgQuantity: quantity,
                                nbgRate,
                            },
                        ],
                    };
                    const result = convertAmount(quoted, amount, code('XYZ'), GEL);
                    const divisor = 10n ** BigInt(amountDecimals + rateDecimals) * BigInt(quantity);
                    const product = BigInt(amountScaled) * BigInt(rateScaled);
                    const magnitude = product < 0n ? -product : product;
                    const cents = (magnitude * 200n + divisor) / (2n * divisor);
                    const expected = Number(cents) / 100;
                    expect(result.ok && result.value.resultRounded).toBe(
                        product < 0n && cents !== 0n ? -expected : expected,
                    );
                },
            ),
        );
    });

    it('keeps resultRounded within half a tetri of result, up to float error, for any pair', () => {
        const codes = [GEL, code('USD'), code('EUR'), code('AMD')];
        fc.assert(
            fc.property(
                fc.double({ min: -1e9, max: 1e9, noNaN: true, noDefaultInfinity: true }),
                fc.constantFrom(...codes),
                fc.constantFrom(...codes),
                (amount, from, to) => {
                    const result = convertAmount(snapshot, amount, from, to);
                    expect(result.ok).toBe(true);
                    if (result.ok) {
                        // result is at most three float operations from the exact value: a few ulps, far below 1e-14.
                        expect(Math.abs(result.value.resultRounded - result.value.result)).toBeLessThanOrEqual(
                            0.005 + 1e-14 * Math.abs(result.value.result),
                        );
                        expect(Number(result.value.resultRounded.toFixed(2))).toBe(result.value.resultRounded);
                    }
                },
            ),
        );
    });
});
