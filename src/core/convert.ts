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
