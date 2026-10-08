import { GEL } from './currency-code.js';
import {
    err,
    ok,
    type Conversion,
    type CurrencyCode,
    type RatesError,
    type RatesSnapshot,
    type Result,
} from './types.js';

function rateInGel(snapshot: RatesSnapshot, code: CurrencyCode): Result<number, RatesError> {
    if (code === GEL) {
        return ok(1);
    }
    const entry = snapshot.rates.find((candidate) => candidate.code === code);
    if (entry === undefined) {
        return err({ kind: 'unknown_currency', code });
    }
    return ok(entry.rate);
}

export function convertAmount(
    snapshot: RatesSnapshot,
    amount: number,
    from: CurrencyCode,
    to: CurrencyCode,
): Result<Conversion, RatesError> {
    const fromRate = rateInGel(snapshot, from);
    if (!fromRate.ok) {
        return fromRate;
    }
    const toRate = rateInGel(snapshot, to);
    if (!toRate.ok) {
        return toRate;
    }
    const identical = from === to;
    const rate = identical ? 1 : fromRate.value / toRate.value;
    const via: Conversion['via'] = identical || from === GEL || to === GEL ? 'direct' : 'GEL';
    return ok({
        amount,
        from,
        to,
        result: identical ? amount : amount * rate,
        rate,
        via,
        requestedDate: snapshot.requestedDate,
        effectiveDate: snapshot.effectiveDate,
        carriedOver: snapshot.carriedOver,
    });
}
