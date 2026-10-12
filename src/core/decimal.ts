/**
 * Exact arithmetic on decimal numbers as reduced fractions of BigInt. A conversion is amount * rate / quantity,
 * whose exact value is a terminating decimal for a currency to GEL and a repeating one for a division by a rate;
 * both round half up correctly here, which a float product (1.5 * 2.6005 = 3.9007499999999995) does not.
 */
export interface Rational {
    readonly numerator: bigint;
    /** Always positive; the fraction is reduced. */
    readonly denominator: bigint;
}

/** The shortest representation of a finite double: optional sign, digits, optional fraction, optional exponent. */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;

function gcd(a: bigint, b: bigint): bigint {
    let left = a < 0n ? -a : a;
    let right = b < 0n ? -b : b;
    while (right !== 0n) {
        [left, right] = [right, left % right];
    }
    return left;
}

function reduced(numerator: bigint, denominator: bigint): Rational {
    if (denominator === 0n) {
        throw new Error('division by zero');
    }
    const sign = denominator < 0n ? -1n : 1n;
    const divisor = gcd(numerator, denominator) || 1n;
    return { numerator: (sign * numerator) / divisor, denominator: (sign * denominator) / divisor };
}

function parts(value: number): { readonly sign: string; readonly digits: string; readonly scale: number } {
    if (!Number.isFinite(value)) {
        throw new Error(`not a finite number: ${value}`);
    }
    const match = DECIMAL.exec(String(value));
    if (match === null) {
        throw new Error(`unexpected number format: ${String(value)}`);
    }
    const [, sign = '', integer = '0', fraction = '', exponent = '0'] = match;
    // value = sign digits / 10^scale; a negative scale means trailing zeros.
    return { sign, digits: integer + fraction, scale: fraction.length - Number(exponent) };
}

export function decimalToRational(value: number): Rational {
    const { sign, digits, scale } = parts(value);
    const magnitude = BigInt(digits);
    const numerator = sign === '-' ? -magnitude : magnitude;
    return scale >= 0 ? reduced(numerator, 10n ** BigInt(scale)) : reduced(numerator * 10n ** BigInt(-scale), 1n);
}

export function fromInteger(value: number): Rational {
    if (!Number.isSafeInteger(value)) {
        throw new Error(`not a safe integer: ${value}`);
    }
    return { numerator: BigInt(value), denominator: 1n };
}

export function add(a: Rational, b: Rational): Rational {
    return reduced(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}

export function subtract(a: Rational, b: Rational): Rational {
    return reduced(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
}

export function multiply(a: Rational, b: Rational): Rational {
    return reduced(a.numerator * b.numerator, a.denominator * b.denominator);
}

export function divide(a: Rational, b: Rational): Rational {
    return reduced(a.numerator * b.denominator, a.denominator * b.numerator);
}

/** Half up, away from zero: 26.005 to 26.01 and -26.005 to -26.01. A value that rounds to nothing is 0, never -0. */
export function roundHalfUp(value: Rational, decimals: number): number {
    const scale = 10n ** BigInt(decimals);
    const negative = value.numerator < 0n;
    const magnitude = negative ? -value.numerator : value.numerator;
    const scaled = (magnitude * scale * 2n + value.denominator) / (2n * value.denominator);
    if (scaled === 0n) {
        return 0;
    }
    const digits = scaled.toString().padStart(decimals + 1, '0');
    const integer = digits.slice(0, digits.length - decimals);
    const fraction = digits.slice(digits.length - decimals);
    const text = decimals === 0 ? integer : `${integer}.${fraction}`;
    return Number(negative ? `-${text}` : text);
}

/** Decimals in the shortest representation: 0 for 26, 4 for 2.6005, 7 for 0.0071783 and for 1e-7. */
export function formatDecimals(value: number): number {
    return Math.max(0, parts(value).scale);
}
