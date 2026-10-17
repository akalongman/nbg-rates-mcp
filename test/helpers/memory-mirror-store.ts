import { EMPTY_MIRROR_STATE, parseMirrorState, type MirrorState } from '../../src/core/mirror.js';
import { parseStoredRows, type MirrorPublication } from '../../src/core/mirror-publication.js';
import type { NbgCsvRow } from '../../src/core/nbg-csv.js';
import { parseNbgResponse, type NbgDay } from '../../src/core/nbg-schema.js';
import { err, ok, type CalendarDate, type Language, type Result } from '../../src/core/types.js';
import type { MirrorStore, StoredRows, StoredTable, StoredTables, StoreError } from '../../src/shell/mirror-store.js';

export interface MemoryWrite {
    readonly operation: 'state' | 'commit' | 'remove' | 'fill' | 'archive' | 'replace';
    /**
     * `<pk>/<sk>` of the item the call addresses: `state/state`, `table#en/2024-03-16` for a fill, and the rows item's
     * key (`rows/2026-10-07`) for a commit, a removal, a replacement or an archive item.
     */
    readonly key: string;
}

export interface MemoryMirrorStore extends MirrorStore {
    /**
     * Successful writes, in order: one per write call, except writeArchiveRows, which adds one per rows item. A
     * superseded or present result, a change without a next state and a failed call write nothing and are not listed.
     */
    readonly writes: ReadonlyArray<MemoryWrite>;
    /**
     * The stored item as JSON would hold it, to check what a past table carries. The layout is the DynamoDB store's:
     * `{ pk: 'state', sk: 'state', revision, state }`, `{ pk: 'rows', sk, rows, observedAt }` and
     * `{ pk: 'table#en' | 'table#ka', sk, day, observedAt? }`, with `state`, `rows` and `day` as JSON strings.
     */
    rawItem(pk: string, sk: string): Readonly<Record<string, unknown>> | undefined;
    /**
     * Called before each operation; may await, to interleave a write between two reads or hang one. It receives a
     * write's MemoryWrite operation (`state` for updateState) or a read's method name (`readState`, `readTable`, ...).
     * An operation whose signal aborts while the hook is pending fails with store_failed at once.
     */
    before(hook: ((operation: string) => Promise<void> | void) | undefined): void;
    /** Every operation fails with this detail until cleared. */
    failWith(detail: string | undefined): void;
}

type StateItem = { readonly pk: 'state'; readonly sk: 'state'; readonly revision: number; readonly state: string };
type RowsItem = { readonly pk: 'rows'; readonly sk: CalendarDate; readonly rows: string; readonly observedAt: number };
type TableItem = {
    readonly pk: 'table#en' | 'table#ka';
    readonly sk: CalendarDate;
    readonly day: string;
    /** Absent on a past table. */
    readonly observedAt?: number;
};

const UPDATE_ATTEMPTS = 5;

function storeFailed(detail: string): { readonly ok: false; readonly error: StoreError } {
    return err({ kind: 'store_failed', detail });
}

function abortDetail(signal: AbortSignal): string {
    const reason: unknown = signal.reason;
    return reason instanceof Error ? `${reason.name}: ${reason.message}` : 'aborted';
}

/** Waits for `work`, or only until the signal aborts. */
async function untilAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
    let onAbort = (): void => undefined;
    const aborted = new Promise<void>((resolve) => {
        onAbort = () => resolve();
        if (signal.aborted) {
            resolve();
        } else {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
    try {
        await Promise.race([work, aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

function tablePk(language: Language): TableItem['pk'] {
    return language === 'en' ? 'table#en' : 'table#ka';
}

/** The commit's condition: attribute_not_exists(observedAt) OR observedAt < :observedAt. */
function replaceable(item: { readonly observedAt?: number } | undefined, observedAt: number): boolean {
    return item?.observedAt === undefined || item.observedAt < observedAt;
}

function ascending<T extends { readonly sk: CalendarDate }>(items: Iterable<T>): T[] {
    return [...items].sort((left, right) => (left.sk < right.sk ? -1 : left.sk > right.sk ? 1 : 0));
}

function parseDay(json: unknown): Result<NbgDay, string> {
    const parsed = parseNbgResponse([json]);
    if (!parsed.ok) {
        return err('detail' in parsed.error ? parsed.error.detail : parsed.error.kind);
    }
    const [day] = parsed.value;
    return day === undefined ? err('no table') : ok(day);
}

/** Reads a JSON attribute back through the parser the DynamoDB store uses for it. */
function decode<T>(
    item: { readonly pk: string; readonly sk: string },
    text: string,
    parse: (json: unknown) => Result<T, string>,
): Result<T, StoreError> {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (error: unknown) {
        return storeFailed(`${item.pk}/${item.sk} is not JSON: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    const parsed = parse(json);
    return parsed.ok ? parsed : storeFailed(`${item.pk}/${item.sk}: ${parsed.error}`);
}

function decodeRows(item: RowsItem): Result<StoredRows, StoreError> {
    const rows = decode(item, item.rows, parseStoredRows);
    return rows.ok ? ok({ validFrom: item.sk, rows: rows.value, observedAt: item.observedAt }) : rows;
}

function decodeTable(item: TableItem): Result<StoredTable, StoreError> {
    const day = decode(item, item.day, parseDay);
    if (!day.ok) {
        return day;
    }
    const table = { validFrom: item.sk, day: day.value };
    return ok(item.observedAt === undefined ? table : { ...table, observedAt: item.observedAt });
}

function rowsItem(validFrom: CalendarDate, rows: ReadonlyArray<NbgCsvRow>, observedAt: number): RowsItem {
    return { pk: 'rows', sk: validFrom, rows: JSON.stringify(rows), observedAt };
}

/**
 * A MirrorStore in memory, modelled on the DynamoDB store: the same items, the same write conditions, and every
 * payload held as a JSON string and read back through the same parsers. The serialization copies each value on the
 * way in and out, so a test cannot change stored data through a reference, and a value JSON cannot carry (NaN, an
 * explicit undefined) behaves as it will in DynamoDB.
 */
export function createMemoryMirrorStore(): MemoryMirrorStore {
    let stateItem: StateItem | undefined;
    const rowsItems = new Map<string, RowsItem>();
    const tableItems: Readonly<Record<Language, Map<string, TableItem>>> = { en: new Map(), ka: new Map() };
    const writes: MemoryWrite[] = [];
    let beforeHook: ((operation: string) => Promise<void> | void) | undefined;
    let failure: string | undefined;

    function refusal(signal: AbortSignal): StoreError | undefined {
        if (signal.aborted) {
            return { kind: 'store_failed', detail: abortDetail(signal) };
        }
        return failure === undefined ? undefined : { kind: 'store_failed', detail: failure };
    }

    async function begin(operation: string, signal: AbortSignal): Promise<StoreError | undefined> {
        const hook = beforeHook;
        if (hook !== undefined) {
            await untilAborted(Promise.resolve(hook(operation)), signal);
        }
        return refusal(signal);
    }

    function record(operation: MemoryWrite['operation'], key: string): void {
        writes.push({ operation, key });
    }

    function loadState(): Result<MirrorState, StoreError> {
        if (stateItem === undefined) {
            return ok(structuredClone(EMPTY_MIRROR_STATE));
        }
        return decode(stateItem, stateItem.state, parseMirrorState);
    }

    function publicationItems(validFrom: CalendarDate): ReadonlyArray<RowsItem | TableItem | undefined> {
        return [rowsItems.get(validFrom), tableItems.en.get(validFrom), tableItems.ka.get(validFrom)];
    }

    return {
        writes,

        rawItem(pk, sk) {
            const item =
                pk === 'state' && sk === 'state'
                    ? stateItem
                    : pk === 'rows'
                      ? rowsItems.get(sk)
                      : pk === 'table#en'
                        ? tableItems.en.get(sk)
                        : pk === 'table#ka'
                          ? tableItems.ka.get(sk)
                          : undefined;
            return item === undefined ? undefined : structuredClone(item);
        },

        before(hook) {
            beforeHook = hook;
        },

        failWith(detail) {
            failure = detail;
        },

        async readState(signal) {
            const refused = await begin('readState', signal);
            return refused === undefined ? loadState() : err(refused);
        },

        async readRowsInForce(date, signal) {
            const refused = await begin('readRowsInForce', signal);
            if (refused !== undefined) {
                return err(refused);
            }
            const inForce = ascending([...rowsItems.values()].filter((item) => item.sk <= date)).at(-1);
            return inForce === undefined ? ok(undefined) : decodeRows(inForce);
        },

        async readTable(validFrom, language, signal) {
            const refused = await begin('readTable', signal);
            if (refused !== undefined) {
                return err(refused);
            }
            const item = tableItems[language].get(validFrom);
            return item === undefined ? ok(undefined) : decodeTable(item);
        },

        async readRowsBetween(start, end, signal) {
            const refused = await begin('readRowsBetween', signal);
            if (refused !== undefined) {
                return err(refused);
            }
            const found: StoredRows[] = [];
            for (const item of ascending(rowsItems.values())) {
                if (item.sk < start || item.sk > end) {
                    continue;
                }
                const decoded = decodeRows(item);
                if (!decoded.ok) {
                    return decoded;
                }
                found.push(decoded.value);
            }
            return ok(found);
        },

        async readTablesBetween(start, end, signal) {
            const refused = await begin('readTablesBetween', signal);
            if (refused !== undefined) {
                return err(refused);
            }
            const found: StoredTables[] = [];
            for (const enItem of ascending(tableItems.en.values())) {
                const kaItem = tableItems.ka.get(enItem.sk);
                const { observedAt } = enItem;
                if (
                    enItem.sk < start ||
                    enItem.sk > end ||
                    observedAt === undefined ||
                    kaItem?.observedAt === undefined
                ) {
                    continue; // outside the range, or a past table
                }
                const en = decode(enItem, enItem.day, parseDay);
                const ka = decode(kaItem, kaItem.day, parseDay);
                if (!en.ok) {
                    return en;
                }
                if (!ka.ok) {
                    return ka;
                }
                found.push({ validFrom: enItem.sk, en: en.value, ka: ka.value, observedAt });
            }
            return ok(found);
        },

        async fillPastTable(validFrom, language, day, signal) {
            const refused = await begin('fill', signal);
            if (refused !== undefined) {
                return err(refused);
            }
            const tables = tableItems[language];
            if (tables.has(validFrom)) {
                return ok('present');
            }
            const pk = tablePk(language);
            tables.set(validFrom, { pk, sk: validFrom, day: JSON.stringify(day) });
            record('fill', `${pk}/${validFrom}`);
            return ok('written');
        },

        async updateState(change, signal) {
            const refused = await begin('state', signal);
            if (refused !== undefined) {
                return err(refused);
            }
            for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt += 1) {
                const expected = stateItem?.revision ?? 0;
                const current = loadState();
                if (!current.ok) {
                    return current;
                }
                const { next, outcome } = await change(current.value);
                if (next === undefined) {
                    return ok(outcome);
                }
                const refusedWrite = refusal(signal);
                if (refusedWrite !== undefined) {
                    return err(refusedWrite);
                }
                if ((stateItem?.revision ?? 0) !== expected) {
                    continue; // another writer moved the revision since this attempt's read
                }
                const revision = expected + 1;
                stateItem = { pk: 'state', sk: 'state', revision, state: JSON.stringify({ ...next, revision }) };
                record('state', 'state/state');
                return ok(outcome);
            }
            return storeFailed(`the state revision moved on each of ${UPDATE_ATTEMPTS} attempts`);
        },

        async commitPublication(publication, signal) {
            const refused = await begin('commit', signal);
            if (refused !== undefined) {
                return err(refused);
            }
            const { validFrom, observedAt } = publication;
            if (!publicationItems(validFrom).every((item) => replaceable(item, observedAt))) {
                return ok('superseded');
            }
            rowsItems.set(validFrom, rowsItem(validFrom, publication.rows, observedAt));
            for (const language of ['en', 'ka'] as const) {
                const day = JSON.stringify(publication[language]);
                tableItems[language].set(validFrom, { pk: tablePk(language), sk: validFrom, day, observedAt });
            }
            record('commit', `rows/${validFrom}`);
            return ok('committed');
        },

        async removePublication(validFrom, observedAt, signal) {
            const refused = await begin('remove', signal);
            if (refused !== undefined) {
                return err(refused);
            }
            if (!publicationItems(validFrom).every((item) => replaceable(item, observedAt))) {
                return ok('superseded');
            }
            rowsItems.delete(validFrom);
            tableItems.en.delete(validFrom);
            tableItems.ka.delete(validFrom);
            record('remove', `rows/${validFrom}`);
            return ok('removed');
        },

        async writeArchiveRows(items, signal) {
            const refused = await begin('archive', signal);
            if (refused !== undefined) {
                return err(refused);
            }
            for (const item of items) {
                rowsItems.set(item.validFrom, rowsItem(item.validFrom, item.rows, item.observedAt));
                record('archive', `rows/${item.validFrom}`);
            }
            return ok(undefined);
        },

        async replaceArchivePublication(validFrom, rows, observedAt, signal) {
            const refused = await begin('replace', signal);
            if (refused !== undefined) {
                return err(refused);
            }
            if (!replaceable(rowsItems.get(validFrom), observedAt)) {
                return ok('superseded');
            }
            if (rows === undefined) {
                rowsItems.delete(validFrom);
            } else {
                rowsItems.set(validFrom, rowsItem(validFrom, rows, observedAt));
            }
            tableItems.en.delete(validFrom);
            tableItems.ka.delete(validFrom);
            record('replace', `rows/${validFrom}`);
            return ok('replaced');
        },
    };
}

/**
 * Seeds a store through its own methods: the archive rows, then each publication's commit, then the state fields
 * merged over the stored state (the store sets the revision). A memory store's `writes` lists these writes too. Any
 * failure or superseded commit throws.
 */
export async function seedMirror(
    store: MirrorStore,
    content: {
        readonly publications?: ReadonlyArray<MirrorPublication>;
        readonly archiveRows?: ReadonlyArray<StoredRows>;
        readonly state?: Partial<Omit<MirrorState, 'revision'>>;
    },
): Promise<void> {
    const signal = new AbortController().signal;
    if (content.archiveRows !== undefined && content.archiveRows.length > 0) {
        const written = await store.writeArchiveRows(content.archiveRows, signal);
        if (!written.ok) {
            throw new Error(`seeding the archive rows failed: ${written.error.detail}`);
        }
    }
    for (const publication of content.publications ?? []) {
        const committed = await store.commitPublication(publication, signal);
        if (!committed.ok || committed.value !== 'committed') {
            const why = committed.ok ? committed.value : committed.error.detail;
            throw new Error(`seeding the ${publication.validFrom} publication failed: ${why}`);
        }
    }
    const fields = content.state;
    if (fields !== undefined) {
        const updated = await store.updateState(
            (state) => ({ next: { ...state, ...fields }, outcome: undefined }),
            signal,
        );
        if (!updated.ok) {
            throw new Error(`seeding the state failed: ${updated.error.detail}`);
        }
    }
}
