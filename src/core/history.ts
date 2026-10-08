import { isSettled } from './dates.js';
import type { NbgCsvRow } from './nbg-csv.js';
import { perUnit } from './normalize.js';
import {
    err,
    ok,
    type CalendarDate,
    type CurrencyCode,
    type HistoryPoint,
    type HistorySeries,
    type RatesError,
    type Result,
} from './types.js';

/**
 * Days requested before `from`, so the rate in force on `from` is in the export even after a long holiday.
 * The longest gap between publications observed is five days, over New Year.
 */
export const HISTORY_LOOKBACK_DAYS = 31;

/**
 * Requested alongside every other currency as the publication calendar: USD is in every NBG table since the
 * archive starts, so its rows show which publications exist even when the requested currency is missing from some.
 */
export const CALENDAR_CURRENCY = 'USD' as CurrencyCode; // satisfies the CurrencyCode brand: three uppercase letters

function compareDates(left: CalendarDate, right: CalendarDate): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Builds one point per calendar day from CSV export rows of the requested currency and the calendar currency.
 * The rate in force on a day comes from the latest publication valid on or before it, and that publication must
 * quote the currency: NBG dropped BGN after 2025-12-31, and its currency filter misses AZN in 2006 and 2007, so a
 * currency row older than the latest publication is a gap, never a rate to repeat.
 */
export function assembleHistory(
    currency: CurrencyCode,
    days: ReadonlyArray<CalendarDate>,
    rows: ReadonlyArray<NbgCsvRow>,
    today: CalendarDate,
): Result<HistorySeries, RatesError> {
    const first = days[0];
    const last = days[days.length - 1];
    if (first === undefined || last === undefined) {
        throw new Error('assembleHistory needs at least one day');
    }
    const publications = [...new Set(rows.map((row) => row.validFrom))].sort(compareDates);
    const latestPublication = publications[publications.length - 1];
    if (latestPublication === undefined) {
        return err({ kind: 'no_data_for_date', date: first, currency });
    }
    // Oldest first; on equal validFrom the later publication wins because it is applied last.
    const ordered = rows
        .filter((row) => row.code === currency)
        .sort(
            (left, right) =>
                compareDates(left.validFrom, right.validFrom) || compareDates(left.publishedOn, right.publishedOn),
        );
    if (ordered.length === 0) {
        return err({ kind: 'unknown_currency', code: currency });
    }
    const points: HistoryPoint[] = [];
    let inForce: NbgCsvRow | undefined;
    let nextRow = 0;
    let publication: CalendarDate | undefined;
    let nextPublication = 0;
    for (const day of days) {
        let candidate = ordered[nextRow];
        while (candidate !== undefined && candidate.validFrom <= day) {
            inForce = candidate;
            nextRow += 1;
            candidate = ordered[nextRow];
        }
        let upcoming = publications[nextPublication];
        while (upcoming !== undefined && upcoming <= day) {
            publication = upcoming;
            nextPublication += 1;
            upcoming = publications[nextPublication];
        }
        if (publication === undefined || inForce === undefined || inForce.validFrom !== publication) {
            return err({ kind: 'no_data_for_date', date: day, currency });
        }
        if (!isSettled(day, publication, today)) {
            return err({ kind: 'rate_not_published', date: day, latestEffectiveDate: latestPublication });
        }
        points.push({
            date: day,
            effectiveDate: publication,
            rate: perUnit(inForce.rate, inForce.quantity),
            carriedOver: publication < day,
        });
    }
    return ok({ currency, from: first, to: last, days: points });
}
