import {
    NBG_ARCHIVE_START,
    TBILISI_TIME_ZONE,
    addDays,
    enumerateDays,
    rejectBeyondTomorrow,
    todayIn,
} from '../core/dates.js';
import { CALENDAR_CURRENCY, HISTORY_LOOKBACK_DAYS, assembleHistory } from '../core/history.js';
import { normalizeSnapshot, requirePublished, selectCurrencies } from '../core/normalize.js';
import {
    err,
    ok,
    type CalendarDate,
    type CurrencyCode,
    type HistorySeries,
    type Language,
    type RatesError,
    type RatesSnapshot,
    type Result,
} from '../core/types.js';
import type { SnapshotCache } from './cache.js';
import type { NbgClient } from './nbg-client.js';

export interface RatesService {
    getSnapshot(args: {
        date: CalendarDate;
        language: Language;
        codes?: ReadonlyArray<CurrencyCode>;
    }): Promise<Result<RatesSnapshot, RatesError>>;
    getHistory(args: {
        currency: CurrencyCode;
        from: CalendarDate;
        to: CalendarDate;
    }): Promise<Result<HistorySeries, RatesError>>;
}

export function createRatesService(deps: { client: NbgClient; cache: SnapshotCache; now: () => Date }): RatesService {
    /** Only an answer that passed requirePublished is cached, so a cached entry never needs re-checking. */
    async function settledSnapshot(
        date: CalendarDate,
        language: Language,
        today: CalendarDate,
    ): Promise<Result<RatesSnapshot, RatesError>> {
        const cached = deps.cache.get(language, date, deps.now());
        if (cached !== undefined) {
            return ok(cached);
        }
        const day = await deps.client.fetchDay(date, language);
        if (!day.ok) {
            return day;
        }
        const snapshot = requirePublished(normalizeSnapshot(day.value, date), today);
        if (snapshot.ok) {
            deps.cache.set(language, date, snapshot.value, deps.now());
        }
        return snapshot;
    }

    return {
        async getSnapshot({ date, language, codes }) {
            const today = todayIn(TBILISI_TIME_ZONE, deps.now());
            const reachable = rejectBeyondTomorrow(date, today);
            if (!reachable.ok) {
                return reachable;
            }
            const snapshot = await settledSnapshot(date, language, today);
            if (!snapshot.ok) {
                return snapshot;
            }
            return ok(codes === undefined ? snapshot.value : selectCurrencies(snapshot.value, codes));
        },

        async getHistory({ currency, from, to }) {
            const days = enumerateDays(from, to);
            if (!days.ok) {
                return days;
            }
            const today = todayIn(TBILISI_TIME_ZONE, deps.now());
            const reachable = rejectBeyondTomorrow(to, today);
            if (!reachable.ok) {
                return reachable;
            }
            if (to < NBG_ARCHIVE_START) {
                // NBG has no rate before its archive start: answer as assembleHistory does for an empty export,
                // without the request. The lookback start of such a range can also fall before the year 0000,
                // where addDays throws.
                return err({ kind: 'no_data_for_date', date: from, currency });
            }
            const currencies = currency === CALENDAR_CURRENCY ? [currency] : [currency, CALENDAR_CURRENCY];
            const rows = await deps.client.fetchRange(currencies, addDays(from, -HISTORY_LOOKBACK_DAYS), to);
            if (!rows.ok) {
                return rows;
            }
            return assembleHistory(currency, days.value, rows.value, today);
        },
    };
}
