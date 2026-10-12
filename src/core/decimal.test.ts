import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
    add,
    decimalToRational,
    divide,
    fromInteger,
    multiply,
    roundHalfUp,
    subtract,
    type Rational,
} from './decimal.js';

function rational(numerator: bigint, denominator: bigint): Rational {
    return { numerator, denominator };
}

describe('decimalToRational', () => {
    it('reads integers, decimals and negatives from the shortest representation', () => {
        expect(decimalToRational(26)).toEqual(rational(26n, 1n));
        expect(decimalToRational(2.6005)).toEqual(rational(5201n, 2000n));
        expect(decimalToRational(0.0071783)).toEqual(rational(71783n, 10000000n));
        expect(decimalToRational(-1.5)).toEqual(rational(-3n, 2n));
        expect(decimalToRational(0)).toEqual(rational(0n, 1n));
    });

    it('expands exponent notation instead of reading its digits', () => {
        expect(decimalToRational(1e-7)).toEqual(rational(1n, 10000000n));
        expect(decimalToRational(1e21)).toEqual(rational(1000000000000000000000n, 1n));
        expect(decimalToRational(-2.5e-8)).toEqual(rational(-1n, 40000000n));
    });

    it('throws on a non-finite number, which the input schemas already reject', () => {
        expect(() => decimalToRational(Number.POSITIVE_INFINITY)).toThrow();
        expect(() => decimalToRational(Number.NaN)).toThrow();
    });
});

describe('arithmetic', () => {
    it('keeps the fraction reduced with a positive denominator', () => {
        expect(add(decimalToRational(0.5), decimalToRational(0.25))).toEqual(rational(3n, 4n));
        expect(subtract(decimalToRational(2.6032), decimalToRational(2.6042))).toEqual(rational(-1n, 1000n));
        expect(multiply(decimalToRational(1.5), decimalToRational(2.6005))).toEqual(rational(15603n, 4000n));
        expect(divide(fromInteger(100), decimalToRational(2.6005))).toEqual(rational(200000n, 5201n));
        expect(divide(fromInteger(1), rational(-1n, 2n))).toEqual(rational(-2n, 1n));
    });

    it('refuses a zero divisor and a non-integer in fromInteger', () => {
        expect(() => divide(fromInteger(1), rational(0n, 1n))).toThrow();
        expect(() => fromInteger(1.5)).toThrow();
    });
});

describe('roundHalfUp', () => {
    it('rounds ties up and away from zero', () => {
        expect(roundHalfUp(decimalToRational(26.005), 2)).toBe(26.01);
        expect(roundHalfUp(decimalToRational(-26.005), 2)).toBe(-26.01);
        expect(roundHalfUp(multiply(decimalToRational(1.5), decimalToRational(2.6005)), 2)).toBe(3.9);
        expect(roundHalfUp(divide(fromInteger(100), decimalToRational(2.6005)), 2)).toBe(38.45);
        expect(roundHalfUp(decimalToRational(3.00858), 4)).toBe(3.0086);
        expect(roundHalfUp(decimalToRational(16452), 2)).toBe(16452);
        expect(roundHalfUp(decimalToRational(2.5), 0)).toBe(3);
        // A quotient that is an exact tie: 0.0130125 / 2.6025 = 0.005.
        expect(roundHalfUp(divide(decimalToRational(0.0130125), decimalToRational(2.6025)), 2)).toBe(0.01);
        expect(roundHalfUp(divide(decimalToRational(-0.0130125), decimalToRational(2.6025)), 2)).toBe(-0.01);
    });

    it('refuses a negative or fractional number of decimals with an error that says so', () => {
        expect(() => roundHalfUp(decimalToRational(1), -1)).toThrow(/decimals/);
        expect(() => roundHalfUp(decimalToRational(1), 1.5)).toThrow(/decimals/);
    });

    it('returns a plain zero, never -0, when the value rounds to nothing', () => {
        const rounded = roundHalfUp(decimalToRational(-0.001), 2);
        expect(Object.is(rounded, 0)).toBe(true);
        expect(Object.is(roundHalfUp(decimalToRational(0), 2), 0)).toBe(true);
    });

    it('agrees with integer arithmetic for every amount times rate to two decimals', () => {
        // Oracle on integers only: amount and rate scaled by their decimals, product divided by scale and quantity.
        fc.assert(
            fc.property(
                fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
                fc.integer({ min: 0, max: 6 }),
                fc.integer({ min: 1, max: 99_999 }),
                fc.integer({ min: 1, max: 4 }),
                fc.constantFrom(1, 10, 100, 1000, 10000),
                (amountScaled, amountDecimals, rateScaled, rateDecimals, quantity) => {
                    const amount = Number(`${amountScaled}e-${amountDecimals}`);
                    const rate = Number(`${rateScaled}e-${rateDecimals}`);
                    const exact = divide(
                        multiply(decimalToRational(amount), decimalToRational(rate)),
                        fromInteger(quantity),
                    );
                    const scale = 10n ** BigInt(amountDecimals + rateDecimals);
                    const divisor = scale * BigInt(quantity);
                    const product = BigInt(amountScaled) * BigInt(rateScaled);
                    const magnitude = product < 0n ? -product : product;
                    const cents = (magnitude * 200n + divisor) / (2n * divisor);
                    const expected = Number(cents) / 100;
                    const rounded = roundHalfUp(exact, 2);
                    expect(rounded).toBe(product < 0n && cents !== 0n ? -expected : expected);
                    // The tie rule stated without the formula above: the floor, plus one when the remainder is half or
                    // more. The results stay below 1e13, where toFixed(2) reads back the cents exactly.
                    const floorValue = (magnitude * 100n) / divisor;
                    const remainder = (magnitude * 100n) % divisor;
                    const roundedCents = BigInt(Math.abs(rounded).toFixed(2).replace('.', ''));
                    expect(roundedCents).toBe(floorValue + (2n * remainder >= divisor ? 1n : 0n));
                },
            ),
        );
    });
});
