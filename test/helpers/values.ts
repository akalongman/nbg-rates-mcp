import { parseCurrencyCode } from '../../src/core/currency-code.js';
import { parseCalendarDate } from '../../src/core/dates.js';
import type { CalendarDate, CurrencyCode } from '../../src/core/types.js';

/** Unwraps a fixture date that must be valid; a typo in a test throws here. */
export function date(text: string): CalendarDate {
    const parsed = parseCalendarDate(text);
    if (!parsed.ok) {
        throw new Error(`test fixture date is invalid: ${text}`);
    }
    return parsed.value;
}

/** Unwraps a fixture currency code that must be valid; a typo in a test throws here. */
export function code(text: string): CurrencyCode {
    const parsed = parseCurrencyCode(text);
    if (!parsed.ok) {
        throw new Error(`test fixture currency code is invalid: ${text}`);
    }
    return parsed.value;
}
