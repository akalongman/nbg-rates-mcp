import * as z from 'zod';
import { parseCalendarDate } from './dates.js';
import { err, ok, type RatesError, type Result } from './types.js';

export function isPowerOfTen(value: number): boolean {
    return Number.isInteger(value) && /^10*$/.test(String(value));
}

/** Every NBG rate and diff since 1995 has at most four decimals; per-unit rounding relies on it. */
export function hasAtMostFourDecimals(value: number): boolean {
    return Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6;
}

/** An NBG timestamp starts with a real calendar date and "T"; its time part is Tbilisi wall clock and never read. */
function isNbgTimestamp(value: string): boolean {
    return value[10] === 'T' && parseCalendarDate(value.slice(0, 10)).ok;
}

const timestamp = z.string().refine(isNbgTimestamp, 'not a timestamp with a real calendar date');
const fourDecimals = 'more than four decimals';

const nbgCurrencyRowSchema = z.looseObject({
    code: z.string().regex(/^[A-Z]{3}$/),
    quantity: z.number().refine(isPowerOfTen, 'quantity is not a power of ten'),
    rate: z.number().positive().refine(hasAtMostFourDecimals, fourDecimals),
    diff: z.number().refine(hasAtMostFourDecimals, fourDecimals),
    name: z.string(),
    date: timestamp,
    validFromDate: timestamp,
});

const nbgDaySchema = z
    .looseObject({
        date: timestamp,
        currencies: z.array(nbgCurrencyRowSchema).min(1),
    })
    .refine((day) => new Set(day.currencies.map((row) => row.validFromDate.slice(0, 10))).size === 1, {
        message: 'rows disagree on validFromDate',
        path: ['currencies'],
    });

const nbgResponseSchema = z.array(nbgDaySchema);

export type NbgCurrencyRow = z.infer<typeof nbgCurrencyRowSchema>;
export type NbgDay = z.infer<typeof nbgDaySchema>;

export function parseNbgResponse(json: unknown): Result<ReadonlyArray<NbgDay>, RatesError> {
    const parsed = nbgResponseSchema.safeParse(json);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
        return err({ kind: 'upstream_shape_changed', detail });
    }
    return ok(parsed.data);
}
