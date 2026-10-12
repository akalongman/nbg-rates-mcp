# nbg-rates-mcp 0.4.0 Accountant Arithmetic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 0.4.0 with exact server-side rounding on every conversion (`resultRounded`), a computed `summary` on `nbg_rate_history`, a batch tool `nbg_convert_many` with per-item errors, and wording that matches what an accountant sees on nbg.gov.ge.

**Architecture:** A new pure module `src/core/decimal.ts` does exact rational arithmetic on BigInt and half-up rounding; `convert.ts` and a new `history-summary.ts` use it, so no float ever reaches a rounded field. `server.ts` gains a shared `prepareConversion` step used by `nbg_convert` and the new `nbg_convert_many`, which groups items by date and asks the service once per date. Two error variants change (`invalid_currency_code` is new, `rate_not_published` carries `today`), and the wording lives in constants, prompt texts and the manifest, held equal by the existing drift tests.

**Tech Stack:** TypeScript 6.0, Node 22+, ESM, `@modelcontextprotocol/server` 2.3 and `@modelcontextprotocol/client` 2.3, Zod 4, Vitest 5, fast-check 4.

**Spec:** `docs/superpowers/specs/2026-10-12-accountant-arithmetic-design.md` (amends `docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md`).

## Global Constraints

- No existing output field changes value or shape. `result` and `rate` keep their float computation; `resultRounded` and `summary` are added beside them.
- `resultRounded`: exact arithmetic on the decimal strings of the amount, `nbgRate` and `nbgQuantity`, rounded half up to 2 decimals, away from zero for negatives. Never computed from `result`.
- `summary.average`: arithmetic mean over every calendar day of the range, carried-over days included; `summary.change` is `last - first`; both exact, rounded half up to the series' decimals (the largest decimal count among the days' rates). `minDate` and `maxDate` are the first occurrence.
- `nbg_convert_many`: 1 to 100 items; per-item errors with the same text `nbg_convert` gives; one `service.getSnapshot` call per distinct date, sequential; `total` only when every converted item has the same `to`, summed from the items' `resultRounded` values.
- Error texts, prompt texts and descriptions exactly as quoted in the spec's Change 1. `manifest.json` prompt texts equal `PROMPTS` verbatim (existing drift test).
- `src/core/**` stays pure: no Node built-ins, no shell imports (eslint enforces it). BigInt is a language feature, not a built-in module.
- Version 0.4.0 in `package.json`, `package-lock.json` (both places `npm version` writes), `manifest.json`, both fields of `server.json`; `CHANGELOG.md` section `## 0.4.0 - <release date>` with the spec's entry.
- Repository rules: ESM with `.js` import extensions; strict tsconfig with `exactOptionalPropertyTypes`; 4-space indent, 120 columns, single quotes; no `any`, no `!`, `as` only at validated JSON boundaries; discriminated unions with an exhaustive `never` default; prose agent-neutral; no em or en dashes anywhere, including README, manifest, prompt texts and commit messages.
- Commit with explicit paths in one command: `git add <paths> && git commit -m "<title>" -- <paths>`. Commits are signed by the repository's configured signing; never bypass it. Commit on `main` (the maintainer's choice for this work); never push and never tag.
- Gates for every task: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`.

## Review Focus

1. An amount the model sends in exponent notation (`1e-7`, `1e21`) or as a negative with a fraction: `String(value)` yields `1e-7`, which a naive digit parser reads as 1. Pinned in Task 1, Step 1 (`decimalToRational` cases).
2. A rounded result that is exactly zero or rounds to zero from a negative (`-0.001` to 2 decimals): a `-0` reaches JSON as `0` but fails an equality test and reads oddly in logs. Pinned in Task 1, Step 1 (`roundHalfUp` returns `0`, never `-0`).
3. A batch whose items are all GEL to GEL: no snapshot is needed and the service must not be called. Pinned in Task 5, Step 1.
4. A batch where one date fails (not published) and another succeeds: the failing date must fail only its own items, and `converted`, `skipped` and `total` must count correctly. Pinned in Task 5, Step 1.
5. A history series where the minimum occurs twice: `minDate` must be the first occurrence, and the same for `maxDate`. Pinned in Task 4, Step 1.

---

### Task 1: Exact decimal arithmetic in core

**Files:**
- Create: `src/core/decimal.ts`
- Test: `src/core/decimal.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Rational { readonly numerator: bigint; readonly denominator: bigint }` (denominator always positive, fraction reduced).
  - `decimalToRational(value: number): Rational` (throws on a non-finite number).
  - `fromInteger(value: number): Rational` (throws unless `Number.isSafeInteger`).
  - `add(a: Rational, b: Rational): Rational`, `subtract(a, b)`, `multiply(a, b)`, `divide(a, b)` (throws on a zero divisor).
  - `roundHalfUp(value: Rational, decimals: number): number` (half up, away from zero, never `-0`).
  - `formatDecimals(value: number): number` (decimals in the shortest representation).

- [ ] **Step 1: Write the failing tests**

Create `src/core/decimal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
    add,
    decimalToRational,
    divide,
    formatDecimals,
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
                    expect(roundHalfUp(exact, 2)).toBe(product < 0n && cents !== 0n ? -expected : expected);
                },
            ),
        );
    });
});

describe('formatDecimals', () => {
    it('counts the decimals of the shortest representation', () => {
        expect(formatDecimals(26)).toBe(0);
        expect(formatDecimals(2.6005)).toBe(4);
        expect(formatDecimals(2.604)).toBe(3);
        expect(formatDecimals(0.0071783)).toBe(7);
        expect(formatDecimals(1e-7)).toBe(7);
        expect(formatDecimals(1e21)).toBe(0);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/core/decimal.test.ts`
Expected: FAIL, "Failed to resolve import './decimal.js'".

- [ ] **Step 3: Write the module**

Create `src/core/decimal.ts`:

```ts
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
    return scale >= 0
        ? reduced(numerator, 10n ** BigInt(scale))
        : reduced(numerator * 10n ** BigInt(-scale), 1n);
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/core/decimal.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test`
Expected: all pass (fix formatting with `npm run format` if Prettier complains).

```bash
git add src/core/decimal.ts src/core/decimal.test.ts && git commit -m "Add exact rational arithmetic with half-up rounding" -- src/core/decimal.ts src/core/decimal.test.ts
```

---

### Task 2: `resultRounded` on every conversion

**Files:**
- Modify: `src/core/types.ts` (`Conversion`)
- Modify: `src/core/convert.ts`
- Modify: `src/core/convert.test.ts`
- Modify: `src/shell/tool-schemas.ts` (`convertOutput`)
- Modify: `src/shell/server.ts` (the GEL to GEL identity branch)
- Modify: `src/shell/server.test.ts`, `test/e2e/stdio.test.ts`

**Interfaces:**
- Consumes: Task 1 (`decimalToRational`, `fromInteger`, `multiply`, `divide`, `roundHalfUp`).
- Produces: `Conversion.resultRounded: number`; `convertAmount` unchanged in signature; new export `roundedAmount(amount: number): number` in `convert.ts` for the identity case.

- [ ] **Step 1: Write the failing tests**

In `src/core/convert.test.ts`, add to the first test's expected `value` (after `result: 260.25`):

```ts
                resultRounded: 260.25,
```

and add these tests inside `describe('convertAmount', ...)`:

```ts
    it('rounds the exact product half up to two decimals, not the float', () => {
        // 1.5 * 2.6025 = 3.90375: below the half tetri, so 3.90 (which JSON carries as 3.9).
        const tie = convertAmount(snapshot, 1.5, code('USD'), GEL);
        expect(tie.ok && tie.value.resultRounded).toBe(3.9);
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
```

In `src/shell/server.test.ts`, inside `describe('createServer', ...)`, add:

```ts
    it('answers nbg_convert with resultRounded beside the unrounded result', async () => {
        const { service } = tableService();
        const client = await connectedClient({ service });

        const result = await client.callTool({
            name: 'nbg_convert',
            arguments: { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-07' },
        });
        expect(result.structuredContent).toMatchObject({ result: 10 * 2.6025, resultRounded: 26.03 });

        const identity = await client.callTool({
            name: 'nbg_convert',
            arguments: { amount: 5.005, from: 'GEL', to: 'GEL', date: '2026-10-07' },
        });
        expect(identity.structuredContent).toMatchObject({ result: 5.005, resultRounded: 5.01, rate: 1 });
        await client.close();
    });
```

In `test/e2e/stdio.test.ts`, in the test `converts USD to EUR through GEL`, add after the `toBeCloseTo` line:

```ts
        // 100 USD in EUR is not a tie at the third decimal on 2026-10-07, so toFixed and half up agree here.
        expect(output.resultRounded).toBe(Number(output.result.toFixed(2)));
        expect(String(output.resultRounded)).toMatch(/^-?\d+(\.\d{1,2})?$/);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/core/convert.test.ts src/shell/server.test.ts`
Expected: FAIL on `resultRounded` being `undefined`.

- [ ] **Step 3: Implement**

In `src/core/types.ts`, add to `Conversion` after `result`:

```ts
    /** result rounded half up to two decimals from the exact value; the amount to show. */
    readonly resultRounded: number;
```

Replace `src/core/convert.ts` with:

```ts
import { GEL } from './currency-code.js';
import { decimalToRational, divide, fromInteger, multiply, roundHalfUp, type Rational } from './decimal.js';
import {
    err,
    ok,
    type Conversion,
    type CurrencyCode,
    type RatesError,
    type RatesSnapshot,
    type Result,
} from './types.js';

interface Quote {
    /** GEL per one unit, as a float, for the unrounded fields. */
    readonly rate: number;
    /** The exact quote: nbgRate GEL per nbgQuantity units; GEL is 1 per 1. */
    readonly nbgRate: number;
    readonly nbgQuantity: number;
}

function quoteOf(snapshot: RatesSnapshot, code: CurrencyCode): Result<Quote, RatesError> {
    if (code === GEL) {
        return ok({ rate: 1, nbgRate: 1, nbgQuantity: 1 });
    }
    const entry = snapshot.rates.find((candidate) => candidate.code === code);
    if (entry === undefined) {
        return err({ kind: 'unknown_currency', code });
    }
    return ok({ rate: entry.rate, nbgRate: entry.nbgRate, nbgQuantity: entry.nbgQuantity });
}

/** amount * fromRate / fromQuantity * toQuantity / toRate, exactly. */
function exactResult(amount: number, from: Quote, to: Quote): Rational {
    const inGel = divide(
        multiply(decimalToRational(amount), decimalToRational(from.nbgRate)),
        fromInteger(from.nbgQuantity),
    );
    return divide(multiply(inGel, fromInteger(to.nbgQuantity)), decimalToRational(to.nbgRate));
}

/** The amount as a ledger would post it: half up to two decimals. */
export function roundedAmount(amount: number): number {
    return roundHalfUp(decimalToRational(amount), 2);
}

export function convertAmount(
    snapshot: RatesSnapshot,
    amount: number,
    from: CurrencyCode,
    to: CurrencyCode,
): Result<Conversion, RatesError> {
    const fromQuote = quoteOf(snapshot, from);
    if (!fromQuote.ok) {
        return fromQuote;
    }
    const toQuote = quoteOf(snapshot, to);
    if (!toQuote.ok) {
        return toQuote;
    }
    const identical = from === to;
    const rate = identical ? 1 : fromQuote.value.rate / toQuote.value.rate;
    const via: Conversion['via'] = identical || from === GEL || to === GEL ? 'direct' : 'GEL';
    const result = identical ? amount : amount * rate;
    if (!Number.isFinite(result)) {
        return err({ kind: 'result_out_of_range', amount, from, to });
    }
    const resultRounded = identical
        ? roundedAmount(amount)
        : roundHalfUp(exactResult(amount, fromQuote.value, toQuote.value), 2);
    return ok({
        amount,
        from,
        to,
        result,
        resultRounded,
        rate,
        via,
        requestedDate: snapshot.requestedDate,
        effectiveDate: snapshot.effectiveDate,
        carriedOver: snapshot.carriedOver,
    });
}
```

In `src/shell/tool-schemas.ts`, in `convertOutput` after `result`:

```ts
    resultRounded: z
        .number()
        .describe(
            'result rounded half up to 2 decimals from the exact value; the amount to show. JSON drops trailing zeros, so 3.90 arrives as 3.9.',
        ),
```

In `src/shell/server.ts`: import `roundedAmount` from `'../core/convert.js'` beside `convertAmount`, and in the GEL to GEL branch of `nbg_convert` add after `result: amount,`:

```ts
                    resultRounded: roundedAmount(amount),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/core/convert.test.ts src/shell/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: all pass.

```bash
git add src/core/types.ts src/core/convert.ts src/core/convert.test.ts src/shell/tool-schemas.ts src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts && git commit -m "Add resultRounded, the exact half-up amount, to every conversion" -- src/core/types.ts src/core/convert.ts src/core/convert.test.ts src/shell/tool-schemas.ts src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts
```

---

### Task 3: A distinct error for a non-code, and today's date in the future-date error

**Files:**
- Modify: `src/core/types.ts` (`RatesError`)
- Modify: `src/core/currency-code.ts`, `src/core/currency-code.test.ts`
- Modify: `src/core/dates.ts`, `src/core/dates.test.ts`
- Modify: `src/core/normalize.ts`, `src/core/normalize.test.ts`
- Modify: `src/core/history.ts`, `src/core/history.test.ts`
- Modify: `src/shell/rates-service.test.ts`
- Modify: `src/shell/server.ts` (`describeError`), `src/shell/server.test.ts`

**Interfaces:**
- Consumes: `addDays` from `src/core/dates.ts`.
- Produces: `RatesError` variants `{ kind: 'invalid_currency_code'; value: string }` and `{ kind: 'rate_not_published'; date; latestEffectiveDate; today: CalendarDate }`.

- [ ] **Step 1: Write the failing tests**

`src/core/currency-code.test.ts`, in `rejects anything that is not three letters`, replace the expectation:

```ts
                expect(result.error).toEqual({ kind: 'invalid_currency_code', value: input });
```

`src/core/dates.test.ts`, in `rejects the day after tomorrow and later as not published, without a latest date`:

```ts
            error: { kind: 'rate_not_published', date: '2099-01-01', latestEffectiveDate: undefined, today: '2026-10-08' },
```

`src/core/normalize.test.ts` line 117 and `src/core/history.test.ts` line 190: add `today: '2026-10-07'` to the expected error object (read the surrounding test to confirm the `today` value each passes in; the expectation must name the same date). `src/shell/rates-service.test.ts` line 94: add `today: '2026-10-08'` (the service's clock in that file is 2026-10-08 in Tbilisi; confirm against its `now`).

`src/shell/server.test.ts`, in `describeError` cases, replace the two `rate_not_published` cases and add one for the new kind:

```ts
            [
                { kind: 'invalid_currency_code', value: 'dollar' },
                /"dollar" is not a currency code.*ISO 4217.*USD.*EUR.*GEL/,
            ],
            [
                {
                    kind: 'rate_not_published',
                    date: date('2026-10-09'),
                    latestEffectiveDate: date('2026-10-08'),
                    today: date('2026-10-08'),
                },
                /2026-10-09 yet\. Today in Tbilisi is 2026-10-08; the latest date that can have a rate is 2026-10-09, after about 17:00 Tbilisi time\. The latest published rate is valid from 2026-10-08\. For a range, end it at today\./,
            ],
            [
                { kind: 'rate_not_published', date: date('2099-01-01'), latestEffectiveDate: undefined, today: date('2026-10-08') },
                /2099-01-01 yet\. Today in Tbilisi is 2026-10-08; the latest date that can have a rate is 2026-10-09, after about 17:00 Tbilisi time\. For a range, end it at today\./,
            ],
```

and at line 395 (the `unpublished` stub) add `today: date('2026-10-08')` to the error object. Add a server test:

```ts
    it('tells the model a word is not a code instead of sending it to the currency list', async () => {
        const client = await connectedClient();
        const result = await client.callTool({
            name: 'nbg_convert',
            arguments: { amount: 1, from: 'dollar', to: 'GEL', date: '2026-10-07' },
        });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
            { type: 'text', text: describeError({ kind: 'invalid_currency_code', value: 'dollar' }) },
        ]);
        expect(JSON.stringify(result.content)).not.toContain('nbg_list_currencies');
        await client.close();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run typecheck; npm test`
Expected: typecheck errors on the new fields, and the edited tests fail.

- [ ] **Step 3: Implement**

`src/core/types.ts`: in `RatesError` add after `unknown_currency`:

```ts
    | { readonly kind: 'invalid_currency_code'; readonly value: string }
```

and add to `rate_not_published`:

```ts
          readonly today: CalendarDate;
```

`src/core/currency-code.ts`: return `err({ kind: 'invalid_currency_code', value: input })`.

`src/core/dates.ts`, `rejectBeyondTomorrow`: `err({ kind: 'rate_not_published', date, latestEffectiveDate: undefined, today })`.

`src/core/normalize.ts`, `requirePublished`: add `today` to the returned error.

`src/core/history.ts`, `assembleHistory`: add `today` to the `rate_not_published` error.

`src/shell/server.ts`: import `addDays` from `'../core/dates.js'`; in `describeError`:

```ts
        case 'invalid_currency_code':
            return `"${error.value}" is not a currency code. Use the three-letter ISO 4217 code, for example USD for US dollars, EUR for euros or GEL for lari.`;
        case 'rate_not_published': {
            const latest =
                error.latestEffectiveDate === undefined
                    ? ''
                    : ` The latest published rate is valid from ${error.latestEffectiveDate}.`;
            return (
                `NBG has not published a rate for ${error.date} yet. Today in Tbilisi is ${error.today}; ` +
                `the latest date that can have a rate is ${addDays(error.today, 1)}, after about 17:00 Tbilisi time.` +
                `${latest} For a range, end it at today. ${PUBLICATION_RULE}`
            );
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`

```bash
git add src/core/types.ts src/core/currency-code.ts src/core/currency-code.test.ts src/core/dates.ts src/core/dates.test.ts src/core/normalize.ts src/core/normalize.test.ts src/core/history.ts src/core/history.test.ts src/shell/rates-service.test.ts src/shell/server.ts src/shell/server.test.ts && git commit -m "Name the last answerable date and tell a word from a currency code" -- src/core/types.ts src/core/currency-code.ts src/core/currency-code.test.ts src/core/dates.ts src/core/dates.test.ts src/core/normalize.ts src/core/normalize.test.ts src/core/history.ts src/core/history.test.ts src/shell/rates-service.test.ts src/shell/server.ts src/shell/server.test.ts
```

---

### Task 4: History summary

**Files:**
- Create: `src/core/history-summary.ts`, `src/core/history-summary.test.ts`
- Modify: `src/shell/history-output.ts`, `src/shell/history-output.test.ts`
- Modify: `src/shell/tool-schemas.ts` (`rateHistoryOutput`)
- Modify: `src/shell/server.ts` (history tool description)
- Modify: `src/shell/server.test.ts` (the exact history JSON), `test/e2e/stdio.test.ts`

**Interfaces:**
- Consumes: Task 1 (`add`, `subtract`, `divide`, `fromInteger`, `decimalToRational`, `roundHalfUp`, `formatDecimals`).
- Produces: `interface HistorySummary { first; last; change; min; minDate; max; maxDate; average }` and `summarizeHistory(days: ReadonlyArray<HistoryPoint>): HistorySummary`; `HistoryOutput.summary: HistorySummary`.

- [ ] **Step 1: Write the failing tests**

Create `src/core/history-summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { date } from '../../test/helpers/values.js';
import { addDays } from './dates.js';
import { summarizeHistory } from './history-summary.js';
import type { HistoryPoint } from './types.js';

function point(day: string, effective: string, rate: number): HistoryPoint {
    return { date: date(day), effectiveDate: date(effective), rate, carriedOver: effective < day };
}

describe('summarizeHistory', () => {
    it('reports first, last, exact change, extremes with their first dates and the calendar-day mean', () => {
        // USD 2026-10-02 to 2026-10-06: Saturday has its own table, Sunday and Monday carry it.
        const summary = summarizeHistory([
            point('2026-10-02', '2026-10-02', 2.6042),
            point('2026-10-03', '2026-10-03', 2.6039),
            point('2026-10-04', '2026-10-03', 2.6039),
            point('2026-10-05', '2026-10-03', 2.6039),
            point('2026-10-06', '2026-10-06', 2.6032),
        ]);
        // Sum 13.0191 over 5 days is 2.60382, half up at four decimals 2.6038; change -0.0010 arrives as -0.001.
        expect(summary).toEqual({
            first: 2.6042,
            last: 2.6032,
            change: -0.001,
            min: 2.6032,
            minDate: '2026-10-06',
            max: 2.6042,
            maxDate: '2026-10-02',
            average: 2.6038,
        });
    });

    it('names the first day an extreme occurs on, and rounds at the most precise rate', () => {
        const summary = summarizeHistory([
            point('2026-09-01', '2026-09-01', 0.00717),
            point('2026-09-02', '2026-09-02', 0.0071783),
            point('2026-09-03', '2026-09-03', 0.0071783),
            point('2026-09-04', '2026-09-04', 0.00717),
        ]);
        expect(summary).toMatchObject({ min: 0.00717, minDate: '2026-09-01', max: 0.0071783, maxDate: '2026-09-02' });
        // (0.00717 * 2 + 0.0071783 * 2) / 4 = 0.00717415, half up at seven decimals 0.0071742.
        expect(summary.average).toBe(0.0071742);
        expect(summary.change).toBe(0);
    });

    it('is bounded by the extremes and consistent for any series', () => {
        fc.assert(
            fc.property(
                fc.array(fc.integer({ min: 1, max: 99_999 }), { minLength: 1, maxLength: 366 }),
                (scaledRates) => {
                    const days = scaledRates.map((scaled, offset) =>
                        point(addDays(date('2026-01-01'), offset), addDays(date('2026-01-01'), offset), scaled / 10000),
                    );
                    const summary = summarizeHistory(days);
                    expect(summary.min).toBeLessThanOrEqual(summary.average);
                    expect(summary.average).toBeLessThanOrEqual(summary.max);
                    expect(summary.first).toBe(days[0]?.rate);
                    expect(summary.last).toBe(days[days.length - 1]?.rate);
                    expect(Math.abs(summary.change - (summary.last - summary.first))).toBeLessThan(0.00005);
                },
            ),
        );
    });

    it('throws on an empty series, which assembleHistory never produces', () => {
        expect(() => summarizeHistory([])).toThrow();
    });
});
```

In `src/shell/history-output.test.ts`, first test, change the expected JSON string to end with the summary instead of `]}`:

```ts
                '{"date":"2026-10-06","rate":2.6032}],' +
                '"summary":{"first":2.6042,"last":2.6032,"change":-0.001,"min":2.6032,"minDate":"2026-10-06",' +
                '"max":2.6042,"maxDate":"2026-10-02","average":2.6038}}',
```

Read the other two tests in that file: the second compares days only (keep it, use `output.days` if it compares the whole object), and the third bounds a full year's length at 21,000 characters; the summary adds about 150 characters, so the bound holds. Adjust the assertion only if it compares the whole object.

In `src/shell/server.test.ts`, the test `answers nbg_rate_history with compact days and the same JSON in its one text block` asserts the exact wire JSON for the same five days. Change the end of its `text` constant from `'{"date":"2026-10-06","rate":2.6032}]}'` to:

```ts
            '{"date":"2026-10-06","rate":2.6032}],' +
            '"summary":{"first":2.6042,"last":2.6032,"change":-0.001,"min":2.6032,"minDate":"2026-10-06",' +
            '"max":2.6042,"maxDate":"2026-10-02","average":2.6038}}';
```

In `test/e2e/stdio.test.ts`, in `returns one history point per calendar day from a single CSV request`, after `expect(output.days).toHaveLength(7);` add:

```ts
        expect(output.summary).toMatchObject({ first: output.days[0]?.rate, last: output.days[6]?.rate });
        expect(output.summary.min).toBeLessThanOrEqual(output.summary.average);
        expect(output.summary.average).toBeLessThanOrEqual(output.summary.max);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/core/history-summary.test.ts src/shell/history-output.test.ts`
Expected: FAIL, module not found and JSON mismatch.

- [ ] **Step 3: Implement**

Create `src/core/history-summary.ts`:

```ts
import { add, decimalToRational, divide, formatDecimals, fromInteger, roundHalfUp, subtract } from './decimal.js';
import type { CalendarDate, HistoryPoint } from './types.js';

export interface HistorySummary {
    readonly first: number;
    readonly last: number;
    /** last - first, exact, at the series' decimals. */
    readonly change: number;
    readonly min: number;
    /** The first calendar day the minimum occurs on. */
    readonly minDate: CalendarDate;
    readonly max: number;
    /** The first calendar day the maximum occurs on. */
    readonly maxDate: CalendarDate;
    /** Arithmetic mean over every calendar day, carried-over days included, at the series' decimals. */
    readonly average: number;
}

/**
 * The series' decimals are those of its most precise rate (4 for USD, 7 for AMD), which is how NBG prints its
 * own period averages. A carried-over day counts like any other: the rate was in force on it.
 */
export function summarizeHistory(days: ReadonlyArray<HistoryPoint>): HistorySummary {
    const first = days[0];
    const last = days[days.length - 1];
    if (first === undefined || last === undefined) {
        throw new Error('summarizeHistory needs at least one day');
    }
    let min = first;
    let max = first;
    let decimals = 0;
    let sum = fromInteger(0);
    for (const day of days) {
        if (day.rate < min.rate) {
            min = day;
        }
        if (day.rate > max.rate) {
            max = day;
        }
        decimals = Math.max(decimals, formatDecimals(day.rate));
        sum = add(sum, decimalToRational(day.rate));
    }
    return {
        first: first.rate,
        last: last.rate,
        change: roundHalfUp(subtract(decimalToRational(last.rate), decimalToRational(first.rate)), decimals),
        min: min.rate,
        minDate: min.date,
        max: max.rate,
        maxDate: max.date,
        average: roundHalfUp(divide(sum, fromInteger(days.length)), decimals),
    };
}
```

`src/shell/history-output.ts`: import `summarizeHistory` and `type HistorySummary` from `'../core/history-summary.js'`; add `readonly summary: HistorySummary;` to `HistoryOutput` after `days`; in `historyOutput` return `{ ..., days: series.days.map(historyDayOutput), summary: summarizeHistory(series.days) }`.

`src/shell/tool-schemas.ts`, in `rateHistoryOutput` after `days`:

```ts
    summary: z
        .object({
            first: z.number().describe('Rate on from'),
            last: z.number().describe('Rate on to'),
            change: z.number().describe('last minus first, exact, at the decimals of the rates'),
            min: z.number(),
            minDate: z.string().describe('First calendar day the minimum occurs on'),
            max: z.number(),
            maxDate: z.string().describe('First calendar day the maximum occurs on'),
            average: z
                .number()
                .describe('Arithmetic mean over every calendar day of the range, carried-over days included'),
        })
        .describe(
            'Computed by the server; report these instead of deriving them from days. change and average are exact, ' +
                'rounded half up to the decimals of the most precise daily rate (4 for USD, 7 for AMD).',
        ),
```

`src/shell/server.ts`, `nbg_rate_history` description: append before `'One NBG request per call.'`:

```ts
                'summary holds the first, last, change, lowest and highest rate with their dates, and the average ' +
                'over the calendar days, computed by the server: report those rather than deriving them. ' +
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/core/history-summary.test.ts src/shell/history-output.test.ts src/shell/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`

```bash
git add src/core/history-summary.ts src/core/history-summary.test.ts src/shell/history-output.ts src/shell/history-output.test.ts src/shell/tool-schemas.ts src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts && git commit -m "Summarise a rate history: first, last, change, extremes and calendar-day average" -- src/core/history-summary.ts src/core/history-summary.test.ts src/shell/history-output.ts src/shell/history-output.test.ts src/shell/tool-schemas.ts src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts
```

---

### Task 5: `nbg_convert_many`

**Files:**
- Modify: `src/shell/tool-schemas.ts` (`convertManyInput`, `convertManyOutput`)
- Modify: `src/shell/server.ts` (shared `prepareConversion`, the new tool)
- Modify: `src/shell/server.test.ts`, `test/e2e/stdio.test.ts`
- Modify: `manifest.json` (`tools`)

**Interfaces:**
- Consumes: Task 2 (`roundedAmount`, `Conversion.resultRounded`), Task 3 (`describeError` texts), Task 1 (`add`, `decimalToRational`, `roundHalfUp`).
- Produces: tool `nbg_convert_many` with input `{ items: Array<{ amount, from, to, date? }> }` (1 to 100) and output `{ items, converted, skipped, total? }`.

- [ ] **Step 1: Write the failing tests**

In `src/shell/server.test.ts`:

In `registers the four nbg_ tools and the rates resource`, rename to `registers the five nbg_ tools and the rates resource` and add `'nbg_convert_many'` to the sorted expected list (between `nbg_convert` and `nbg_get_rates`).

In `shows the title and description it sends in the bundle manifest as well`, extend the manifest schema with `tools: z.array(z.object({ name: z.string() }))` and add:

```ts
        const { tools } = await client.listTools();
        expect(manifest.tools.map((tool) => tool.name).sort()).toEqual(tools.map((tool) => tool.name).sort());
```

Add a `describe('nbg_convert_many', ...)` block:

```ts
describe('nbg_convert_many', () => {
    it('answers every item, fails only the bad ones, and totals the rounded amounts of one target', async () => {
        const { service, requests } = tableService();
        const client = await connectedClient({ service });

        const result = await client.callTool({
            name: 'nbg_convert_many',
            arguments: {
                items: [
                    { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-07' },
                    { amount: 1.5, from: 'usd', to: 'gel', date: '2026-10-07' },
                    { amount: 100, from: 'USD', to: 'GEL', date: '2026-13-01' },
                    { amount: 7, from: 'dollar', to: 'GEL', date: '2026-10-07' },
                    { amount: 1, from: 'XXX', to: 'GEL', date: '2026-10-07' },
                    // Inputs the single tool's schema would reject outright must fail only their own item here.
                    { amount: 8, from: 'Armenian dram', to: 'GEL', date: '10.09.2026' },
                    { amount: 9, from: '', to: 'GEL', date: '2026-10-07' },
                ],
            },
        });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({
            items: [
                {
                    amount: 10,
                    from: 'USD',
                    to: 'GEL',
                    result: 10 * 2.6025,
                    resultRounded: 26.03,
                    rate: 2.6025,
                    via: 'direct',
                    requestedDate: '2026-10-07',
                    effectiveDate: '2026-10-07',
                    carriedOver: false,
                },
                {
                    amount: 1.5,
                    from: 'USD',
                    to: 'GEL',
                    result: 1.5 * 2.6025,
                    resultRounded: 3.9,
                    rate: 2.6025,
                    via: 'direct',
                    requestedDate: '2026-10-07',
                    effectiveDate: '2026-10-07',
                    carriedOver: false,
                },
                {
                    amount: 100,
                    from: 'USD',
                    to: 'GEL',
                    date: '2026-13-01',
                    error: describeError({ kind: 'invalid_date', value: '2026-13-01', reason: 'not a real calendar date' }),
                },
                {
                    amount: 7,
                    from: 'dollar',
                    to: 'GEL',
                    date: '2026-10-07',
                    error: describeError({ kind: 'invalid_currency_code', value: 'dollar' }),
                },
                {
                    amount: 1,
                    from: 'XXX',
                    to: 'GEL',
                    date: '2026-10-07',
                    error: describeError({ kind: 'unknown_currency', code: 'XXX' }),
                },
                {
                    amount: 8,
                    from: 'Armenian dram',
                    to: 'GEL',
                    date: '10.09.2026',
                    error: describeError({ kind: 'invalid_date', value: '10.09.2026', reason: 'expected YYYY-MM-DD' }),
                },
                {
                    amount: 9,
                    from: '',
                    to: 'GEL',
                    date: '2026-10-07',
                    error: describeError({ kind: 'invalid_currency_code', value: '' }),
                },
            ],
            converted: 2,
            skipped: 5,
            total: { to: 'GEL', resultRounded: 29.93 },
        });
        // One service call for the one distinct date, although three items reached the rate lookup.
        expect(requests.map((request) => request.date)).toEqual(['2026-10-07']);
        expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
        await client.close();
    });

    it('asks the service once per distinct date and fails only the items of a date NBG has not published', async () => {
        const { service: table, requests } = tableService();
        const service: RatesService = {
            getSnapshot(args) {
                if (args.date === '2026-10-09') {
                    requests.push({ date: args.date, language: args.language, codes: args.codes });
                    return Promise.resolve(
                        err({
                            kind: 'rate_not_published',
                            date: args.date,
                            latestEffectiveDate: date('2026-10-08'),
                            today: date('2026-10-08'),
                        }),
                    );
                }
                return table.getSnapshot(args);
            },
            // An arrow, not the method itself: @typescript-eslint/unbound-method rejects the bare reference.
            getHistory: (args) => table.getHistory(args),
        };
        const client = await connectedClient({ service });

        const result = await client.callTool({
            name: 'nbg_convert_many',
            arguments: {
                items: [
                    { amount: 1, from: 'EUR', to: 'GEL', date: '2026-10-06' },
                    { amount: 2, from: 'EUR', to: 'GEL', date: '2026-10-07' },
                    { amount: 3, from: 'EUR', to: 'GEL', date: '2026-10-09' },
                    { amount: 4, from: 'EUR', to: 'GEL', date: '2026-10-06' },
                ],
            },
        });

        expect(requests.map((request) => request.date)).toEqual(['2026-10-06', '2026-10-07', '2026-10-09']);
        const output = convertManyOutput.parse(result.structuredContent);
        expect(output.items.map((item) => ('error' in item ? 'error' : item.resultRounded))).toEqual([
            2.93,
            5.85,
            'error',
            11.71,
        ]);
        expect(output.items[2]).toMatchObject({ amount: 3, date: '2026-10-09' });
        expect(JSON.stringify(output.items[2])).toContain('not published a rate for 2026-10-09');
        expect(output).toMatchObject({ converted: 3, skipped: 1, total: { to: 'GEL', resultRounded: 20.49 } });
        await client.close();
    });

    it('posts the total as a ledger does: the rounded lines summed, not the sum rounded', async () => {
        const { service } = tableService();
        const client = await connectedClient({ service });
        // Two lines of 26.025 each post as 26.03 + 26.03 = 52.06; rounding the summed 52.05 would give 52.05.
        const result = await client.callTool({
            name: 'nbg_convert_many',
            arguments: {
                items: [
                    { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-07' },
                    { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-07' },
                ],
            },
        });
        expect(result.structuredContent).toMatchObject({ total: { to: 'GEL', resultRounded: 52.06 } });
        await client.close();
    });

    it('stops asking NBG after one outage and fails the remaining dates with the same error', async () => {
        const { service: table, requests } = tableService();
        const outage: RatesError = { kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' };
        const service: RatesService = {
            getSnapshot(args) {
                if (args.date === '2026-10-07') {
                    requests.push({ date: args.date, language: args.language, codes: args.codes });
                    return Promise.resolve(err(outage));
                }
                return table.getSnapshot(args);
            },
            getHistory: (args) => table.getHistory(args),
        };
        const client = await connectedClient({ service });

        const result = await client.callTool({
            name: 'nbg_convert_many',
            arguments: {
                items: [
                    { amount: 1, from: 'USD', to: 'GEL', date: '2026-10-07' },
                    { amount: 2, from: 'USD', to: 'GEL', date: '2026-10-06' },
                    { amount: 3, from: 'USD', to: 'GEL', date: '2026-10-07' },
                ],
            },
        });

        // 2026-10-06 was never requested: after an outage every later date gets the same error without a wait.
        expect(requests.map((request) => request.date)).toEqual(['2026-10-07']);
        const output = convertManyOutput.parse(result.structuredContent);
        expect(output.items.map((item) => ('error' in item ? item.error : 'ok'))).toEqual([
            describeError(outage),
            describeError(outage),
            describeError(outage),
        ]);
        expect(output).toMatchObject({ converted: 0, skipped: 3 });
        expect(output).not.toHaveProperty('total');
        await client.close();
    });

    it('omits a total that is not a finite number', async () => {
        const client = await connectedClient();
        // Each identity item is finite; their exact sum, 2e308, is not representable as a JSON number.
        const result = await client.callTool({
            name: 'nbg_convert_many',
            arguments: {
                items: [
                    { amount: 1e308, from: 'GEL', to: 'GEL' },
                    { amount: 1e308, from: 'GEL', to: 'GEL' },
                ],
            },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ converted: 2, skipped: 0 });
        expect(result.structuredContent).not.toHaveProperty('total');
        await client.close();
    });

    it('omits the total when targets differ and needs no service call for GEL to GEL items', async () => {
        const { service, requests } = tableService();
        const client = await connectedClient({ service });

        const mixed = await client.callTool({
            name: 'nbg_convert_many',
            arguments: {
                items: [
                    { amount: 1, from: 'USD', to: 'GEL', date: '2026-10-07' },
                    { amount: 1, from: 'GEL', to: 'USD', date: '2026-10-07' },
                ],
            },
        });
        expect(mixed.structuredContent).toMatchObject({ converted: 2, skipped: 0 });
        expect(mixed.structuredContent).not.toHaveProperty('total');

        const identity = await client.callTool({
            name: 'nbg_convert_many',
            arguments: { items: [{ amount: 5.005, from: 'GEL', to: 'gel' }] },
        });
        expect(identity.structuredContent).toMatchObject({
            items: [{ result: 5.005, resultRounded: 5.01, rate: 1, via: 'direct' }],
            total: { to: 'GEL', resultRounded: 5.01 },
        });
        expect(requests.map((request) => request.date)).toEqual(['2026-10-07']);
        await client.close();
    });

    it('rejects an empty list and more than 100 items at the schema, and answers exactly 100', async () => {
        const { service, requests } = tableService();
        const client = await connectedClient({ service });
        const empty = await client.callTool({ name: 'nbg_convert_many', arguments: { items: [] } });
        expect(empty.isError).toBe(true);
        const item = { amount: 1, from: 'USD', to: 'GEL', date: '2026-10-07' };
        const tooMany = await client.callTool({
            name: 'nbg_convert_many',
            arguments: { items: Array.from({ length: 101 }, () => item) },
        });
        expect(tooMany.isError).toBe(true);
        expect(JSON.stringify(tooMany.content)).toMatch(/100/);
        const full = await client.callTool({
            name: 'nbg_convert_many',
            arguments: { items: Array.from({ length: 100 }, () => item) },
        });
        // Each line of 2.6025 posts as 2.60, so the ledger total is 260.00, not the 260.25 of the unrounded sum.
        expect(full.structuredContent).toMatchObject({ converted: 100, skipped: 0, total: { resultRounded: 260 } });
        expect(requests).toHaveLength(1);
        await client.close();
    });
});
```

Add `convertManyOutput` to the imports from `./tool-schemas.js` in that test file (`RatesError`, `RatesService`, `err` and `describeError` are already imported there).

In `test/e2e/stdio.test.ts`: in `lists the tools`, add `'nbg_convert_many'` to the sorted list; add a test:

```ts
    it('converts a batch, one CSV-free JSON request per distinct date', async () => {
        const before = server.requests.length;
        const result = await client.callTool({
            name: 'nbg_convert_many',
            arguments: {
                items: [
                    { amount: 100, from: 'USD', to: 'GEL', date: '2026-10-06' },
                    { amount: 200, from: 'EUR', to: 'GEL', date: '2026-10-06' },
                    { amount: 300, from: 'USD', to: 'GEL', date: '2026-10-04' },
                ],
            },
        });
        const output = convertManyOutput.parse(result.structuredContent);
        expect(output).toMatchObject({ converted: 3, skipped: 0, total: { to: 'GEL' } });
        expect(output.items.every((item) => !('error' in item))).toBe(true);
        // 2026-10-06 is cached by the earlier tests; 2026-10-04 too. At most one request per distinct date.
        expect(server.requests.length - before).toBeLessThanOrEqual(2);
    });
```

Add `convertManyOutput` to that file's imports from `../../src/shell/tool-schemas.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/shell/server.test.ts`
Expected: FAIL, `convertManyOutput` not exported and the tool unknown.

- [ ] **Step 3: Implement**

`src/shell/tool-schemas.ts`, after `convertInput`. The item schema is structural only: a date or code that `nbg_convert` would reject at its schema (a date not in `YYYY-MM-DD` shape, an empty code, a currency name) must reach `prepareConversion` so that it fails only its own item with the same text the single tool gives.

```ts
/** Loose on purpose: the shape only, so one malformed date or code costs its item and not the batch. */
const convertItemInput = z.object({
    amount: z.number().finite().describe('Amount in the "from" currency. May be negative.'),
    from: z.string().max(64).describe('ISO 4217 code, or GEL.'),
    to: z.string().max(64).describe('ISO 4217 code, or GEL.'),
    date: z
        .string()
        .max(64)
        .optional()
        .describe('Calendar date YYYY-MM-DD whose official rate to apply. Defaults to today in Tbilisi.'),
});

export const convertManyInput = z.object({
    items: z
        .array(convertItemInput)
        .min(1)
        .max(100)
        .describe('1 to 100 conversions, each with the fields of nbg_convert; items are answered independently.'),
});
```

and after `convertOutput`:

```ts
const convertItemFailure = z.object({
    amount: z.number(),
    from: z.string(),
    to: z.string(),
    date: z.string().optional(),
    error: z.string().describe('Why this item was not converted; the same text nbg_convert would return'),
});

export const convertManyOutput = z.object({
    items: z
        .array(z.union([convertOutput, convertItemFailure]))
        .describe('One entry per input item, in input order: a conversion, or the item with an error'),
    converted: z.number().int(),
    skipped: z.number().int(),
    total: z
        .object({
            to: z.string(),
            resultRounded: z
                .number()
                .describe('Exact sum of the resultRounded values of the converted items, as a ledger posts lines'),
        })
        .optional()
        .describe(
            'Present only when at least one item converted, every converted item has the same target currency, and ' +
                'the sum is a finite number. It covers the converted items only: when skipped is not 0, say the total ' +
                'is partial and list the skipped items.',
        ),
});
```

`src/shell/server.ts`:

Imports: add `convertManyInput, convertManyOutput` from `./tool-schemas.js`; `add, decimalToRational, fromInteger, roundHalfUp` from `'../core/decimal.js'`; `err` and `type Conversion` from `'../core/types.js'`.

Above `createServer`, add:

```ts
interface ConvertRequest {
    readonly amount: number;
    readonly from: string;
    readonly to: string;
    readonly date?: string | undefined;
}

interface PreparedConversion {
    readonly amount: number;
    readonly from: CurrencyCode;
    readonly to: CurrencyCode;
    readonly date: CalendarDate;
}

/** The checks that need no NBG data: the date, then each code; the first failure is the item's error. */
function prepareConversion(request: ConvertRequest, now: Date): Result<PreparedConversion, RatesError> {
    const resolved = resolveDate(request.date, now);
    if (!resolved.ok) {
        return resolved;
    }
    const from = parseCurrencyCode(request.from);
    if (!from.ok) {
        return from;
    }
    const to = parseCurrencyCode(request.to);
    if (!to.ok) {
        return to;
    }
    return ok({ amount: request.amount, from: from.value, to: to.value, date: resolved.value });
}

function isIdentity(prepared: PreparedConversion): boolean {
    return prepared.from === GEL && prepared.to === GEL;
}

/** GEL to GEL needs no NBG rate, so it answers for any valid date without a request. */
function identityConversion(prepared: PreparedConversion): Conversion {
    return {
        amount: prepared.amount,
        from: GEL,
        to: GEL,
        result: prepared.amount,
        resultRounded: roundedAmount(prepared.amount),
        rate: 1,
        via: 'direct',
        requestedDate: prepared.date,
        effectiveDate: prepared.date,
        carriedOver: false,
    };
}

function conversionOutput(conversion: Conversion) {
    return { ...conversion };
}

function failedItem(request: ConvertRequest, error: RatesError) {
    return {
        amount: request.amount,
        from: request.from,
        to: request.to,
        ...(request.date === undefined ? {} : { date: request.date }),
        error: describeError(error),
    };
}
```

Replace the `nbg_convert` handler body with:

```ts
        async (request) => {
            const prepared = prepareConversion(request, deps.now());
            if (!prepared.ok) {
                return failure(prepared.error);
            }
            if (isIdentity(prepared.value)) {
                return success(conversionOutput(identityConversion(prepared.value)));
            }
            const snapshot = await deps.service.getSnapshot({ date: prepared.value.date, language: 'en' });
            if (!snapshot.ok) {
                return failure(snapshot.error);
            }
            const { amount, from, to } = prepared.value;
            const conversion = convertAmount(snapshot.value, amount, from, to);
            return conversion.ok ? success(conversionOutput(conversion.value)) : failure(conversion.error);
        },
```

Register the new tool right after `nbg_convert`:

```ts
    server.registerTool(
        'nbg_convert_many',
        {
            title: 'Convert a list via NBG rates',
            description:
                'Converts a list of amounts, each at the official NBG rate in force on its own date: one call for a ' +
                'list of invoices. Items are answered independently; a bad date or code fails only its item, with the ' +
                'error text in that item. total is present when every converted item has the same target currency ' +
                'and covers the converted items only. Once NBG stops answering, the remaining dates fail with the ' +
                'same error without being asked. Show resultRounded as the amounts. ' +
                DATE_RULES,
            inputSchema: convertManyInput,
            outputSchema: convertManyOutput,
            annotations: READ_ONLY,
        },
        async ({ items }) => {
            const now = deps.now();
            const prepared = items.map((item) => prepareConversion(item, now));
            // One service call per distinct date, in first-seen order; GEL to GEL items need none.
            const snapshots = new Map<CalendarDate, Result<RatesSnapshot, RatesError>>();
            let outage: RatesError | undefined;
            for (const item of prepared) {
                if (!item.ok || isIdentity(item.value) || snapshots.has(item.value.date)) {
                    continue;
                }
                if (outage !== undefined) {
                    // NBG is not answering: the remaining dates get the same error instead of a 20-second wait each.
                    snapshots.set(item.value.date, err(outage));
                    continue;
                }
                const snapshot = await deps.service.getSnapshot({ date: item.value.date, language: 'en' });
                if (!snapshot.ok && snapshot.error.kind === 'upstream_unavailable') {
                    outage = snapshot.error;
                }
                snapshots.set(item.value.date, snapshot);
            }
            const outputs = prepared.map((item, index) => {
                const request = items[index];
                if (request === undefined) {
                    throw new Error('prepared and items differ in length');
                }
                if (!item.ok) {
                    return failedItem(request, item.error);
                }
                if (isIdentity(item.value)) {
                    return conversionOutput(identityConversion(item.value));
                }
                const snapshot = snapshots.get(item.value.date);
                if (snapshot === undefined) {
                    throw new Error(`no snapshot fetched for ${item.value.date}`);
                }
                if (!snapshot.ok) {
                    return failedItem(request, snapshot.error);
                }
                const { amount, from, to } = item.value;
                const conversion = convertAmount(snapshot.value, amount, from, to);
                return conversion.ok ? conversionOutput(conversion.value) : failedItem(request, conversion.error);
            });
            const conversions = outputs.filter((output): output is ReturnType<typeof conversionOutput> => !('error' in output));
            const targets = new Set(conversions.map((conversion) => conversion.to));
            const [target] = targets;
            // The rounded lines summed, as a ledger posts them; exact, then checked to fit a JSON number.
            const sum = roundHalfUp(
                conversions.reduce(
                    (running, conversion) => add(running, decimalToRational(conversion.resultRounded)),
                    fromInteger(0),
                ),
                2,
            );
            const total =
                target === undefined || targets.size !== 1 || !Number.isFinite(sum)
                    ? {}
                    : { total: { to: target, resultRounded: sum } };
            return success({
                items: outputs,
                converted: conversions.length,
                skipped: outputs.length - conversions.length,
                ...total,
            });
        },
    );
```

`manifest.json`, in `tools` after the `nbg_convert` entry:

```json
        {
            "name": "nbg_convert_many",
            "description": "Convert a list of amounts, each at the official NBG rate of its own date, with a total"
        },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/shell/server.test.ts`
Expected: PASS. If the SDK's output validator rejects a union item, check that a failed item has no `result` key and a converted item no `error` key; the union is ordered `convertOutput` first.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`

```bash
git add src/shell/tool-schemas.ts src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts manifest.json && git commit -m "Add nbg_convert_many: a list of conversions with per-item errors and a total" -- src/shell/tool-schemas.ts src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts manifest.json
```

---

### Task 6: Wording, prompts, README, changelog and the 0.4.0 version

**Files:**
- Modify: `src/shell/server.ts` (`DISPLAY_RULE`, `SERVER_INSTRUCTIONS`, descriptions)
- Modify: `src/shell/prompts.ts`, `manifest.json` (prompt texts and `nbg_rates_today` argument description)
- Modify: `src/shell/server.test.ts` (instructions test), `src/shell/prompts.test.ts` if it quotes a text
- Modify: `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, `manifest.json`, `server.json`

**Interfaces:**
- Consumes: Tasks 2 to 5 (the fields and tool the text describes).
- Produces: the release.

- [ ] **Step 1: Write the failing tests**

`src/shell/server.test.ts`, in `sends the instructions, short and leading with what the server is for`, keep the `const client = await connectedClient();` and `await client.close();` lines and replace only the two `expect` calls with:

```ts
        expect(instructions).toBe(
            'Official exchange rates of the Georgian lari (GEL) set by the National Bank of Georgia (NBG). ' +
                'Use these tools for any question about GEL rates, converting to or from GEL, or historical NBG rates ' +
                'on a date or over a range. Dates are Tbilisi calendar days; quote effectiveDate when carriedOver is true. ' +
                'Show resultRounded as the amount; result is the unrounded value for further calculation. ' +
                "When nbgQuantity is not 1, state NBG's quoted form first, nbgRate GEL per nbgQuantity units " +
                '(for example 1.6452 GEL per 100 JPY), and the per-unit rate beside it: that quoted form is what ' +
                'nbg.gov.ge and accounting software show.',
        );
        expect(instructions?.length).toBeLessThan(800);
```

Add a test in `describe('createServer', ...)`:

```ts
    it('tells the model to show the quoted form of a per-100 currency and the rounded amount', async () => {
        const client = await connectedClient();
        const { tools } = await client.listTools();
        const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));
        expect(byName.get('nbg_get_rates')).toContain('1.6452 GEL per 100 JPY');
        // The list carries no rates, so its rule points at nbg_get_rates instead of asking for a quoted form.
        expect(byName.get('nbg_list_currencies')).toContain('1.6452 GEL per 100 JPY');
        expect(byName.get('nbg_list_currencies')).toContain('nbg_get_rates');
        for (const name of ['nbg_convert', 'nbg_convert_many']) {
            expect(byName.get(name)).toContain('Show resultRounded as the amount');
        }
        await client.close();
    });
```

In `src/shell/prompts.test.ts`, if a test quotes a prompt text or the default currencies, update it to the new texts below; the manifest drift test needs no change (it compares to `PROMPTS`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/shell/server.test.ts src/shell/prompts.test.ts`
Expected: FAIL on the instructions string and the descriptions.

- [ ] **Step 3: Implement the wording**

`src/shell/server.ts`:

```ts
const DISPLAY_RULE =
    "When nbgQuantity is not 1, state NBG's quoted form first, nbgRate GEL per nbgQuantity units " +
    '(for example 1.6452 GEL per 100 JPY), and the per-unit rate beside it: that quoted form is what nbg.gov.ge ' +
    'and accounting software show.';

const AMOUNT_RULE = 'Show resultRounded as the amount; result is the unrounded value for further calculation.';

/** nbg_list_currencies carries quantities but no rates, so it cannot show the quoted form itself. */
const LIST_RULE =
    'nbgQuantity is the unit count NBG quotes the raw rate for (JPY is quoted as 1.6452 GEL per 100 JPY); ' +
    'for the rates themselves call nbg_get_rates.';
```

Append `' ' + DISPLAY_RULE` to the `nbg_get_rates` description (after `DATE_RULES`) and `' ' + LIST_RULE` to `nbg_list_currencies` (after its last sentence, which ends with a period and no space). Replace `'The result is unrounded: round it for display. '` in `nbg_convert` with `AMOUNT_RULE + ' '`, and in `nbg_convert_many` replace `'Show resultRounded as the amounts. '` with `AMOUNT_RULE + ' '`. The Task 5 tests do not quote that sentence, so they need no change.

`SERVER_INSTRUCTIONS` is composed, not retyped: the existing three sentences, then `' ' + AMOUNT_RULE + ' ' + DISPLAY_RULE`. Its text then equals the Step 1 expectation exactly.

`src/shell/prompts.ts`:

- `nbg_rates_today`: argument description `'Comma-separated ISO codes; USD, EUR, GBP and TRY when empty'`; text: replace `(USD, EUR and GBP when none are named)` with `(USD, EUR, GBP and TRY when none are named)`.
- `nbg_convert_amount` text: replace `'the date it took effect, whether it is carried over, and the result rounded to 2 decimal places.'` with `'the date it took effect, whether it is carried over, and the result as resultRounded with two decimals.'`.
- `nbg_monthly_rates` text, exactly:

```ts
        text:
            'Using nbg_rate_history from the first day of ${arguments.month} to its last day, or to today when the ' +
            'month is not over, give me a table of the official National Bank of Georgia rate of ' +
            '${arguments.currency} for every day, in GEL per one unit, marking the days whose rate is carried over ' +
            'from an earlier day. Below the table report the summary the tool returns: first, last, change, lowest ' +
            'and highest rate with their dates, and the average over the calendar days.',
```

`manifest.json`: the three `prompts[].text` values and nothing else change, each equal to the joined string above (run `npm test`; the drift test prints the diff).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: README and CHANGELOG**

`README.md`:

- After the "What you can ask" example list (line 12), add a paragraph: `Write the date with the month as a word, "10 September 2026": 10/09/2026 reads as two different dates.`
- `nbg_convert` output list: after the `result` line add `- \`resultRounded\`: \`result\` rounded half up to two decimals, computed exactly from NBG's published figures; the amount to show. JSON drops trailing zeros, so 3.90 arrives as \`3.9\`.` and change the `result` line to `the converted amount, unrounded, for further calculation.`
- New section after `nbg_convert`, `### \`nbg_convert_many\``: one paragraph (a list of conversions, each at the rate of its own date; one NBG request per distinct date), an inputs table with `items` (1 to 100 entries of `{ amount, from, to, date? }`, the rules of `nbg_convert`), an output list (`items` in input order, converted or `{ amount, from, to, date, error }`; `converted`, `skipped`; `total` present only when every converted item has the same target, the sum of their `resultRounded` values), and the spec's worked example JSON (10 USD, 1.5 USD, 100 USD on 2026-13-01).
- `nbg_rate_history` output list: add `- \`summary\`: \`first\`, \`last\`, \`change\` (last minus first), \`min\` and \`max\` with \`minDate\` and \`maxDate\` (first occurrence), and \`average\`, the arithmetic mean over every calendar day of the range, carried-over days included. \`change\` and \`average\` are exact, rounded half up to the decimals of the most precise rate in the series.` and extend the example JSON with `"summary": { "first": 2.6042, "last": 2.6032, "change": -0.001, "min": 2.6032, "minDate": "2026-10-06", "max": 2.6042, "maxDate": "2026-10-02", "average": 2.6038 }`.
- Errors list: split the currency line into `- the currency is not a three-letter code (the message names USD, EUR and GEL as examples), or NBG did not quote it on the requested date or range (\`nbg_get_rates\` lists such codes in \`unknownCodes\` instead); ...` and change the not-published line to `- NBG has not published a rate for the date yet; the message names today in Tbilisi, the latest date that can have a rate, and, when known, from which date the latest published rate is valid. A history range that reaches such a date fails as a whole: end it at today.`
- In "Which rate you get", after the first paragraph add: `Converted amounts come rounded half up to two decimals (\`resultRounded\`), the way a ledger posts them, computed exactly from NBG's published figures.`
- Tools intro: mention five tools if it counts them.

`CHANGELOG.md`, above `## 0.3.0`:

```markdown
## 0.4.0 - <today's date, YYYY-MM-DD>

Added: `nbg_convert_many`, a batch of conversions, each at the rate of its own date, with per-item errors and a total; `resultRounded` on every conversion, computed exactly and rounded half up to two decimals; a `summary` (first, last, change, lowest, highest, calendar-day average) on `nbg_rate_history`.

Changed: descriptions and prompts ask for NBG's quoted form (for example 1.6452 GEL per 100 JPY) beside the per-unit rate; a value that is not a currency code gets its own error text; the future-date error names the last date that can have a rate; the monthly prompt ends at today for the current month; the today's-rates prompt adds TRY.
```

Run `npx prettier --write README.md CHANGELOG.md`.

- [ ] **Step 6: Version 0.4.0**

```bash
npm version 0.4.0 --no-git-tag-version
```

Then set `"version": "0.4.0"` in `manifest.json` and both `version` fields in `server.json` (top level and `packages[0]`). Check:

```bash
npx tsx scripts/check-release.ts 0.4.0
```

Expected: no output, exit 0.

- [ ] **Step 7: Run the gates, the bundle build, and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e && bash scripts/build-bundle.sh`
Expected: all pass; `nbg-rates-mcp-0.4.0.mcpb` is built (it is gitignored).

```bash
git add src/shell/server.ts src/shell/server.test.ts src/shell/prompts.ts src/shell/prompts.test.ts manifest.json README.md CHANGELOG.md package.json package-lock.json server.json && git commit -m "Release 0.4.0" -- src/shell/server.ts src/shell/server.test.ts src/shell/prompts.ts src/shell/prompts.test.ts manifest.json README.md CHANGELOG.md package.json package-lock.json server.json
```

Then verify with `git show --stat HEAD` that only these files are in the commit. Do not push and do not tag; the maintainer tags `v0.4.0`.
