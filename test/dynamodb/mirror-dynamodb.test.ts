import { randomUUID } from 'node:crypto';
import {
    CreateTableCommand,
    DeleteItemCommand,
    DeleteTableCommand,
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    waitUntilTableExists,
    type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../src/core/dates.js';
import type { NbgCsvRow } from '../../src/core/nbg-csv.js';
import { ok, type CalendarDate } from '../../src/core/types.js';
import { createDynamoMirrorStore } from '../../src/shell/mirror-dynamodb.js';
import type { StoredRows } from '../../src/shell/mirror-store.js';
import { describeMirrorStoreContract } from '../helpers/mirror-store-contract.js';
import { publication, rowsFromTable, syntheticTable, tableFixture } from '../helpers/publications.js';
import { date } from '../helpers/values.js';

const endpoint = process.env.DYNAMODB_ENDPOINT;
if (endpoint === undefined || endpoint.trim() === '') {
    throw new Error('DYNAMODB_ENDPOINT is not set: point it at DynamoDB Local, for example http://127.0.0.1:8000');
}

/** Static credentials and a fixed region, so the suite never reaches a real AWS account. */
const client = new DynamoDBClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

afterAll(() => {
    client.destroy();
});

/** Never aborts. */
const SIGNAL = new AbortController().signal;

/** An attribute as a plain value: an S as a string, an N as a number. */
function plainValue(value: AttributeValue): unknown {
    if (value.S !== undefined) {
        return value.S;
    }
    if (value.N !== undefined) {
        return Number(value.N);
    }
    throw new Error(`the item holds an attribute of another type: ${Object.keys(value).join(', ')}`);
}

/** An empty table named mirror-test-<random>, keyed as the mirror's table is. */
async function openTable(): Promise<{
    readonly tableName: string;
    readonly store: ReturnType<typeof createDynamoMirrorStore>;
    rawItem(pk: string, sk: string): Promise<Readonly<Record<string, unknown>> | undefined>;
    close(): Promise<void>;
}> {
    const tableName = `mirror-test-${randomUUID()}`;
    await client.send(
        new CreateTableCommand({
            TableName: tableName,
            BillingMode: 'PAY_PER_REQUEST',
            AttributeDefinitions: [
                { AttributeName: 'pk', AttributeType: 'S' },
                { AttributeName: 'sk', AttributeType: 'S' },
            ],
            KeySchema: [
                { AttributeName: 'pk', KeyType: 'HASH' },
                { AttributeName: 'sk', KeyType: 'RANGE' },
            ],
        }),
    );
    // DynamoDB Local creates a table at once; the short delays keep a slow start inside Vitest's hook timeout.
    await waitUntilTableExists({ client, minDelay: 1, maxDelay: 1, maxWaitTime: 5 }, { TableName: tableName });
    return {
        tableName,
        store: createDynamoMirrorStore({ tableName, client }),
        async rawItem(pk, sk) {
            const { Item } = await client.send(
                new GetItemCommand({
                    TableName: tableName,
                    Key: { pk: { S: pk }, sk: { S: sk } },
                    ConsistentRead: true,
                }),
            );
            if (Item === undefined) {
                return undefined;
            }
            return Object.fromEntries(Object.entries(Item).map(([name, value]) => [name, plainValue(value)]));
        },
        async close() {
            await client.send(new DeleteTableCommand({ TableName: tableName }));
        },
    };
}

describeMirrorStoreContract('dynamodb', openTable);

/** A rows item of about 3 KB: 33 rows valid from `validFrom`. */
function archiveItem(validFrom: CalendarDate): StoredRows {
    const publishedOn = addDays(validFrom, -1);
    const letter = (index: number): string => String.fromCharCode(65 + index);
    const rows = Array.from({ length: 33 }, (_, index): NbgCsvRow => ({
        code: `X${letter(Math.floor(index / 26))}${letter(index % 26)}`,
        quantity: 1,
        rate: Number((1 + index / 100).toFixed(4)),
        publishedOn,
        validFrom,
    }));
    return { validFrom, rows, observedAt: 500 };
}

describe('the DynamoDB mirror store on DynamoDB Local', () => {
    let opened: Awaited<ReturnType<typeof openTable>>;

    beforeEach(async () => {
        opened = await openTable();
    });

    afterEach(async () => {
        await opened.close();
    });

    it('writes 400 rows items of about 3 KB and reads them back complete across more than one page', async () => {
        const first = date('2020-01-01');
        const items = Array.from({ length: 400 }, (_, index) => archiveItem(addDays(first, index)));
        expect(JSON.stringify(items[0]?.rows).length).toBeGreaterThan(2900);

        expect(await opened.store.writeArchiveRows(items, SIGNAL)).toEqual(ok(undefined));

        // A query page holds at most 1 MB, so the rows items do not fit in one.
        const firstPage = await client.send(
            new QueryCommand({
                TableName: opened.tableName,
                KeyConditionExpression: 'pk = :pk',
                ExpressionAttributeValues: { ':pk': { S: 'rows' } },
                ConsistentRead: true,
            }),
        );
        expect(firstPage.LastEvaluatedKey).toBeDefined();
        expect(firstPage.Items?.length).toBeLessThan(400);

        expect(await opened.store.readRowsBetween(first, addDays(first, 399), SIGNAL)).toEqual(ok(items));
    });

    it('leaves the rows item unchanged when a commit fails its condition on the second item only', async () => {
        const validFrom = date('2026-10-07');
        const english = tableFixture('en', '2026-10-07');
        const other = syntheticTable('2026-10-07', { USD: 2.7, EUR: 3.1 });
        const { store } = opened;
        expect(await store.commitPublication(publication(english, { observedAt: 1000 }), SIGNAL)).toEqual(
            ok('committed'),
        );
        const olderRows = { validFrom, rows: rowsFromTable(other), observedAt: 500 };
        expect(await store.writeArchiveRows([olderRows], SIGNAL)).toEqual(ok(undefined));
        // Now only the English table, the commit's second item, is newer than 800: the rows item is older and the
        // Georgian table is absent, so the first and third items would pass their conditions on their own.
        await client.send(
            new DeleteItemCommand({
                TableName: opened.tableName,
                Key: { pk: { S: 'table#ka' }, sk: { S: validFrom } },
            }),
        );
        const rowsBefore = await opened.rawItem('rows', validFrom);
        expect(rowsBefore).toMatchObject({ observedAt: 500 });

        expect(await store.commitPublication(publication(other, { observedAt: 800 }), SIGNAL)).toEqual(
            ok('superseded'),
        );

        expect(await opened.rawItem('rows', validFrom)).toEqual(rowsBefore);
        expect(await store.readTable(validFrom, 'en', SIGNAL)).toEqual(
            ok({ validFrom, day: english, observedAt: 1000 }),
        );
        expect(await store.readTable(validFrom, 'ka', SIGNAL)).toEqual(ok(undefined));
    });

    it('writes an empty list of archive rows without a request', async () => {
        const send = vi.spyOn(client, 'send');
        try {
            expect(await opened.store.writeArchiveRows([], SIGNAL)).toEqual(ok(undefined));
            expect(send).not.toHaveBeenCalled();
        } finally {
            send.mockRestore();
        }
    });

    it('reads an empty range when its start is after its end', async () => {
        const { store } = opened;
        expect(await store.readRowsBetween(date('2026-10-07'), date('2026-10-06'), SIGNAL)).toEqual(ok([]));
        expect(await store.readTablesBetween(date('2026-10-07'), date('2026-10-06'), SIGNAL)).toEqual(ok([]));
    });
});
