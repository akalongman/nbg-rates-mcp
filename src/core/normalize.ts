import { calendarDateFromTimestamp, isSettled } from './dates.js';
import type { NbgDay } from './nbg-schema.js';
import {
    err,
    ok,
    type CalendarDate,
    type CurrencyCode,
    type RateEntry,
    type RatesError,
    type RatesSnapshot,
    type Result,
} from './types.js';

export function perUnit(value: number, quantity: number): number {
    const decimals = 4 + Math.round(Math.log10(quantity));
    return Number((value / quantity).toFixed(decimals));
}

export function normalizeSnapshot(day: NbgDay, requestedDate: CalendarDate): RatesSnapshot {
    // The schema guarantees at least one row and a validFromDate shared by all rows.
    const effectiveDate = calendarDateFromTimestamp(day.currencies[0]?.validFromDate ?? day.date);
    const rates: RateEntry[] = day.currencies.map((row) => ({
        code: row.code as CurrencyCode, // the schema has already matched the code against /^[A-Z]{3}$/
        name: row.name,
        rate: perUnit(row.rate, row.quantity),
        diff: perUnit(row.diff, row.quantity),
        nbgQuantity: row.quantity,
        nbgRate: row.rate,
    }));
    return {
        requestedDate,
        effectiveDate,
        carriedOver: effectiveDate < requestedDate,
        rates,
        unknownCodes: [],
    };
}

/**
 * Accepts only an answer that is the rate in force on the requested date: a table valid from a later day means NBG
 * ignored the date (a shape change), and an answer for a date NBG has not published yet becomes an error instead of
 * a stale rate.
 */
export function requirePublished(snapshot: RatesSnapshot, today: CalendarDate): Result<RatesSnapshot, RatesError> {
    if (snapshot.effectiveDate > snapshot.requestedDate) {
        return err({
            kind: 'upstream_shape_changed',
            detail: `NBG answered ${snapshot.requestedDate} with a table valid from ${snapshot.effectiveDate}`,
        });
    }
    if (isSettled(snapshot.requestedDate, snapshot.effectiveDate, today)) {
        return ok(snapshot);
    }
    return err({
        kind: 'rate_not_published',
        date: snapshot.requestedDate,
        latestEffectiveDate: snapshot.effectiveDate,
    });
}

export function selectCurrencies(snapshot: RatesSnapshot, codes: ReadonlyArray<CurrencyCode>): RatesSnapshot {
    const byCode = new Map(snapshot.rates.map((entry) => [entry.code, entry]));
    const rates: RateEntry[] = [];
    const unknownCodes: string[] = [];
    for (const requested of new Set(codes)) {
        const entry = byCode.get(requested);
        if (entry === undefined) {
            unknownCodes.push(requested);
        } else {
            rates.push(entry);
        }
    }
    return { ...snapshot, rates, unknownCodes };
}
