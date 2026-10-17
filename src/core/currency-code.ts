import { err, ok, type CurrencyCode, type RatesError, type Result } from './types.js';

const CODE_PATTERN = /^[A-Z]{3}$/;

export const GEL = 'GEL' as CurrencyCode;

export function parseCurrencyCode(input: string): Result<CurrencyCode, RatesError> {
    const normalised = input.trim().toUpperCase();
    if (!CODE_PATTERN.test(normalised)) {
        return err({ kind: 'invalid_currency_code', value: input });
    }
    return ok(normalised as CurrencyCode);
}

/** An uppercase three-letter code as parseCurrencyCode accepts it, unchanged by its normalisation. */
export function isExactCurrencyCode(value: string): value is CurrencyCode {
    const parsed = parseCurrencyCode(value);
    return parsed.ok && parsed.value === value;
}
