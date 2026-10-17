import { TBILISI_TIME_ZONE, todayIn } from '../core/dates.js';
import { markResolved, markUnresolved, type MirrorState } from '../core/mirror.js';
import {
    checkAgreement,
    csvRequestCodes,
    sameRows,
    sameTable,
    tableCodes,
    tableValidFrom,
    type MirrorPublication,
} from '../core/mirror-publication.js';
import type { NbgCsvRow } from '../core/nbg-csv.js';
import type { NbgDay } from '../core/nbg-schema.js';
import {
    err,
    ok,
    type CalendarDate,
    type CurrencyCode,
    type Language,
    type RatesError,
    type Result,
} from '../core/types.js';
import {
    STORE_OPERATION_TIMEOUT_MS,
    type MirrorStore,
    type StoreError,
    type StoredRows,
    type StoredTables,
} from './mirror-store.js';
import type { NbgClient } from './nbg-client.js';
import { asNbgFailure, type NbgFailure } from './nbg-failure.js';

export const SYNC_REQUEST_TIMEOUT_MS = 5_000;
export const SYNC_REQUEST_WORST_MS = 10_500; // two tries and the retry delay
export const SYNC_REQUEST_SPACING_MS = 500;
export const COMMIT_RESERVE_MS = 4_500;
export const LOG_RESERVE_MS = 500;

export type SyncFetch<T> =
    | { readonly kind: 'ok'; readonly value: T }
    | { readonly kind: 'nbg_error'; readonly error: RatesError }
    | { readonly kind: 'deadline' };

export interface SyncContext {
    readonly store: MirrorStore;
    readonly scheduledAt: Date;
    readonly today: CalendarDate;
    readonly now: () => Date;
    /** Spaced, counted, and not sent when the deadline does not allow its worst case plus a commit. */
    fetchDay(date: CalendarDate, language: Language): Promise<SyncFetch<NbgDay>>;
    fetchRange(
        codes: ReadonlyArray<CurrencyCode>,
        start: CalendarDate,
        end: CalendarDate,
    ): Promise<SyncFetch<ReadonlyArray<NbgCsvRow>>>;
    /** True while the remaining time minus LOG_RESERVE_MS covers `ms`. */
    allows(ms: number): boolean;
    signal(): AbortSignal; // AbortSignal.timeout(STORE_OPERATION_TIMEOUT_MS)
    readonly counts: { nbgRequests: number; committed: number };
}

export type ResolveOutcome = 'committed' | 'unchanged' | 'removed' | 'unresolved' | 'deadline';
export type SyncFailure = NbgFailure | StoreError | { readonly kind: 'empty_export' };

export interface SyncContextOptions {
    readonly store: MirrorStore;
    readonly client: NbgClient;
    readonly now: () => Date;
    readonly sleep: (ms: number) => Promise<void>;
    /** A valid date: the caller rejects an invalid one before building a context. */
    readonly scheduledAt: Date;
    readonly remainingMs: () => number;
}

/**
 * One run's context. Each NBG request after the first waits SYNC_REQUEST_SPACING_MS first, and a request is sent only
 * while the time left covers that wait, the request's worst case and a commit, so whatever it fetched can be
 * committed. Today is the Tbilisi date of the scheduled time.
 */
export function createSyncContext(options: SyncContextOptions): SyncContext {
    const counts = { nbgRequests: 0, committed: 0 };

    function allows(ms: number): boolean {
        return options.remainingMs() - LOG_RESERVE_MS >= ms;
    }

    async function request<T>(send: () => Promise<Result<T, RatesError>>): Promise<SyncFetch<T>> {
        const spacing = counts.nbgRequests > 0 ? SYNC_REQUEST_SPACING_MS : 0;
        if (!allows(spacing + SYNC_REQUEST_WORST_MS + COMMIT_RESERVE_MS)) {
            return { kind: 'deadline' };
        }
        if (spacing > 0) {
            await options.sleep(spacing);
        }
        counts.nbgRequests += 1;
        const answer = await send();
        return answer.ok ? { kind: 'ok', value: answer.value } : { kind: 'nbg_error', error: answer.error };
    }

    return {
        store: options.store,
        scheduledAt: options.scheduledAt,
        today: todayIn(TBILISI_TIME_ZONE, options.scheduledAt),
        now: options.now,
        fetchDay: (date, language) => request(() => options.client.fetchDay(date, language)),
        fetchRange: (codes, start, end) => request(() => options.client.fetchRange(codes, start, end)),
        allows,
        signal: () => AbortSignal.timeout(STORE_OPERATION_TIMEOUT_MS),
        counts,
    };
}

/**
 * The failure a sync request met. The client answers no_data_for_date only when NBG's JSON holds no table at all, which
 * the sync cannot use: it counts as a shape NBG should not answer with. Every other error the client returns is
 * already an NBG failure.
 */
export function syncNbgFailure(error: RatesError): NbgFailure {
    return asNbgFailure(error) ?? { kind: 'upstream_shape_changed', detail: `NBG answered ${error.kind}` };
}

/** A fetch that ended the work: the deadline, or a failure. */
export function stoppedBy(
    fetched: Exclude<SyncFetch<unknown>, { readonly kind: 'ok' }>,
): Result<'deadline', SyncFailure> {
    return fetched.kind === 'deadline' ? ok('deadline') : err(syncNbgFailure(fetched.error));
}

export type StateWrite = { readonly kind: 'applied'; readonly state: MirrorState } | { readonly kind: 'deadline' };

/**
 * Applies a forward-only transition of core/mirror.ts through updateState, writing only when it moved something, and
 * only while the deadline leaves room for a store operation. Answers the state the transition produced.
 */
export async function applyToState(
    context: SyncContext,
    transition: (state: MirrorState) => MirrorState,
): Promise<Result<StateWrite, StoreError>> {
    if (!context.allows(STORE_OPERATION_TIMEOUT_MS)) {
        return ok({ kind: 'deadline' });
    }
    const updated = await context.store.updateState((state) => {
        const next = transition(state);
        return { next: next === state ? undefined : next, outcome: next };
    }, context.signal());
    return updated.ok ? ok({ kind: 'applied', state: updated.value }) : updated;
}

/** NBG's table valid from `validFrom`, or undefined when NBG has none: its JSON then answers an earlier table. */
function tableValidOn(day: NbgDay | undefined, validFrom: CalendarDate): NbgDay | undefined {
    return day !== undefined && tableValidFrom(day) === validFrom ? day : undefined;
}

/** The table NBG's JSON answers for the date (valid from it or earlier), or undefined when it has none before it. */
async function fetchInForce(
    context: SyncContext,
    validFrom: CalendarDate,
    language: Language,
): Promise<SyncFetch<NbgDay | undefined>> {
    const fetched = await context.fetchDay(validFrom, language);
    if (fetched.kind === 'nbg_error' && fetched.error.kind === 'no_data_for_date') {
        return { kind: 'ok', value: undefined }; // nothing on or before the date
    }
    return fetched;
}

/** The export for the date alone. One naming no currency can list nothing, so it is empty without a request. */
async function exportForDate(
    context: SyncContext,
    validFrom: CalendarDate,
    codes: ReadonlyArray<CurrencyCode>,
): Promise<Result<ReadonlyArray<NbgCsvRow> | 'deadline', SyncFailure>> {
    if (codes.length === 0) {
        return err({ kind: 'empty_export' });
    }
    const exported = await context.fetchRange(codes, validFrom, validFrom);
    if (exported.kind !== 'ok') {
        return stoppedBy(exported);
    }
    if (exported.value.length === 0) {
        return err({ kind: 'empty_export' });
    }
    return ok(exported.value);
}

interface StoredPublication {
    readonly tables: StoredTables | undefined;
    readonly rows: StoredRows | undefined;
}

async function readStored(
    context: SyncContext,
    validFrom: CalendarDate,
): Promise<Result<StoredPublication, StoreError>> {
    const tables = await context.store.readTablesBetween(validFrom, validFrom, context.signal());
    if (!tables.ok) {
        return tables;
    }
    const rows = await context.store.readRowsBetween(validFrom, validFrom, context.signal());
    if (!rows.ok) {
        return rows;
    }
    return ok({ tables: tables.value[0], rows: rows.value[0] });
}

async function settle(
    context: SyncContext,
    validFrom: CalendarDate,
    outcome: 'committed' | 'unchanged' | 'removed' | 'unresolved',
): Promise<Result<ResolveOutcome, SyncFailure>> {
    const transition =
        outcome === 'unresolved'
            ? (state: MirrorState) => markUnresolved(state, [validFrom])
            : (state: MirrorState) => markResolved(state, [validFrom]);
    const written = await applyToState(context, transition);
    if (!written.ok) {
        return written;
    }
    return ok(written.value.kind === 'deadline' ? 'deadline' : outcome);
}

/** Nothing for the date at NBG: removes what the mirror holds for it, if anything. */
async function removeIfStored(
    context: SyncContext,
    validFrom: CalendarDate,
    observedAt: number,
): Promise<Result<ResolveOutcome, SyncFailure>> {
    const stored = await readStored(context, validFrom);
    if (!stored.ok) {
        return stored;
    }
    if (stored.value.tables === undefined && stored.value.rows === undefined) {
        return settle(context, validFrom, 'unchanged');
    }
    if (!context.allows(COMMIT_RESERVE_MS)) {
        return ok('deadline');
    }
    const removed = await context.store.removePublication(validFrom, observedAt, context.signal());
    if (!removed.ok) {
        return removed;
    }
    if (removed.value === 'superseded') {
        return ok('unchanged'); // a newer observation holds the date; the run that made it settles the state
    }
    context.counts.committed += 1;
    return settle(context, validFrom, 'removed');
}

/** The three sources agree: commits the publication unless the mirror already holds the same tables and rows. */
async function commitIfChanged(
    context: SyncContext,
    publication: MirrorPublication,
): Promise<Result<ResolveOutcome, SyncFailure>> {
    const { validFrom } = publication;
    const stored = await readStored(context, validFrom);
    if (!stored.ok) {
        return stored;
    }
    const { tables, rows } = stored.value;
    const same =
        tables !== undefined &&
        rows !== undefined &&
        sameTable(tables.en, publication.en) &&
        sameTable(tables.ka, publication.ka) &&
        sameRows(rows.rows, publication.rows);
    if (same) {
        return settle(context, validFrom, 'unchanged');
    }
    if (!context.allows(COMMIT_RESERVE_MS)) {
        return ok('deadline');
    }
    const committed = await context.store.commitPublication(publication, context.signal());
    if (!committed.ok) {
        return committed;
    }
    if (committed.value === 'superseded') {
        return ok('unchanged'); // a newer observation holds the date; the run that made it settles the state
    }
    context.counts.committed += 1;
    return settle(context, validFrom, 'committed');
}

/**
 * Fetches what the three sources say about one span publication and commits, removes or marks it unresolved.
 *
 * `csvRows` are the export's rows for `validFrom` from a request naming `requestedCodes`: an empty list means that
 * export listed none for the date, undefined that no export covering the date was asked. The observation is the time
 * before the first fetch here, or `prefetched.observedAt`; a table `prefetched` carries is not fetched again.
 *
 * One table valid from the date and not the other is unresolved, with no CSV request. Otherwise the CSV is fetched
 * for the date alone when no rows were given, and also when both tables are there and quote a code the request did
 * not name; the codes are those of the English table NBG answered for the date (valid from it or earlier), and an
 * empty export fails the run. Neither table valid from the date means "not there": with rows for it the date is
 * unresolved, and only rows given from an export that covers the date and lists none for it remove what the mirror
 * holds (NBG's JSON alone never decides a removal). With both there, the tables and rows must agree to be committed; a
 * superseded write is `unchanged`. The date is marked resolved or unresolved after, and `deadline` means the run's
 * time ran out on the way, possibly after a commit.
 */
export async function resolvePublication(
    context: SyncContext,
    validFrom: CalendarDate,
    csvRows: ReadonlyArray<NbgCsvRow> | undefined,
    requestedCodes: ReadonlyArray<CurrencyCode>,
    prefetched?: { readonly observedAt: number; readonly en: NbgDay; readonly ka?: NbgDay },
): Promise<Result<ResolveOutcome, SyncFailure>> {
    const observedAt = prefetched?.observedAt ?? context.now().getTime();
    const enInForce: SyncFetch<NbgDay | undefined> =
        prefetched === undefined ? await fetchInForce(context, validFrom, 'en') : { kind: 'ok', value: prefetched.en };
    if (enInForce.kind !== 'ok') {
        return stoppedBy(enInForce);
    }
    const kaInForce: SyncFetch<NbgDay | undefined> =
        prefetched?.ka === undefined
            ? await fetchInForce(context, validFrom, 'ka')
            : { kind: 'ok', value: prefetched.ka };
    if (kaInForce.kind !== 'ok') {
        return stoppedBy(kaInForce);
    }
    const en = tableValidOn(enInForce.value, validFrom);
    const ka = tableValidOn(kaInForce.value, validFrom);
    if ((en === undefined) !== (ka === undefined)) {
        return settle(context, validFrom, 'unresolved');
    }
    const wanted = csvRequestCodes(
        enInForce.value === undefined ? requestedCodes : tableCodes(enInForce.value),
        validFrom,
        validFrom,
    );
    let rows = csvRows;
    if (rows === undefined || (en !== undefined && wanted.some((code) => !requestedCodes.includes(code)))) {
        const exported = await exportForDate(context, validFrom, wanted);
        if (!exported.ok) {
            return exported;
        }
        if (exported.value === 'deadline') {
            return ok('deadline');
        }
        rows = exported.value;
    }
    if (en === undefined || ka === undefined) {
        return rows.length > 0
            ? settle(context, validFrom, 'unresolved')
            : removeIfStored(context, validFrom, observedAt);
    }
    if (!checkAgreement(validFrom, en, ka, rows).ok) {
        return settle(context, validFrom, 'unresolved');
    }
    return commitIfChanged(context, { validFrom, en, ka, rows, observedAt });
}
