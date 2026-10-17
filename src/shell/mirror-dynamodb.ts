import {
    BatchWriteItemCommand,
    ConditionalCheckFailedException,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
    TransactionCanceledException,
    TransactWriteItemsCommand,
    type AttributeValue,
    type TransactWriteItem,
    type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { parseCalendarDate } from '../core/dates.js';
import { EMPTY_MIRROR_STATE, parseMirrorState, type MirrorState } from '../core/mirror.js';
import { parseStoredRows } from '../core/mirror-publication.js';
import type { NbgCsvRow } from '../core/nbg-csv.js';
import { parseNbgResponse, type NbgDay } from '../core/nbg-schema.js';
import { err, ok, type CalendarDate, type Language, type Result } from '../core/types.js';
import type { MirrorStore, StoredRows, StoredTable, StoredTables, StoreError } from './mirror-store.js';

type Item = Record<string, AttributeValue>;

const UPDATE_ATTEMPTS = 5;
/** BatchWriteItem's limit of requests per call. */
const BATCH_SIZE = 25;
/** A commit's condition on each item: absent, a past table, or an older observation. */
const OLDER_OR_ABSENT = 'attribute_not_exists(observedAt) OR observedAt < :observedAt';

function storeFailed(detail: string): { readonly ok: false; readonly error: StoreError } {
    return err({ kind: 'store_failed', detail });
}

function describeError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** A transaction cancelled only by failed conditions: every reason is None or ConditionalCheckFailed. */
function cancelledByCondition(error: unknown): boolean {
    if (!(error instanceof TransactionCanceledException)) {
        return false;
    }
    const codes = (error.CancellationReasons ?? []).map((reason) => reason.Code);
    return (
        codes.includes('ConditionalCheckFailed') &&
        codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')
    );
}

/** One SDK call's output, or its error as store_failed. */
async function call<T>(work: () => Promise<T>): Promise<Result<T, StoreError>> {
    try {
        return ok(await work());
    } catch (error: unknown) {
        return storeFailed(describeError(error));
    }
}

/** A conditional write: 'written', 'conflict' when its condition failed, or store_failed for any other error. */
async function conditionalWrite(work: () => Promise<unknown>): Promise<Result<'written' | 'conflict', StoreError>> {
    try {
        await work();
        return ok('written');
    } catch (error: unknown) {
        if (error instanceof ConditionalCheckFailedException || cancelledByCondition(error)) {
            return ok('conflict');
        }
        return storeFailed(describeError(error));
    }
}

function key(pk: string, sk: string): Item {
    return { pk: { S: pk }, sk: { S: sk } };
}

function tablePk(language: Language): string {
    return language === 'en' ? 'table#en' : 'table#ka';
}

function rowsItem(validFrom: CalendarDate, rows: ReadonlyArray<NbgCsvRow>, observedAt: number): Item {
    return { ...key('rows', validFrom), rows: { S: JSON.stringify(rows) }, observedAt: { N: String(observedAt) } };
}

function olderOrAbsent(observedAt: number): {
    readonly ConditionExpression: string;
    readonly ExpressionAttributeValues: Item;
} {
    return {
        ConditionExpression: OLDER_OR_ABSENT,
        ExpressionAttributeValues: { ':observedAt': { N: String(observedAt) } },
    };
}

/** `<pk>/<sk>`, to name an item in an error's detail. */
function itemName(item: Item): string {
    return `${item.pk?.S ?? '?'}/${item.sk?.S ?? '?'}`;
}

function decodeValidFrom(item: Item): Result<CalendarDate, StoreError> {
    const parsed = parseCalendarDate(item.sk?.S ?? '');
    return parsed.ok ? parsed : storeFailed(`${itemName(item)}: sk is not a calendar date`);
}

/** A non-negative integer attribute, or undefined when the item has none. */
function decodeCount(item: Item, name: string): Result<number | undefined, StoreError> {
    const attribute = item[name];
    if (attribute === undefined) {
        return ok(undefined);
    }
    const value = attribute.N === undefined ? Number.NaN : Number(attribute.N);
    return Number.isSafeInteger(value) && value >= 0
        ? ok(value)
        : storeFailed(`${itemName(item)}: ${name} is not a non-negative integer`);
}

/** A JSON attribute read back through its parser. */
function decodeJson<T>(item: Item, name: string, parse: (json: unknown) => Result<T, string>): Result<T, StoreError> {
    const text = item[name]?.S;
    if (text === undefined) {
        return storeFailed(`${itemName(item)}: ${name} is missing`);
    }
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (error: unknown) {
        return storeFailed(`${itemName(item)}: ${name} is not JSON: ${describeError(error)}`);
    }
    const parsed = parse(json);
    return parsed.ok ? parsed : storeFailed(`${itemName(item)}: ${parsed.error}`);
}

function parseDay(json: unknown): Result<NbgDay, string> {
    const parsed = parseNbgResponse([json]);
    if (!parsed.ok) {
        return err('detail' in parsed.error ? parsed.error.detail : parsed.error.kind);
    }
    const [day] = parsed.value;
    return day === undefined ? err('no table') : ok(day);
}

function decodeRows(item: Item): Result<StoredRows, StoreError> {
    const validFrom = decodeValidFrom(item);
    if (!validFrom.ok) {
        return validFrom;
    }
    const rows = decodeJson(item, 'rows', parseStoredRows);
    if (!rows.ok) {
        return rows;
    }
    const observedAt = decodeCount(item, 'observedAt');
    if (!observedAt.ok) {
        return observedAt;
    }
    if (observedAt.value === undefined) {
        return storeFailed(`${itemName(item)}: observedAt is missing`);
    }
    return ok({ validFrom: validFrom.value, rows: rows.value, observedAt: observedAt.value });
}

function decodeTable(item: Item): Result<StoredTable, StoreError> {
    const validFrom = decodeValidFrom(item);
    if (!validFrom.ok) {
        return validFrom;
    }
    const day = decodeJson(item, 'day', parseDay);
    if (!day.ok) {
        return day;
    }
    const observedAt = decodeCount(item, 'observedAt');
    if (!observedAt.ok) {
        return observedAt;
    }
    const table = { validFrom: validFrom.value, day: day.value };
    return ok(observedAt.value === undefined ? table : { ...table, observedAt: observedAt.value });
}

/** The stored state and its item's revision; an absent item is the empty state at revision 0. */
function decodeState(
    item: Item | undefined,
): Result<{ readonly revision: number; readonly state: MirrorState }, StoreError> {
    if (item === undefined) {
        return ok({ revision: 0, state: EMPTY_MIRROR_STATE });
    }
    const revision = decodeCount(item, 'revision');
    if (!revision.ok) {
        return revision;
    }
    if (revision.value === undefined) {
        return storeFailed(`${itemName(item)}: revision is missing`);
    }
    const state = decodeJson(item, 'state', parseMirrorState);
    return state.ok ? ok({ revision: revision.value, state: state.value }) : state;
}

function decodeAll<T>(
    items: ReadonlyArray<Item>,
    decode: (item: Item) => Result<T, StoreError>,
): Result<T[], StoreError> {
    const decoded: T[] = [];
    for (const item of items) {
        const result = decode(item);
        if (!result.ok) {
            return result;
        }
        decoded.push(result.value);
    }
    return ok(decoded);
}

/**
 * The MirrorStore in one DynamoDB table keyed by the strings `pk` and `sk`:
 * - state: `{ pk: 'state', sk: 'state', revision: N, state: S }`
 * - rows: `{ pk: 'rows', sk: <valid-from date>, rows: S, observedAt: N }`
 * - tables: `{ pk: 'table#en' | 'table#ka', sk: <valid-from date>, day: S, observedAt?: N }`, with no observedAt on
 *   a past table
 *
 * Each S payload is JSON, validated by its parser when read back. Reads are strongly consistent, every call passes
 * the operation's signal, and a publication's items change together in one transaction.
 */
export function createDynamoMirrorStore(options: {
    readonly tableName: string;
    readonly client?: DynamoDBClient;
}): MirrorStore {
    const { tableName } = options;
    const client = options.client ?? new DynamoDBClient({ maxAttempts: 2 });

    async function getItem(itemKey: Item, signal: AbortSignal): Promise<Result<Item | undefined, StoreError>> {
        const response = await call(() =>
            client.send(new GetItemCommand({ TableName: tableName, Key: itemKey, ConsistentRead: true }), {
                abortSignal: signal,
            }),
        );
        return response.ok ? ok(response.value.Item) : response;
    }

    /** Every item of `pk` with sk in [start, end], ascending, page after page; optionally only those with a filter. */
    async function queryBetween(
        pk: string,
        start: CalendarDate,
        end: CalendarDate,
        filter: string | undefined,
        signal: AbortSignal,
    ): Promise<Result<ReadonlyArray<Item>, StoreError>> {
        if (start > end) {
            return ok([]); // an empty range; DynamoDB refuses BETWEEN with a lower bound above the upper one
        }
        const items: Item[] = [];
        let startKey: Item | undefined;
        do {
            const exclusiveStartKey = startKey;
            const page = await call(() =>
                client.send(
                    new QueryCommand({
                        TableName: tableName,
                        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :start AND :end',
                        FilterExpression: filter,
                        ExpressionAttributeValues: { ':pk': { S: pk }, ':start': { S: start }, ':end': { S: end } },
                        ConsistentRead: true,
                        ExclusiveStartKey: exclusiveStartKey,
                    }),
                    { abortSignal: signal },
                ),
            );
            if (!page.ok) {
                return page;
            }
            items.push(...(page.value.Items ?? []));
            startKey = page.value.LastEvaluatedKey;
        } while (startKey !== undefined);
        return ok(items);
    }

    async function transact(
        items: ReadonlyArray<TransactWriteItem>,
        signal: AbortSignal,
    ): Promise<Result<'written' | 'conflict', StoreError>> {
        return conditionalWrite(() =>
            client.send(new TransactWriteItemsCommand({ TransactItems: [...items] }), { abortSignal: signal }),
        );
    }

    async function loadState(
        signal: AbortSignal,
    ): Promise<Result<{ readonly revision: number; readonly state: MirrorState }, StoreError>> {
        const item = await getItem(key('state', 'state'), signal);
        return item.ok ? decodeState(item.value) : item;
    }

    return {
        async readState(signal) {
            const stored = await loadState(signal);
            return stored.ok ? ok(stored.value.state) : stored;
        },

        async readRowsInForce(date, signal) {
            const response = await call(() =>
                client.send(
                    new QueryCommand({
                        TableName: tableName,
                        KeyConditionExpression: 'pk = :pk AND sk <= :date',
                        ExpressionAttributeValues: { ':pk': { S: 'rows' }, ':date': { S: date } },
                        ScanIndexForward: false,
                        Limit: 1,
                        ConsistentRead: true,
                    }),
                    { abortSignal: signal },
                ),
            );
            if (!response.ok) {
                return response;
            }
            const [item] = response.value.Items ?? [];
            return item === undefined ? ok(undefined) : decodeRows(item);
        },

        async readTable(validFrom, language, signal) {
            const item = await getItem(key(tablePk(language), validFrom), signal);
            if (!item.ok) {
                return item;
            }
            return item.value === undefined ? ok(undefined) : decodeTable(item.value);
        },

        async readRowsBetween(start, end, signal) {
            const items = await queryBetween('rows', start, end, undefined, signal);
            return items.ok ? decodeAll(items.value, decodeRows) : items;
        },

        async readTablesBetween(start, end, signal) {
            // A past table carries no observedAt and is not a publication's table.
            const published = 'attribute_exists(observedAt)';
            const [enItems, kaItems] = await Promise.all([
                queryBetween('table#en', start, end, published, signal),
                queryBetween('table#ka', start, end, published, signal),
            ]);
            if (!enItems.ok) {
                return enItems;
            }
            if (!kaItems.ok) {
                return kaItems;
            }
            const en = decodeAll(enItems.value, decodeTable);
            if (!en.ok) {
                return en;
            }
            const ka = decodeAll(kaItems.value, decodeTable);
            if (!ka.ok) {
                return ka;
            }
            const kaByDate = new Map(ka.value.map((table) => [table.validFrom, table]));
            const found: StoredTables[] = [];
            for (const enTable of en.value) {
                const kaTable = kaByDate.get(enTable.validFrom);
                const { observedAt } = enTable;
                if (observedAt === undefined || kaTable?.observedAt === undefined) {
                    continue;
                }
                found.push({ validFrom: enTable.validFrom, en: enTable.day, ka: kaTable.day, observedAt });
            }
            return ok(found);
        },

        async fillPastTable(validFrom, language, day, signal) {
            // The item holds the table alone: no time, client, currency or request detail.
            const written = await conditionalWrite(() =>
                client.send(
                    new PutItemCommand({
                        TableName: tableName,
                        Item: { ...key(tablePk(language), validFrom), day: { S: JSON.stringify(day) } },
                        ConditionExpression: 'attribute_not_exists(pk)',
                    }),
                    { abortSignal: signal },
                ),
            );
            if (!written.ok) {
                return written;
            }
            return ok(written.value === 'written' ? 'written' : 'present');
        },

        async updateState(change, signal) {
            for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt += 1) {
                const stored = await loadState(signal);
                if (!stored.ok) {
                    return stored;
                }
                const expected = stored.value.revision;
                const { next, outcome } = await change(stored.value.state);
                if (next === undefined) {
                    return ok(outcome);
                }
                const revision = expected + 1;
                const written = await conditionalWrite(() =>
                    client.send(
                        new PutItemCommand({
                            TableName: tableName,
                            Item: {
                                ...key('state', 'state'),
                                revision: { N: String(revision) },
                                state: { S: JSON.stringify({ ...next, revision }) },
                            },
                            ...(expected === 0
                                ? { ConditionExpression: 'attribute_not_exists(pk)' }
                                : {
                                      ConditionExpression: 'revision = :expected',
                                      ExpressionAttributeValues: { ':expected': { N: String(expected) } },
                                  }),
                        }),
                        { abortSignal: signal },
                    ),
                );
                if (!written.ok) {
                    return written;
                }
                if (written.value === 'written') {
                    return ok(outcome);
                }
                // Another writer moved the revision since this attempt's read.
            }
            return storeFailed(`the state revision moved on each of ${UPDATE_ATTEMPTS} attempts`);
        },

        async commitPublication(publication, signal) {
            const { validFrom, observedAt } = publication;
            const condition = olderOrAbsent(observedAt);
            const tableItem = (language: Language): Item => ({
                ...key(tablePk(language), validFrom),
                day: { S: JSON.stringify(publication[language]) },
                observedAt: { N: String(observedAt) },
            });
            const written = await transact(
                [
                    {
                        Put: {
                            TableName: tableName,
                            Item: rowsItem(validFrom, publication.rows, observedAt),
                            ...condition,
                        },
                    },
                    { Put: { TableName: tableName, Item: tableItem('en'), ...condition } },
                    { Put: { TableName: tableName, Item: tableItem('ka'), ...condition } },
                ],
                signal,
            );
            if (!written.ok) {
                return written;
            }
            return ok(written.value === 'written' ? 'committed' : 'superseded');
        },

        async removePublication(validFrom, observedAt, signal) {
            const condition = olderOrAbsent(observedAt);
            const written = await transact(
                ['rows', tablePk('en'), tablePk('ka')].map((pk) => ({
                    Delete: { TableName: tableName, Key: key(pk, validFrom), ...condition },
                })),
                signal,
            );
            if (!written.ok) {
                return written;
            }
            return ok(written.value === 'written' ? 'removed' : 'superseded');
        },

        async writeArchiveRows(items, signal) {
            // An empty list sends nothing: DynamoDB refuses a BatchWriteItem without requests.
            for (let start = 0; start < items.length; start += BATCH_SIZE) {
                let requests: ReadonlyArray<WriteRequest> = items
                    .slice(start, start + BATCH_SIZE)
                    .map((item) => ({ PutRequest: { Item: rowsItem(item.validFrom, item.rows, item.observedAt) } }));
                while (requests.length > 0) {
                    const batch = [...requests];
                    const response = await call(() =>
                        client.send(new BatchWriteItemCommand({ RequestItems: { [tableName]: batch } }), {
                            abortSignal: signal,
                        }),
                    );
                    if (!response.ok) {
                        return response;
                    }
                    requests = response.value.UnprocessedItems?.[tableName] ?? [];
                }
            }
            return ok(undefined);
        },

        async replaceArchivePublication(validFrom, rows, observedAt, signal) {
            const condition = olderOrAbsent(observedAt);
            const rowsWrite: TransactWriteItem =
                rows === undefined
                    ? { Delete: { TableName: tableName, Key: key('rows', validFrom), ...condition } }
                    : { Put: { TableName: tableName, Item: rowsItem(validFrom, rows, observedAt), ...condition } };
            const written = await transact(
                [
                    rowsWrite,
                    { Delete: { TableName: tableName, Key: key(tablePk('en'), validFrom) } },
                    { Delete: { TableName: tableName, Key: key(tablePk('ka'), validFrom) } },
                ],
                signal,
            );
            if (!written.ok) {
                return written;
            }
            return ok(written.value === 'written' ? 'replaced' : 'superseded');
        },
    };
}
