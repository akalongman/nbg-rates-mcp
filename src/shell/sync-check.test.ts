import { describe, expect, it } from 'vitest';
import { createFakeNbg, type FakeNbg } from '../../test/helpers/fake-nbg.js';
import { createMemoryMirrorStore, seedMirror, type MemoryMirrorStore } from '../../test/helpers/memory-mirror-store.js';
import { publication, tableFixture } from '../../test/helpers/publications.js';
import { date } from '../../test/helpers/values.js';
import { tableCodes, type MirrorPublication } from '../core/mirror-publication.js';
import type { NbgDay } from '../core/nbg-schema.js';
import type { CalendarDate } from '../core/types.js';
import {
    COMMIT_RESERVE_MS,
    createSyncContext,
    LOG_RESERVE_MS,
    resolvePublication,
    SYNC_REQUEST_SPACING_MS,
    SYNC_REQUEST_WORST_MS,
    type SyncContext,
} from './sync-publication.js';

const SIGNAL = new AbortController().signal;
const EN_2026_10_07 = tableFixture('en', '2026-10-07');
const OCTOBER_7 = publication(EN_2026_10_07, { ka: tableFixture('ka', '2026-10-07') });
/** The publication before it: NBG's JSON answers its table for 2026-10-07 once that date's table is withdrawn. */
const OCTOBER_6 = publication(tableFixture('en', '2026-10-06'));
const CODES = tableCodes(EN_2026_10_07);
/** 10:00:02 in Tbilisi on Thursday 2026-10-08. */
const NOW = new Date('2026-10-08T06:00:02Z');
const SCHEDULED = new Date('2026-10-08T06:00:00Z');

interface Fixture {
    readonly store: MemoryMirrorStore;
    readonly fake: FakeNbg;
    readonly context: SyncContext;
    readonly sleeps: ReadonlyArray<number>;
}

async function setUp(
    options: {
        readonly nbg?: ReadonlyArray<MirrorPublication>;
        readonly stored?: ReadonlyArray<MirrorPublication>;
        readonly unresolved?: ReadonlyArray<CalendarDate>;
        readonly remainingMs?: () => number;
    } = {},
): Promise<Fixture> {
    const store = createMemoryMirrorStore();
    await seedMirror(store, {
        publications: options.stored ?? [],
        ...(options.unresolved === undefined ? {} : { state: { unresolved: options.unresolved } }),
    });
    const fake = createFakeNbg(options.nbg ?? [OCTOBER_7]);
    const sleeps: number[] = [];
    const context = createSyncContext({
        store,
        client: fake.client,
        now: () => NOW,
        sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
        },
        scheduledAt: SCHEDULED,
        remainingMs: options.remainingMs ?? (() => 25_000),
    });
    return { store, fake, context, sleeps };
}

function withUsd(table: NbgDay, usd: number): NbgDay {
    return {
        ...table,
        currencies: table.currencies.map((row) => ({ ...row, rate: row.code === 'USD' ? usd : row.rate })),
    };
}

describe('createSyncContext', () => {
    it('sends a request only while the time left covers the spacing, its worst case, a commit and the log line', async () => {
        const first = SYNC_REQUEST_WORST_MS + COMMIT_RESERVE_MS + LOG_RESERVE_MS;
        const second = SYNC_REQUEST_SPACING_MS + first;
        expect(first).toBe(15_500);

        const short = await setUp({ remainingMs: () => first - 1 });
        expect(await short.context.fetchDay(date('2026-10-07'), 'en')).toEqual({ kind: 'deadline' });
        expect(short.fake.requests).toEqual([]);

        const one = await setUp({ remainingMs: () => second - 1 });
        expect((await one.context.fetchDay(date('2026-10-07'), 'en')).kind).toBe('ok');
        expect(await one.context.fetchDay(date('2026-10-07'), 'ka')).toEqual({ kind: 'deadline' });
        expect(one.fake.requests).toEqual(['day:en:2026-10-07']);
        expect(one.sleeps).toEqual([]);
        expect(one.context.counts).toEqual({ nbgRequests: 1, committed: 0 });

        const two = await setUp({ remainingMs: () => second });
        expect((await two.context.fetchDay(date('2026-10-07'), 'en')).kind).toBe('ok');
        expect((await two.context.fetchRange(CODES, date('2026-10-07'), date('2026-10-07'))).kind).toBe('ok');
        expect(two.fake.requests).toEqual(['day:en:2026-10-07', `range:${CODES.join(',')}:2026-10-07:2026-10-07`]);
        expect(two.sleeps).toEqual([SYNC_REQUEST_SPACING_MS]);
        expect(two.context.counts).toEqual({ nbgRequests: 2, committed: 0 });
    });

    it('allows `ms` while the time left minus the log reserve covers it', async () => {
        const { context } = await setUp({ remainingMs: () => COMMIT_RESERVE_MS + LOG_RESERVE_MS });
        expect(context.allows(COMMIT_RESERVE_MS)).toBe(true);
        expect(context.allows(COMMIT_RESERVE_MS + 1)).toBe(false);
    });

    it('takes today in Tbilisi from the scheduled time', async () => {
        const { context } = await setUp();
        expect(context.today).toBe('2026-10-08');
        expect(context.scheduledAt).toBe(SCHEDULED);
    });
});

describe('resolvePublication', () => {
    it('given the English table, asks only for the Georgian table and the CSV, and commits at its observation', async () => {
        const { store, fake, context } = await setUp();
        const observedAt = Date.parse('2026-10-08T06:00:01Z');
        const outcome = await resolvePublication(context, date('2026-10-07'), undefined, [], {
            observedAt,
            en: EN_2026_10_07,
        });
        expect(outcome).toEqual({ ok: true, value: 'committed' });
        expect(fake.requests).toEqual(['day:ka:2026-10-07', `range:${CODES.join(',')}:2026-10-07:2026-10-07`]);
        expect(store.rawItem('rows', '2026-10-07')?.observedAt).toBe(observedAt);
        expect(store.rawItem('table#en', '2026-10-07')?.observedAt).toBe(observedAt);
        expect(context.counts).toEqual({ nbgRequests: 2, committed: 1 });
    });

    it('marks the date unresolved when only one of the two views has its table', async () => {
        const { store, fake, context } = await setUp();
        const outcome = await resolvePublication(context, date('2026-10-07'), OCTOBER_7.rows, CODES, {
            observedAt: NOW.getTime(),
            en: EN_2026_10_07,
            ka: tableFixture('en', '2026-10-06'),
        });
        expect(outcome).toEqual({ ok: true, value: 'unresolved' });
        expect(fake.requests).toEqual([]);
        expect(store.writes).toEqual([{ operation: 'state', key: 'state/state' }]);
        const state = await store.readState(SIGNAL);
        expect(state.ok && state.value.unresolved).toEqual(['2026-10-07']);
    });

    it('marks the date unresolved when the CSV rows disagree with both tables', async () => {
        const { store, context } = await setUp();
        const otherRows = publication(withUsd(EN_2026_10_07, 2.6111)).rows;
        const outcome = await resolvePublication(context, date('2026-10-07'), otherRows, CODES);
        expect(outcome).toEqual({ ok: true, value: 'unresolved' });
        expect(store.rawItem('rows', '2026-10-07')).toBeUndefined();
    });

    it('answers unchanged without a write when the stored copy holds the same tables and rows', async () => {
        const { store, context } = await setUp({ stored: [OCTOBER_7] });
        const before = store.writes.length;
        const outcome = await resolvePublication(context, date('2026-10-07'), OCTOBER_7.rows, CODES);
        expect(outcome).toEqual({ ok: true, value: 'unchanged' });
        expect(store.writes.slice(before)).toEqual([]);
        expect(context.counts.committed).toBe(0);
    });

    it('answers unchanged and leaves the state to the newer run when a newer observation holds the date', async () => {
        const newer = publication(withUsd(EN_2026_10_07, 2.6111), { observedAt: Date.parse('2026-10-08T13:01:02Z') });
        const { store, context } = await setUp({ stored: [newer], unresolved: [date('2026-10-07')] });
        const before = store.writes.length;
        const outcome = await resolvePublication(context, date('2026-10-07'), OCTOBER_7.rows, CODES);
        expect(outcome).toEqual({ ok: true, value: 'unchanged' });
        expect(store.writes.slice(before)).toEqual([]);
        expect(store.rawItem('rows', '2026-10-07')?.observedAt).toBe(newer.observedAt);
        const state = await store.readState(SIGNAL);
        expect(state.ok && state.value.unresolved).toEqual(['2026-10-07']);
        expect(context.counts.committed).toBe(0);
    });

    it('marks a date resolved once its sources agree with what the mirror holds', async () => {
        const { store, context } = await setUp({ stored: [OCTOBER_7], unresolved: [date('2026-10-07')] });
        const outcome = await resolvePublication(context, date('2026-10-07'), OCTOBER_7.rows, CODES);
        expect(outcome).toEqual({ ok: true, value: 'unchanged' });
        const state = await store.readState(SIGNAL);
        expect(state.ok && state.value.unresolved).toEqual([]);
    });

    it('fetches the CSV for the date alone when its tables quote a code the rows given were not asked for', async () => {
        const { fake, context } = await setUp();
        const outcome = await resolvePublication(
            context,
            date('2026-10-07'),
            OCTOBER_7.rows.filter((row) => row.code !== 'AMD'),
            CODES.filter((candidate) => candidate !== 'AMD'),
        );
        expect(outcome).toEqual({ ok: true, value: 'committed' });
        expect(fake.requests).toEqual([
            'day:en:2026-10-07',
            'day:ka:2026-10-07',
            `range:${CODES.join(',')}:2026-10-07:2026-10-07`,
        ]);
    });

    it('fails with empty_export when the CSV for a date whose tables are there is empty', async () => {
        const { fake, context } = await setUp({ nbg: [] });
        fake.publishJson(OCTOBER_7);
        const outcome = await resolvePublication(context, date('2026-10-07'), undefined, []);
        expect(outcome).toEqual({ ok: false, error: { kind: 'empty_export' } });
    });

    it('resolves a date with no table and no rows at NBG and nothing stored, without a commit', async () => {
        const { store, context } = await setUp();
        const outcome = await resolvePublication(context, date('2026-10-05'), [], CODES);
        expect(outcome).toEqual({ ok: true, value: 'unchanged' });
        expect(store.writes).toEqual([]);
    });

    it('removes the stored copy when the rows given, from an export covering the date, hold none for it', async () => {
        const { store, fake, context } = await setUp({ nbg: [OCTOBER_6], stored: [OCTOBER_7] });
        const outcome = await resolvePublication(context, date('2026-10-07'), [], CODES);
        expect(outcome).toEqual({ ok: true, value: 'removed' });
        expect(fake.requests).toEqual(['day:en:2026-10-07', 'day:ka:2026-10-07']);
        expect(store.rawItem('rows', '2026-10-07')).toBeUndefined();
        expect(context.counts.committed).toBe(1);
    });

    it('asks the CSV for the date alone when no rows were given and neither view has its table', async () => {
        const { store, fake, context } = await setUp({ nbg: [OCTOBER_6], stored: [OCTOBER_7] });
        fake.publishCsv(OCTOBER_7);
        const before = store.writes.length;
        const outcome = await resolvePublication(context, date('2026-10-07'), undefined, []);
        expect(outcome).toEqual({ ok: true, value: 'unresolved' });
        expect(fake.requests).toEqual([
            'day:en:2026-10-07',
            'day:ka:2026-10-07',
            `range:${CODES.join(',')}:2026-10-07:2026-10-07`,
        ]);
        expect(store.writes.slice(before)).toEqual([{ operation: 'state', key: 'state/state' }]);
        expect(store.rawItem('rows', '2026-10-07')).toBeDefined();
        const state = await store.readState(SIGNAL);
        expect(state.ok && state.value.unresolved).toEqual(['2026-10-07']);
    });

    it('fails with empty_export instead of removing when the export for the date alone is empty', async () => {
        const { store, fake, context } = await setUp({ nbg: [OCTOBER_6], stored: [OCTOBER_7] });
        const before = store.writes.length;
        const outcome = await resolvePublication(context, date('2026-10-07'), undefined, []);
        expect(outcome).toEqual({ ok: false, error: { kind: 'empty_export' } });
        expect(fake.requests).toHaveLength(3);
        expect(store.writes.slice(before)).toEqual([]);
        expect(store.rawItem('rows', '2026-10-07')).toBeDefined();
    });
});
