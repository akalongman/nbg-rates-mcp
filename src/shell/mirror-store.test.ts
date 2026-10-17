import { describe, expect, it } from 'vitest';
import { createMemoryMirrorStore, seedMirror } from '../../test/helpers/memory-mirror-store.js';
import { describeMirrorStoreContract } from '../../test/helpers/mirror-store-contract.js';
import { publication, rowsFromTable, syntheticTable, tableFixture } from '../../test/helpers/publications.js';
import { date } from '../../test/helpers/values.js';
import { EMPTY_MIRROR_STATE } from '../core/mirror.js';
import type { NbgCsvRow } from '../core/nbg-csv.js';
import { ok } from '../core/types.js';

describeMirrorStoreContract('memory', () =>
    Promise.resolve({ store: createMemoryMirrorStore(), close: () => Promise.resolve() }),
);

const SIGNAL = new AbortController().signal;
const EN_2026_10_07 = tableFixture('en', '2026-10-07');
const AT_1000 = publication(EN_2026_10_07, { ka: tableFixture('ka', '2026-10-07'), observedAt: 1000 });
const MARCH_15 = syntheticTable('2024-03-15', { USD: 2.65, EUR: 2.88 });
const MARCH_18 = syntheticTable('2024-03-18', { USD: 2.67, EUR: 2.9 });

describe('createMemoryMirrorStore', () => {
    it('keeps a past table as pk, sk and the table alone', async () => {
        const store = createMemoryMirrorStore();
        await store.fillPastTable(date('2024-03-15'), 'en', MARCH_15, SIGNAL);
        const raw = store.rawItem('table#en', '2024-03-15');
        expect(Object.keys(raw ?? {}).sort()).toEqual(['day', 'pk', 'sk']);
        expect(raw).toMatchObject({ pk: 'table#en', sk: '2024-03-15' });
        expect(JSON.parse(String(raw?.day))).toEqual(MARCH_15);
        expect(store.rawItem('table#ka', '2024-03-15')).toBeUndefined();
    });

    it('lays out committed items with their observation', async () => {
        const store = createMemoryMirrorStore();
        await store.commitPublication(AT_1000, SIGNAL);
        for (const pk of ['rows', 'table#en', 'table#ka']) {
            expect(store.rawItem(pk, '2026-10-07')).toMatchObject({ pk, sk: '2026-10-07', observedAt: 1000 });
        }
        expect(Object.keys(store.rawItem('rows', '2026-10-07') ?? {}).sort()).toEqual([
            'observedAt',
            'pk',
            'rows',
            'sk',
        ]);
        await store.updateState((state) => ({ next: state, outcome: undefined }), SIGNAL);
        expect(store.rawItem('state', 'state')).toMatchObject({ pk: 'state', sk: 'state', revision: 1 });
    });

    it('records each successful write in order, and nothing for superseded, present or failed calls', async () => {
        const store = createMemoryMirrorStore();
        await store.updateState((state) => ({ next: { ...state, freshUntil: 1 }, outcome: undefined }), SIGNAL);
        await store.updateState(() => ({ next: undefined, outcome: undefined }), SIGNAL);
        await store.commitPublication(AT_1000, SIGNAL);
        await store.commitPublication({ ...AT_1000, observedAt: 999 }, SIGNAL);
        await store.fillPastTable(date('2024-03-15'), 'en', MARCH_15, SIGNAL);
        await store.fillPastTable(date('2024-03-15'), 'en', MARCH_15, SIGNAL);
        await store.writeArchiveRows(
            [
                { validFrom: date('2024-03-15'), rows: rowsFromTable(MARCH_15), observedAt: 500 },
                { validFrom: date('2024-03-18'), rows: rowsFromTable(MARCH_18), observedAt: 500 },
            ],
            SIGNAL,
        );
        await store.replaceArchivePublication(date('2024-03-15'), undefined, 600, SIGNAL);
        await store.removePublication(date('2026-10-07'), 999, SIGNAL);
        await store.removePublication(date('2026-10-07'), 2000, SIGNAL);
        await store.commitPublication(AT_1000, AbortSignal.abort());

        expect(store.writes).toEqual([
            { operation: 'state', key: 'state/state' },
            { operation: 'commit', key: 'rows/2026-10-07' },
            { operation: 'fill', key: 'table#en/2024-03-15' },
            { operation: 'archive', key: 'rows/2024-03-15' },
            { operation: 'archive', key: 'rows/2024-03-18' },
            { operation: 'replace', key: 'rows/2024-03-15' },
            { operation: 'remove', key: 'rows/2026-10-07' },
        ]);
    });

    it('calls the before hook with each operation name', async () => {
        const store = createMemoryMirrorStore();
        const names: string[] = [];
        store.before((operation) => {
            names.push(operation);
        });
        const day = date('2026-10-07');
        await store.readState(SIGNAL);
        await store.readRowsInForce(day, SIGNAL);
        await store.readTable(day, 'en', SIGNAL);
        await store.readRowsBetween(day, day, SIGNAL);
        await store.readTablesBetween(day, day, SIGNAL);
        await store.updateState((state) => ({ next: state, outcome: undefined }), SIGNAL);
        await store.commitPublication(AT_1000, SIGNAL);
        await store.removePublication(day, 2000, SIGNAL);
        await store.fillPastTable(day, 'en', EN_2026_10_07, SIGNAL);
        await store.writeArchiveRows([], SIGNAL);
        await store.replaceArchivePublication(day, undefined, 3000, SIGNAL);
        store.before(undefined);
        await store.readState(SIGNAL);

        expect(names).toEqual([
            'readState',
            'readRowsInForce',
            'readTable',
            'readRowsBetween',
            'readTablesBetween',
            'state',
            'commit',
            'remove',
            'fill',
            'archive',
            'replace',
        ]);
    });

    it('lets a before hook hang an operation until its signal aborts', async () => {
        const store = createMemoryMirrorStore();
        store.before((operation) => (operation === 'fill' ? new Promise<void>(() => undefined) : undefined));
        const started = Date.now();
        const result = await store.fillPastTable(date('2024-03-15'), 'en', MARCH_15, AbortSignal.timeout(20));
        expect(result.ok ? 'ok' : result.error.kind).toBe('store_failed');
        expect(Date.now() - started).toBeLessThan(1000);
        expect(store.rawItem('table#en', '2024-03-15')).toBeUndefined();
        expect(store.writes).toEqual([]);
        expect(await store.readState(SIGNAL)).toEqual(ok(EMPTY_MIRROR_STATE));
    });

    it('lets a before hook interleave a write before the operation reads', async () => {
        const store = createMemoryMirrorStore();
        let interleaved = false;
        store.before(async (operation) => {
            if (operation === 'readTable' && !interleaved) {
                interleaved = true;
                await store.commitPublication(AT_1000, SIGNAL);
            }
        });
        const table = await store.readTable(date('2026-10-07'), 'en', SIGNAL);
        expect(table).toEqual(ok({ validFrom: '2026-10-07', day: EN_2026_10_07, observedAt: 1000 }));
    });

    it('fails every operation with the failWith detail until cleared', async () => {
        const store = createMemoryMirrorStore();
        store.failWith('down');
        expect(await store.readState(SIGNAL)).toEqual({ ok: false, error: { kind: 'store_failed', detail: 'down' } });
        expect(await store.commitPublication(AT_1000, SIGNAL)).toEqual({
            ok: false,
            error: { kind: 'store_failed', detail: 'down' },
        });
        expect(store.writes).toEqual([]);
        store.failWith(undefined);
        expect(await store.commitPublication(AT_1000, SIGNAL)).toEqual(ok('committed'));
    });

    it('copies values on the way in and out', async () => {
        const store = createMemoryMirrorStore();
        const rows: NbgCsvRow[] = [...AT_1000.rows];
        await store.commitPublication({ ...AT_1000, rows }, SIGNAL);
        rows.length = 0;

        const first = await store.readRowsInForce(date('2026-10-07'), SIGNAL);
        if (!first.ok || first.value === undefined) {
            throw new Error('the committed rows are missing');
        }
        Reflect.set(first.value.rows, 'length', 0);
        Reflect.set(first.value, 'observedAt', 0);
        const raw = store.rawItem('rows', '2026-10-07');
        if (raw !== undefined) {
            Reflect.set(raw, 'observedAt', 0);
        }

        expect(await store.readRowsInForce(date('2026-10-07'), SIGNAL)).toEqual(
            ok({ validFrom: '2026-10-07', rows: AT_1000.rows, observedAt: 1000 }),
        );
    });
});

describe('seedMirror', () => {
    it('commits the publications, writes the archive rows and merges the state fields', async () => {
        const store = createMemoryMirrorStore();
        const archive = { validFrom: date('2024-03-15'), rows: rowsFromTable(MARCH_15), observedAt: 0 };
        const span = { start: date('2026-10-07'), end: date('2026-10-09') };
        await seedMirror(store, {
            publications: [AT_1000],
            archiveRows: [archive],
            state: { span, rowsStart: date('2024-01-01') },
        });

        expect(await store.readState(SIGNAL)).toEqual(
            ok({ ...EMPTY_MIRROR_STATE, revision: 1, span, rowsStart: '2024-01-01' }),
        );
        expect(await store.readRowsBetween(date('2024-01-01'), date('2026-12-31'), SIGNAL)).toEqual(
            ok([archive, { validFrom: '2026-10-07', rows: AT_1000.rows, observedAt: 1000 }]),
        );
        expect(await store.readTablesBetween(date('2026-10-07'), date('2026-10-07'), SIGNAL)).toEqual(
            ok([{ validFrom: '2026-10-07', en: AT_1000.en, ka: AT_1000.ka, observedAt: 1000 }]),
        );
    });
});
