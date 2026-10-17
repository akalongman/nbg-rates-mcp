import { TBILISI_TIME_ZONE, rejectBeyondTomorrow, todayIn } from '../core/dates.js';
import { assembleHistory, planHistory } from '../core/history.js';
import { selectCurrencies, snapshotFromDay } from '../core/normalize.js';
import {
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
        const snapshot = snapshotFromDay(day.value, date, today);
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
            const today = todayIn(TBILISI_TIME_ZONE, deps.now());
            const plan = planHistory(currency, from, to, today);
            if (!plan.ok) {
                return plan;
            }
            const rows = await deps.client.fetchRange(plan.value.currencies, plan.value.start, plan.value.end);
            if (!rows.ok) {
                return rows;
            }
            return assembleHistory(currency, plan.value.days, rows.value, today);
        },
    };
}
