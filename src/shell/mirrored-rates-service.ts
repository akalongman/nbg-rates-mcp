import { TBILISI_TIME_ZONE, rejectBeyondTomorrow, todayIn } from '../core/dates.js';
import { assembleHistory, planHistory, type HistoryPlan } from '../core/history.js';
import { coversInterval, hasUnresolvedBetween, inSpan, isFresh, isPastDate } from '../core/mirror.js';
import { checkTableAgainstRows, exportRows } from '../core/mirror-publication.js';
import type { NbgDay } from '../core/nbg-schema.js';
import { selectCurrencies, snapshotFromDay } from '../core/normalize.js';
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
import type { LookupScopes } from './lookup-scope.js';
import type { MirrorRequestStore, StoredRows } from './mirror-store.js';
import { asNbgFailure, type NbgFailure } from './nbg-failure.js';
import type { RatesService } from './rates-service.js';

/** The bound on one call's mirror reads together; a slower store leaves the live path its full time. */
export const MIRROR_READ_TIMEOUT_MS = 2_000;
/** The bound on one past-table write (rule 7); the answer waits for the write at most this long. */
export const PAST_TABLE_WRITE_TIMEOUT_MS = 1_000;

export interface MirroredServiceDeps {
    readonly mirror: MirrorRequestStore;
    /** Today's service: the NBG client with its full timing and the instance's cache. */
    readonly live: RatesService;
    /** The same over a one-attempt client with a short timeout, sharing that cache. */
    readonly shortLive: RatesService;
    readonly scopes: LookupScopes;
    readonly now: () => Date;
    readonly readTimeoutMs?: number;
    readonly writeTimeoutMs?: number;
}

/** What one call's mirror reads found. */
type MirrorRead<T> =
    | {
          readonly kind: 'covered';
          readonly fresh: boolean;
          readonly answer: Result<T, RatesError>;
          /** The stored table's observation time, the cache bound for a live ask; a past table and a history have none. */
          readonly observedAt: Date | undefined;
      }
    /** Not covered, or the store failed or outlasted the read bound. */
    | { readonly kind: 'not_covered' };

const NOT_COVERED: MirrorRead<never> = { kind: 'not_covered' };

interface SnapshotRead {
    readonly read: MirrorRead<RatesSnapshot>;
    /** For a past date whose table is not stored in the language asked: the rows of the publication in force. */
    readonly pastRows: StoredRows | undefined;
    /**
     * For a date left uncovered by an unresolved date: the observation of the rows in force, the cache bound for the
     * live ask, so the instance never steps back to a value older than what the mirror holds for that publication.
     */
    readonly rowsObservedAt: Date | undefined;
}

/** A snapshot call's own arguments, as the mirror passes them on. */
interface SnapshotAsk {
    readonly date: CalendarDate;
    readonly language: Language;
    readonly codes?: ReadonlyArray<CurrencyCode>;
}

/** The live services' two ways to answer one call, each given the cache bound. */
interface LiveAsks<T> {
    /** One short attempt, made when the mirror holds a rate or a series to fall back on. */
    readonly short: (ignoreCachedBefore: Date | undefined) => Promise<Result<T, RatesError>>;
    /** Today's live path with its full timing. */
    readonly full: (ignoreCachedBefore: Date | undefined) => Promise<Result<T, RatesError>>;
}

function cacheBound(ignoreCachedBefore: Date | undefined): { readonly ignoreCachedBefore?: Date } {
    return ignoreCachedBefore === undefined ? {} : { ignoreCachedBefore };
}

/**
 * The hosted service when the mirror is configured: answers from the mirror where the spec's answering rules allow,
 * asks NBG through `live` or `shortLive` otherwise, and keeps NBG's table of a past publication on first ask (rule
 * 7). Per-request state lives on the lookup scope `http.ts` runs: an NBG failure the request has met (read before
 * each NBG ask, so the request asks NBG nothing more after one) and fillStopped (read before each past-table write).
 * A call outside a scope is its own request. The caller's ignoreCachedBefore and onFetched are not used: the mirror
 * sets both on the live calls it makes.
 */
export function createMirroredRatesService(deps: MirroredServiceDeps): RatesService {
    const readTimeoutMs = deps.readTimeoutMs ?? MIRROR_READ_TIMEOUT_MS;
    const writeTimeoutMs = deps.writeTimeoutMs ?? PAST_TABLE_WRITE_TIMEOUT_MS;

    function priorFailure(withoutNbg: NbgFailure | undefined): NbgFailure | undefined {
        return withoutNbg ?? deps.scopes.current()?.failure ?? undefined;
    }

    function recorded<T>(result: Result<T, RatesError>): Result<T, RatesError> {
        const failure = result.ok ? undefined : asNbgFailure(result.error);
        if (failure !== undefined) {
            deps.scopes.record(failure);
        }
        return result;
    }

    /** The answering table: the mirror's answer, the short attempt with the mirror's answer behind it, or live. */
    async function settle<T>(
        read: MirrorRead<T>,
        withoutNbg: NbgFailure | undefined,
        asks: LiveAsks<T>,
    ): Promise<Result<T, RatesError>> {
        if (read.kind === 'covered' && read.fresh) {
            return read.answer;
        }
        // Only a rate or a series stands in for NBG: a stale "not published", "no data" or "unknown currency" cannot
        // say what NBG would answer now.
        const fallback = read.kind === 'covered' && read.answer.ok ? read.answer : undefined;
        // Read here, after the mirror's reads, so a failure another lookup of this request met meanwhile counts.
        const prior = priorFailure(withoutNbg);
        if (prior !== undefined) {
            return fallback ?? err(prior);
        }
        const observedAt = read.kind === 'covered' ? read.observedAt : undefined;
        if (fallback === undefined) {
            return recorded(await asks.full(observedAt));
        }
        const attempt = await asks.short(observedAt);
        const failure = attempt.ok ? undefined : asNbgFailure(attempt.error);
        if (failure === undefined) {
            return attempt;
        }
        deps.scopes.record(failure);
        return fallback;
    }

    /**
     * State first, then the rows in force and the table, all under one bound (plan decision 3). A date in `unresolved`
     * from the rows' publication to the date asked leaves the date uncovered before the table read, with no rows to
     * keep a past table against: the sources disagree there, so the mirror may not hold what NBG answers now. The
     * rows' observation still bounds the live ask's cache.
     */
    async function readSnapshot(
        date: CalendarDate,
        language: Language,
        codes: ReadonlyArray<CurrencyCode> | undefined,
        today: CalendarDate,
        now: Date,
    ): Promise<SnapshotRead> {
        const nothing: SnapshotRead = { read: NOT_COVERED, pastRows: undefined, rowsObservedAt: undefined };
        const signal = AbortSignal.timeout(readTimeoutMs);
        const state = await deps.mirror.readState(signal);
        if (!state.ok) {
            return nothing;
        }
        const past = isPastDate(state.value, date);
        if (!past && !inSpan(state.value, date)) {
            return nothing;
        }
        const rows = await deps.mirror.readRowsInForce(date, signal);
        if (!rows.ok || rows.value === undefined) {
            return nothing;
        }
        if (hasUnresolvedBetween(state.value, rows.value.validFrom, date)) {
            return { ...nothing, rowsObservedAt: new Date(rows.value.observedAt) };
        }
        const table = await deps.mirror.readTable(rows.value.validFrom, language, signal);
        if (!table.ok) {
            return nothing;
        }
        if (table.value === undefined) {
            return { ...nothing, pastRows: past ? rows.value : undefined };
        }
        const snapshot = snapshotFromDay(table.value.day, date, today);
        const { observedAt } = table.value;
        return {
            read: {
                kind: 'covered',
                fresh: isFresh(state.value, now),
                answer: snapshot.ok && codes !== undefined ? ok(selectCurrencies(snapshot.value, codes)) : snapshot,
                observedAt: observedAt === undefined ? undefined : new Date(observedAt),
            },
            pastRows: undefined,
            rowsObservedAt: undefined,
        };
    }

    /** The state, then the rows NBG's export would return for the plan's interval, under one bound. */
    async function readHistory(plan: HistoryPlan, today: CalendarDate, now: Date): Promise<MirrorRead<HistorySeries>> {
        const signal = AbortSignal.timeout(readTimeoutMs);
        const state = await deps.mirror.readState(signal);
        if (!state.ok || !coversInterval(state.value, plan.start, plan.end)) {
            return NOT_COVERED;
        }
        const stored = await deps.mirror.readRowsBetween(plan.start, plan.end, signal);
        if (!stored.ok) {
            return NOT_COVERED;
        }
        const rows = exportRows(stored.value, plan.currencies, plan.start, plan.end);
        return {
            kind: 'covered',
            fresh: isFresh(state.value, now),
            answer: assembleHistory(plan.currency, plan.days, rows, today),
            observedAt: undefined,
        };
    }

    /**
     * Rule 7: adds NBG's table for a past date when it is the publication the rows say is in force (Review Focus 2:
     * checkTableAgainstRows refuses a table valid from another day first) and agrees with those rows. A failed or
     * timed-out write stops the request's writes; the answer does not depend on it.
     */
    async function keepPastTable(rows: StoredRows, language: Language, day: NbgDay): Promise<void> {
        if (!checkTableAgainstRows(rows.validFrom, day, rows.rows).ok) {
            return;
        }
        const scope = deps.scopes.current();
        if (scope?.fillStopped === true) {
            return;
        }
        const written = await deps.mirror.fillPastTable(
            rows.validFrom,
            language,
            day,
            AbortSignal.timeout(writeTimeoutMs),
        );
        if (!written.ok && scope !== undefined) {
            scope.fillStopped = true;
        }
    }

    /** Today's live path for a past date without its table, then rule 7 with the table this call fetched. */
    async function liveKeepingPastTable(
        asked: SnapshotAsk,
        rows: StoredRows,
    ): Promise<Result<RatesSnapshot, RatesError>> {
        // onFetched runs only when this call fetched from NBG and the answer is ok; it must not throw.
        const fetched: { day: NbgDay | undefined } = { day: undefined };
        const answer = await deps.live.getSnapshot({
            ...asked,
            onFetched: (day) => {
                fetched.day = day;
            },
        });
        if (answer.ok && fetched.day !== undefined) {
            await keepPastTable(rows, asked.language, fetched.day);
        }
        return answer;
    }

    return {
        async getSnapshot({ date, language, codes, withoutNbg }) {
            const now = deps.now();
            const today = todayIn(TBILISI_TIME_ZONE, now);
            // With a prior failure the check is skipped, so a date the mirror cannot answer gets that failure.
            if (priorFailure(withoutNbg) === undefined) {
                const reachable = rejectBeyondTomorrow(date, today);
                if (!reachable.ok) {
                    return reachable;
                }
            }
            const { read, pastRows, rowsObservedAt } = await readSnapshot(date, language, codes, today, now);
            const asked: SnapshotAsk = { date, language, ...(codes === undefined ? {} : { codes }) };
            /** settle passes a covered read's observation; an uncovered read leaves the rows' observation, if any. */
            function bounded(
                ignoreCachedBefore: Date | undefined,
            ): SnapshotAsk & { readonly ignoreCachedBefore?: Date } {
                return { ...asked, ...cacheBound(ignoreCachedBefore ?? rowsObservedAt) };
            }
            return settle(read, withoutNbg, {
                short: (ignoreCachedBefore) => deps.shortLive.getSnapshot(bounded(ignoreCachedBefore)),
                full:
                    pastRows === undefined
                        ? (ignoreCachedBefore) => deps.live.getSnapshot(bounded(ignoreCachedBefore))
                        : () => liveKeepingPastTable(asked, pastRows),
            });
        },

        async getHistory({ currency, from, to }) {
            const now = deps.now();
            const today = todayIn(TBILISI_TIME_ZONE, now);
            // Run whether or not the request met a failure: the plan's interval is what the mirror reads.
            const plan = planHistory(currency, from, to, today);
            if (!plan.ok) {
                return plan;
            }
            const read = await readHistory(plan.value, today, now);
            return settle(read, undefined, {
                short: () => deps.shortLive.getHistory({ currency, from, to }),
                full: () => deps.live.getHistory({ currency, from, to }),
            });
        },
    };
}
