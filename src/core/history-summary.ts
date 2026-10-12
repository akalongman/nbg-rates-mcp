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
