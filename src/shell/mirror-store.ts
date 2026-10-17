import type { MirrorState } from '../core/mirror.js';
import type { MirrorPublication } from '../core/mirror-publication.js';
import type { NbgCsvRow } from '../core/nbg-csv.js';
import type { NbgDay } from '../core/nbg-schema.js';
import type { CalendarDate, Language, Result } from '../core/types.js';

export const STORE_OPERATION_TIMEOUT_MS = 2_000;
/** updateState's attempts in all: its first and the re-reads after a revision conflict. */
export const UPDATE_ATTEMPTS = 5;

export interface StoreError {
    readonly kind: 'store_failed';
    readonly detail: string;
}

export interface StoredRows {
    readonly validFrom: CalendarDate;
    readonly rows: ReadonlyArray<NbgCsvRow>;
    readonly observedAt: number;
}

/** observedAt is absent on a past table. */
export interface StoredTable {
    readonly validFrom: CalendarDate;
    readonly day: NbgDay;
    readonly observedAt?: number;
}

export interface StoredTables {
    readonly validFrom: CalendarDate;
    readonly en: NbgDay;
    readonly ka: NbgDay;
    readonly observedAt: number;
}

/** What an updateState change gives back: the state to write (undefined writes nothing) and the caller's result. */
export interface StateChange<T> {
    readonly next: MirrorState | undefined;
    readonly outcome: T;
}

export interface MirrorReader {
    readState(signal: AbortSignal): Promise<Result<MirrorState, StoreError>>;
    /** The rows item with the latest validFrom on or before `date`. */
    readRowsInForce(date: CalendarDate, signal: AbortSignal): Promise<Result<StoredRows | undefined, StoreError>>;
    readTable(
        validFrom: CalendarDate,
        language: Language,
        signal: AbortSignal,
    ): Promise<Result<StoredTable | undefined, StoreError>>;
    /** Rows items with validFrom in [start, end], ascending, every page read. */
    readRowsBetween(
        start: CalendarDate,
        end: CalendarDate,
        signal: AbortSignal,
    ): Promise<Result<ReadonlyArray<StoredRows>, StoreError>>;
}

/** All a user request may do: read, and add a past table. */
export interface MirrorRequestStore extends MirrorReader {
    /** Adds the item if absent, never replaces one; the item holds the table alone. */
    fillPastTable(
        validFrom: CalendarDate,
        language: Language,
        day: NbgDay,
        signal: AbortSignal,
    ): Promise<Result<'written' | 'present', StoreError>>;
}

export interface MirrorStore extends MirrorRequestStore {
    /**
     * Publications' table pairs (both items carry observedAt) with validFrom in [start, end], ascending, every page
     * read; past tables are left out.
     */
    readTablesBetween(
        start: CalendarDate,
        end: CalendarDate,
        signal: AbortSignal,
    ): Promise<Result<ReadonlyArray<StoredTables>, StoreError>>;
    /**
     * Compare-and-set on revision, re-read and re-applied on a conflict, at most UPDATE_ATTEMPTS (5) attempts in all;
     * `next` undefined writes nothing. The store sets the written state's revision. `change` may return a promise,
     * which the store awaits between its read and its compare-and-set; production callers pass the synchronous
     * transitions of core/mirror.ts.
     */
    updateState<T>(
        change: (state: MirrorState) => StateChange<T> | Promise<StateChange<T>>,
        signal: AbortSignal,
    ): Promise<Result<T, StoreError>>;
    /** The rows item and both table items, or none; only over an older observation or a past table. */
    commitPublication(
        publication: MirrorPublication,
        signal: AbortSignal,
    ): Promise<Result<'committed' | 'superseded', StoreError>>;
    /** Deletes the rows item and both table items, or none; only where each is absent or holds an older observation. */
    removePublication(
        validFrom: CalendarDate,
        observedAt: number,
        signal: AbortSignal,
    ): Promise<Result<'removed' | 'superseded', StoreError>>;
    /** Archive rows items, each written whole and unconditionally; the caller moves rowsStart afterwards. */
    writeArchiveRows(items: ReadonlyArray<StoredRows>, signal: AbortSignal): Promise<Result<void, StoreError>>;
    /**
     * Rewrites (or with undefined removes) an archive publication's rows and deletes both its past tables, in one
     * transaction; superseded when the stored rows item holds an equal or newer observation.
     */
    replaceArchivePublication(
        validFrom: CalendarDate,
        rows: ReadonlyArray<NbgCsvRow> | undefined,
        observedAt: number,
        signal: AbortSignal,
    ): Promise<Result<'replaced' | 'superseded', StoreError>>;
}
