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
