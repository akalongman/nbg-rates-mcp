import { describe, expect, it } from 'vitest';
import { GEL, parseCurrencyCode } from './currency-code.js';

describe('parseCurrencyCode', () => {
    it('accepts an upper-case ISO code', () => {
        const result = parseCurrencyCode('USD');
        expect(result).toEqual({ ok: true, value: 'USD' });
    });

    it('normalises case and surrounding whitespace', () => {
        expect(parseCurrencyCode(' usd ')).toEqual({ ok: true, value: 'USD' });
    });

    it('rejects anything that is not three letters', () => {
        for (const input of ['US', 'USDD', 'U$D', '', '123']) {
            const result = parseCurrencyCode(input);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toEqual({ kind: 'unknown_currency', code: input });
            }
        }
    });

    it('exports GEL as a branded code', () => {
        expect(GEL).toBe('GEL');
    });
});
