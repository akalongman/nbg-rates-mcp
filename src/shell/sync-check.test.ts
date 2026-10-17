import { describe, expect, it, vi } from 'vitest';
import { createFakeNbg, type FakeNbg } from '../../test/helpers/fake-nbg.js';
import { createMemoryMirrorStore, seedMirror, type MemoryMirrorStore } from '../../test/helpers/memory-mirror-store.js';
import { publication, tableFixture } from '../../test/helpers/publications.js';
import {
    at,
    expectedHeld,
    held,
    line,
    mirroredService,
    setUp as setUpRuns,
    SIGNAL,
    skipDailySteps,
    tableFrom,
    tbilisi,
    UNAVAILABLE,
    withRates,
    type Harness,
    type RunOptions,
} from '../../test/helpers/sync-harness.js';
import { date } from '../../test/helpers/values.js';
import { markUnresolved } from '../core/mirror.js';
import { tableCodes, type MirrorPublication } from '../core/mirror-publication.js';
import type { NbgDay } from '../core/nbg-schema.js';
import { err, type CalendarDate } from '../core/types.js';
import type { NbgClient } from './nbg-client.js';
import type { SyncLogLine } from './sync.js';
import {
    COMMIT_RESERVE_MS,
    createSyncContext,
    LOG_RESERVE_MS,
    resolvePublication,
    SYNC_REQUEST_SPACING_MS,
    SYNC_REQUEST_WORST_MS,
    type SyncContext,
} from './sync-publication.js';

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

const FRIDAY = '2026-10-16';
const WEDNESDAY = '2026-10-14';
/** NBG's tables valid from 2026-10-09 to 2026-10-16: one per business day, each written the day before. */
const WEEK: ReadonlyArray<MirrorPublication> = [
    '2026-10-09',
    '2026-10-10',
    '2026-10-13',
    '2026-10-14',
    '2026-10-15',
    '2026-10-16',
].map((day, index) => publication(tableFrom(day, Number((2.7 + index / 1000).toFixed(4)))));
/** The table valid from Saturday 2026-10-17, which NBG publishes at 17:00 on Friday. */
const SATURDAY = publication(tableFrom('2026-10-17', 2.7123));
const TOMORROW_EN = 'day:en:2026-10-17';
const TOMORROW_KA = 'day:ka:2026-10-17';
/** The CSV request for 2026-10-17 alone, naming the codes of its English table. */
const TOMORROW_CSV = `range:${CODES.join(',')}:2026-10-17:2026-10-17`;

/** The same tables written again by NBG under a new write stamp, as it rewrites a table about a minute later. */
function rewritten(subject: MirrorPublication, writtenAt: string): MirrorPublication {
    const restamp = (table: NbgDay): NbgDay => ({
        ...table,
        currencies: table.currencies.map((row) => ({ ...row, date: writtenAt })),
    });
    return publication(restamp(subject.en), { ka: restamp(subject.ka) });
}

/** The window event of 17:mm Tbilisi time on `day`. */
function windowRun(
    harness: Harness,
    day: string,
    minute: number,
    options: Omit<RunOptions, 'kind'> = {},
): Promise<SyncLogLine> {
    return harness.run(`${day}T17:${String(minute).padStart(2, '0')}`, { ...options, kind: 'window' });
}

/** Friday 2026-10-16 with the mirror bootstrapped by the 16:00 hourly run, fresh until 17:02. */
async function friday(): Promise<Harness> {
    const harness = await setUpRuns({ nbg: WEEK });
    const bootstrap = await harness.run(`${FRIDAY}T16:00`);
    expect(bootstrap).toMatchObject({ syncResult: 'ok', checked: true, span: '2026-10-09..2026-10-17' });
    expect((await harness.state()).freshUntil).toBe(at(`${FRIDAY}T17:02`));
    return harness;
}

describe('runWindowCheck: the publication window', () => {
    it("commits tomorrow's table the minute it appears and stops after ten quiet runs", async () => {
        const harness = await friday();
        const opening = harness.mark();
        expect(await windowRun(harness, FRIDAY, 0)).toEqual(
            line({
                time: '2026-10-16T13:00:02.000Z',
                syncRun: 'window',
                scheduledTime: '2026-10-16T13:00:00.000Z',
                checked: true,
                nbgRequests: 1,
                span: '2026-10-09..2026-10-17',
            }),
        );
        expect(harness.since(opening).requests).toEqual([TOMORROW_EN]);
        const opened = await harness.state();
        expect(opened.freshUntil).toBe(at('2026-10-16T17:03'));
        expect(opened.window).toEqual({
            date: FRIDAY,
            committed: false,
            quietRuns: 0,
            stopped: false,
            at: at('2026-10-16T17:00'),
        });

        harness.fake.publish(SATURDAY);
        const appeared = harness.mark();
        expect(await windowRun(harness, FRIDAY, 1)).toMatchObject({
            syncResult: 'ok',
            checked: true,
            committed: 1,
            nbgRequests: 3,
        });
        expect(harness.since(appeared).requests).toEqual([TOMORROW_EN, TOMORROW_KA, TOMORROW_CSV]);
        const firstCopy = expectedHeld(SATURDAY, at('2026-10-16T17:01:02'));
        expect(await held(harness.store, '2026-10-17')).toEqual(firstCopy);

        // NBG writes the table a second time; only the write stamps change.
        harness.fake.publish(rewritten(SATURDAY, '2026-10-16T17:01:14.467Z'));
        for (let minute = 2; minute <= 11; minute += 1) {
            const quiet = harness.mark();
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({
                syncResult: 'ok',
                syncDetail: null,
                checked: true,
                committed: 0,
                nbgRequests: 1,
            });
            expect(harness.since(quiet).requests).toEqual([TOMORROW_EN]);
            const state = await harness.state();
            expect(state.window).toMatchObject({ committed: true, quietRuns: minute - 1, stopped: minute === 11 });
            expect(state.freshUntil).toBe(
                minute === 11 ? at('2026-10-16T18:05') : at(`${FRIDAY}T17:${String(minute + 3).padStart(2, '0')}`),
            );
        }
        const stopped = await harness.state();
        expect(stopped.window).toEqual({
            date: FRIDAY,
            committed: true,
            quietRuns: 10,
            stopped: true,
            at: at('2026-10-16T17:11'),
        });

        for (let minute = 12; minute <= 30; minute += 1) {
            const skipped = harness.mark();
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({
                syncRun: 'window',
                syncResult: 'skipped',
                syncDetail: 'window_stopped',
                checked: false,
                nbgRequests: 0,
                span: '2026-10-09..2026-10-17',
            });
            expect(harness.since(skipped).requests).toEqual([]);
            expect(harness.since(skipped).writes).toEqual([]);
        }
        expect(await harness.state()).toEqual(stopped);
        expect(await held(harness.store, '2026-10-17')).toEqual(firstCopy);
    });

    it('commits a rate the second write changes and stops ten quiet runs after that commit', async () => {
        const harness = await friday();
        harness.fake.publish(SATURDAY);
        expect(await windowRun(harness, FRIDAY, 1)).toMatchObject({ syncResult: 'ok', committed: 1 });
        const second = publication(withRates(rewritten(SATURDAY, '2026-10-16T17:01:14.467Z').en, { USD: 2.7155 }));
        harness.fake.publish(second);
        const changed = harness.mark();
        expect(await windowRun(harness, FRIDAY, 2)).toMatchObject({ syncResult: 'ok', committed: 1, nbgRequests: 3 });
        expect(harness.since(changed).requests).toEqual([TOMORROW_EN, TOMORROW_KA, TOMORROW_CSV]);
        expect(await held(harness.store, '2026-10-17')).toEqual(expectedHeld(second, at('2026-10-16T17:02:02')));
        expect((await harness.state()).window).toMatchObject({ committed: true, quietRuns: 0, stopped: false });

        for (let minute = 3; minute <= 11; minute += 1) {
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({
                syncResult: 'ok',
                committed: 0,
                nbgRequests: 1,
            });
        }
        expect((await harness.state()).window).toMatchObject({ quietRuns: 9, stopped: false });
        expect(await windowRun(harness, FRIDAY, 12)).toMatchObject({ syncResult: 'ok', nbgRequests: 1 });
        const stopped = await harness.state();
        expect(stopped.window).toMatchObject({ quietRuns: 10, stopped: true, at: at('2026-10-16T17:12') });
        expect(stopped.freshUntil).toBe(at('2026-10-16T18:05'));
        expect(await windowRun(harness, FRIDAY, 13)).toMatchObject({
            syncResult: 'skipped',
            syncDetail: 'window_stopped',
        });
    });

    it('runs every minute to 17:30 on a day no table comes, one request each, and records 18:05 after the last', async () => {
        // Wednesday 2026-10-14 is a public holiday: NBG publishes no table valid from 2026-10-15.
        const harness = await setUpRuns({ nbg: WEEK.filter((subject) => subject.validFrom <= WEDNESDAY) });
        expect(await harness.run(`${WEDNESDAY}T16:00`)).toMatchObject({
            syncResult: 'ok',
            checked: true,
            span: '2026-10-09..2026-10-15',
        });
        const evening = harness.mark();
        for (let minute = 0; minute <= 30; minute += 1) {
            expect(await windowRun(harness, WEDNESDAY, minute)).toMatchObject({
                syncResult: 'ok',
                syncDetail: null,
                checked: true,
                committed: 0,
                nbgRequests: 1,
            });
            expect((await harness.state()).window).toMatchObject({ committed: false, quietRuns: 0, stopped: false });
        }
        expect(harness.since(evening).requests).toEqual(Array.from({ length: 31 }, () => 'day:en:2026-10-15'));
        const state = await harness.state();
        expect(state.window).toMatchObject({ stopped: false, at: at('2026-10-14T17:30') });
        expect(state.freshUntil).toBe(at('2026-10-14T18:05'));
        expect(state.unresolved).toEqual([]);
        expect(await held(harness.store, '2026-10-15')).toBeUndefined();
    });

    it('counts no failed run: ten failures after the commit neither stop the window nor reset its count', async () => {
        const harness = await friday();
        harness.fake.publish(SATURDAY);
        expect(await windowRun(harness, FRIDAY, 1)).toMatchObject({ syncResult: 'ok', committed: 1 });
        const committed = await harness.state();

        harness.fake.failWith(UNAVAILABLE);
        for (let minute = 2; minute <= 11; minute += 1) {
            const failing = harness.mark();
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({
                syncResult: 'failed',
                syncDetail: 'upstream_unavailable',
                checked: false,
                nbgRequests: 1,
            });
            // The claim alone: a failed run writes no window state and no fresh-until.
            expect(harness.since(failing).writes).toEqual([{ operation: 'state', key: 'state/state' }]);
        }
        const failed = await harness.state();
        expect(failed.window).toEqual(committed.window);
        expect(failed.freshUntil).toBe(at('2026-10-16T17:04'));

        harness.fake.failWith(undefined);
        for (let minute = 12; minute <= 20; minute += 1) {
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({ syncResult: 'ok', nbgRequests: 1 });
        }
        expect((await harness.state()).window).toMatchObject({ quietRuns: 9, stopped: false });
        expect(await windowRun(harness, FRIDAY, 21)).toMatchObject({ syncResult: 'ok', nbgRequests: 1 });
        expect((await harness.state()).window).toMatchObject({
            quietRuns: 10,
            stopped: true,
            at: at('2026-10-16T17:21'),
        });
    });

    it('skips a window event outside 17:00 to 17:30 on a weekday as outside_window, with no store call', async () => {
        const harness = await friday();
        const saturday = harness.mark();
        expect(await harness.run('2026-10-17T17:05', { kind: 'window' })).toEqual(
            line({
                time: '2026-10-17T13:05:02.000Z',
                syncRun: 'window',
                scheduledTime: '2026-10-17T13:05:00.000Z',
                syncResult: 'skipped',
                syncDetail: 'outside_window',
            }),
        );
        expect(harness.since(saturday)).toEqual({ requests: [], writes: [], sleeps: [], operations: [] });
        for (const scheduled of ['2026-10-16T16:59', '2026-10-16T17:31']) {
            const weekday = harness.mark();
            expect(await harness.run(scheduled, { kind: 'window' })).toMatchObject({
                syncResult: 'skipped',
                syncDetail: 'outside_window',
            });
            expect(harness.since(weekday)).toEqual({ requests: [], writes: [], sleeps: [], operations: [] });
        }
    });

    it("commits nothing and marks nothing unresolved while NBG answers tomorrow's request with today's table", async () => {
        const harness = await friday();
        const mark = harness.mark();
        expect(await windowRun(harness, FRIDAY, 0)).toMatchObject({
            syncResult: 'ok',
            checked: true,
            committed: 0,
            nbgRequests: 1,
        });
        // NBG's JSON answers the table valid from 2026-10-16 for 2026-10-17: never stored as 2026-10-17's.
        expect(harness.since(mark).requests).toEqual([TOMORROW_EN]);
        expect(harness.since(mark).writes.map((write) => write.operation)).toEqual(['state', 'state']);
        expect(await held(harness.store, '2026-10-17')).toBeUndefined();
        expect((await harness.state()).unresolved).toEqual([]);
    });

    it('keeps one copy of a table the 17:00 hourly and window runs both see, which a held 16:00 run changes neither', async () => {
        const harness = await setUpRuns({ nbg: WEEK });
        expect(await harness.run(`${FRIDAY}T15:00`)).toMatchObject({ syncResult: 'ok', checked: true });
        await skipDailySteps(harness, FRIDAY);
        // NBG as it answered the 16:00 run, before the 17:00 publication; that run waits until released.
        const asAt16 = createFakeNbg(WEEK);
        const release = asAt16.hold();
        const slow = harness.run(`${FRIDAY}T16:00`, { client: asAt16.client });
        await vi.waitFor(() => {
            expect(asAt16.requests).toHaveLength(1);
        });

        harness.fake.publish(SATURDAY);
        const together = harness.mark();
        const [hourly, window] = await Promise.all([
            harness.run(`${FRIDAY}T17:00`),
            harness.run(`${FRIDAY}T17:00`, { kind: 'window' }),
        ]);
        expect(hourly).toMatchObject({ syncResult: 'ok', checked: true });
        expect(window).toMatchObject({ syncResult: 'ok', checked: true });
        expect(hourly.committed + window.committed).toBe(1);
        expect(harness.since(together).writes.filter((write) => write.operation === 'commit')).toEqual([
            { operation: 'commit', key: 'rows/2026-10-17' },
        ]);
        const copy = expectedHeld(SATURDAY, at('2026-10-16T17:00:02'));
        expect(await held(harness.store, '2026-10-17')).toEqual(copy);
        const settled = await harness.state();
        expect(settled.freshUntil).toBe(at('2026-10-16T17:03'));
        expect(settled.unresolved).toEqual([]);
        expect(settled.window).toMatchObject({ date: FRIDAY, committed: true, stopped: false });

        // Released, the 16:00 run reads 2026-10-17 as gone from NBG and tries to remove it at its older observation.
        const released = harness.mark();
        release();
        expect(await slow).toMatchObject({ syncResult: 'ok', committed: 0 });
        expect(asAt16.requests).toEqual([`range:${CODES.join(',')}:2026-10-09:2026-10-17`, TOMORROW_EN, TOMORROW_KA]);
        expect(harness.since(released).operations).toContain('remove');
        expect(harness.since(released).writes).toEqual([]);
        expect(await held(harness.store, '2026-10-17')).toEqual(copy);
        expect(await harness.state()).toEqual(settled);
    });

    it('counts a quiet run an older window run records while a newer one runs, and an older run finishing last changes nothing', async () => {
        const harness = await friday();
        harness.fake.publish(SATURDAY);
        for (let minute = 1; minute <= 4; minute += 1) {
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({ syncResult: 'ok' });
        }
        expect((await harness.state()).window).toMatchObject({ quietRuns: 3, at: at('2026-10-16T17:04') });

        /** A window run that has claimed the state and waits at its first request until released. */
        async function heldRun(
            minute: number,
        ): Promise<{ readonly release: () => void; readonly run: Promise<SyncLogLine> }> {
            const nbg = createFakeNbg([...WEEK, SATURDAY]);
            const release = nbg.hold();
            const run = windowRun(harness, FRIDAY, minute, { client: nbg.client });
            await vi.waitFor(() => {
                expect(nbg.requests).toEqual([TOMORROW_EN]);
            });
            return { release, run };
        }

        // 17:05 and 17:06 have both claimed; 17:05 writes first, and 17:06 counts on from it.
        const at1705 = await heldRun(5);
        const at1706 = await heldRun(6);
        at1705.release();
        expect(await at1705.run).toMatchObject({ syncResult: 'ok', checked: true });
        at1706.release();
        expect(await at1706.run).toMatchObject({ syncResult: 'ok', checked: true });
        const counted = await harness.state();
        expect(counted.window).toMatchObject({ quietRuns: 5, stopped: false, at: at('2026-10-16T17:06') });
        expect(counted.freshUntil).toBe(at('2026-10-16T17:09'));

        // 17:07 and 17:08 have both claimed; 17:08 writes first, and 17:07, finishing last, changes nothing.
        const at1707 = await heldRun(7);
        const at1708 = await heldRun(8);
        at1708.release();
        expect(await at1708.run).toMatchObject({ syncResult: 'ok', checked: true });
        const newer = await harness.state();
        expect(newer.window).toMatchObject({ quietRuns: 6, at: at('2026-10-16T17:08') });
        const late = harness.mark();
        at1707.release();
        expect(await at1707.run).toMatchObject({ syncResult: 'ok', checked: true });
        expect(harness.since(late).writes).toEqual([]);
        expect(await harness.state()).toEqual(newer);
    });

    it('starts the quiet count again after a change an older run committed but has not yet counted', async () => {
        const harness = await friday();
        harness.fake.publish(SATURDAY);
        for (let minute = 1; minute <= 10; minute += 1) {
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({ syncResult: 'ok' });
        }
        expect((await harness.state()).window).toMatchObject({ quietRuns: 9, stopped: false });

        // NBG's second write changes USD; 2026-09-28, still unresolved, keeps the 17:11 run busy after its commit.
        const changed = publication(withRates(SATURDAY.en, { USD: 2.7155 }));
        harness.fake.publish(changed);
        const old = publication(tableFrom('2026-09-28', 2.6912));
        harness.fake.publish(old);
        const marked = await harness.store.updateState(
            (state) => ({ next: markUnresolved(state, [date('2026-09-28')]), outcome: undefined }),
            SIGNAL,
        );
        expect(marked.ok).toBe(true);
        const oldAtNbg = createFakeNbg([old]);
        const release = oldAtNbg.hold();
        const client: NbgClient = {
            fetchDay: (day, language) =>
                (day === '2026-09-28' ? oldAtNbg : harness.fake).client.fetchDay(day, language),
            fetchRange: (codes, start, end) =>
                (start === '2026-09-28' ? oldAtNbg : harness.fake).client.fetchRange(codes, start, end),
        };
        const slow = windowRun(harness, FRIDAY, 11, { client });
        await vi.waitFor(() => {
            expect(oldAtNbg.requests).toEqual(['day:en:2026-09-28']);
        });
        expect(await held(harness.store, '2026-10-17')).toEqual(expectedHeld(changed, at('2026-10-16T17:11:02')));

        // The 17:12 run finds the new table stored and equal to NBG's: one quiet run since the change, not ten.
        expect(await windowRun(harness, FRIDAY, 12)).toMatchObject({ syncResult: 'ok', checked: true });
        const afterChange = await harness.state();
        expect(afterChange.window).toMatchObject({ quietRuns: 1, stopped: false, at: at('2026-10-16T17:12') });
        expect(afterChange.freshUntil).toBe(at('2026-10-16T17:15'));
        release();
        // Its 2026-10-17 commit alone: the 17:12 run already stored 2026-09-28, so the released retry finds it unchanged.
        expect(await slow).toMatchObject({ syncResult: 'ok', committed: 1 });
        expect((await harness.state()).window).toEqual(afterChange.window);

        for (let minute = 13; minute <= 20; minute += 1) {
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({ syncResult: 'ok', nbgRequests: 1 });
        }
        expect((await harness.state()).window).toMatchObject({ quietRuns: 9, stopped: false });
        expect(await windowRun(harness, FRIDAY, 21)).toMatchObject({ syncResult: 'ok', nbgRequests: 1 });
        expect((await harness.state()).window).toMatchObject({ quietRuns: 10, stopped: true });
    });

    it('does not count on from a commit whose English request straddles the next due minute', async () => {
        const harness = await friday();
        harness.fake.publish(SATURDAY);
        for (let minute = 1; minute <= 9; minute += 1) {
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({ syncResult: 'ok' });
        }
        expect((await harness.state()).window).toMatchObject({ quietRuns: 8, stopped: false });

        // The 17:10 event arrives 59.5 s late, within MAX_EVENT_AGE_MS. Its English request for tomorrow is still in
        // flight when the 17:11 run asks NBG, and NBG's second write lands while it is.
        const changed = publication(withRates(SATURDAY.en, { USD: 2.7155 }));
        const englishAtNbg = createFakeNbg([SATURDAY]);
        const release = englishAtNbg.hold();
        const client: NbgClient = {
            fetchDay: (day, language) =>
                (day === '2026-10-17' && language === 'en' ? englishAtNbg : harness.fake).client.fetchDay(
                    day,
                    language,
                ),
            fetchRange: (codes, start, end) => harness.fake.client.fetchRange(codes, start, end),
        };
        const lateObservedAt = at('2026-10-16T17:10') + 59_500;
        const late = windowRun(harness, FRIDAY, 10, { client, now: new Date(lateObservedAt) });
        await vi.waitFor(() => {
            expect(englishAtNbg.requests).toEqual([TOMORROW_EN]);
        });

        // 17:11: NBG still answers the first write, which the mirror holds: quiet, count 9.
        expect(await windowRun(harness, FRIDAY, 11)).toMatchObject({ syncResult: 'ok', checked: true });
        expect((await harness.state()).window).toMatchObject({
            quietRuns: 9,
            stopped: false,
            at: at('2026-10-16T17:11'),
        });

        // The in-flight request answers NBG's second write, and the 17:10 run commits it, observed before 17:11.
        englishAtNbg.publish(changed);
        harness.fake.publish(changed);
        release();
        expect(await late).toMatchObject({ syncResult: 'ok', committed: 1, nbgRequests: 3 });
        expect(await held(harness.store, '2026-10-17')).toEqual(expectedHeld(changed, lateObservedAt));
        expect(lateObservedAt).toBeLessThan(at('2026-10-16T17:11'));

        // 17:12 is the first quiet run since the change.
        expect(await windowRun(harness, FRIDAY, 12)).toMatchObject({ syncResult: 'ok', checked: true });
        const afterChange = await harness.state();
        expect(afterChange.window).toMatchObject({ quietRuns: 1, stopped: false, at: at('2026-10-16T17:12') });
        expect(afterChange.freshUntil).toBe(at('2026-10-16T17:15'));

        for (let minute = 13; minute <= 20; minute += 1) {
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({ syncResult: 'ok', nbgRequests: 1 });
        }
        expect((await harness.state()).window).toMatchObject({ quietRuns: 9, stopped: false });
        expect(await windowRun(harness, FRIDAY, 21)).toMatchObject({ syncResult: 'ok', nbgRequests: 1 });
        expect((await harness.state()).window).toMatchObject({ quietRuns: 10, stopped: true });
    });

    it('asks every source again while tomorrow is unresolved, even when its English table is the stored one', async () => {
        const harness = await friday();
        harness.fake.publish(SATURDAY);
        expect(await windowRun(harness, FRIDAY, 1)).toMatchObject({ syncResult: 'ok', committed: 1 });
        expect(await windowRun(harness, FRIDAY, 2)).toMatchObject({ syncResult: 'ok', nbgRequests: 1 });
        // Another run saw tomorrow's sources disagree and marked it.
        const marked = await harness.store.updateState(
            (state) => ({ next: markUnresolved(state, [date('2026-10-17')]), outcome: undefined }),
            SIGNAL,
        );
        expect(marked.ok).toBe(true);
        const mark = harness.mark();
        expect(await windowRun(harness, FRIDAY, 3)).toMatchObject({ syncResult: 'ok', committed: 0, nbgRequests: 3 });
        expect(harness.since(mark).requests).toEqual([TOMORROW_EN, TOMORROW_KA, TOMORROW_CSV]);
        const state = await harness.state();
        expect(state.unresolved).toEqual([]);
        expect(state.window).toMatchObject({ committed: true, quietRuns: 0, at: at('2026-10-16T17:03') });
    });

    it('leaves the mirror fresh until 17:02 when only the 16:00 check succeeded, stale at 17:03 and still at 17:31', async () => {
        const harness = await friday();
        harness.fake.failWith(UNAVAILABLE);
        for (let minute = 0; minute <= 30; minute += 1) {
            expect(await windowRun(harness, FRIDAY, minute)).toMatchObject({ syncResult: 'failed', checked: false });
        }
        expect((await harness.state()).freshUntil).toBe(at('2026-10-16T17:02'));
        const ask = { date: date(FRIDAY), language: 'en' as const };
        const expected: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
            ['2026-10-16T16:59', []],
            ['2026-10-16T17:03', ['shortLive.getSnapshot']],
            ['2026-10-16T17:31', ['shortLive.getSnapshot']],
        ];
        for (const [wallClock, asks] of expected) {
            const { service, asked } = mirroredService(harness, tbilisi(wallClock));
            expect((await service.getSnapshot(ask)).ok).toBe(true);
            expect(asked).toEqual(asks);
        }
    });

    it('keeps tomorrow unresolved while its CSV lags both JSON views, and commits it once the CSV lists it', async () => {
        const harness = await friday();
        harness.fake.publishJson(SATURDAY);
        const lagging = harness.mark();
        expect(await windowRun(harness, FRIDAY, 1)).toEqual(
            line({
                time: '2026-10-16T13:01:02.000Z',
                syncRun: 'window',
                scheduledTime: '2026-10-16T13:01:00.000Z',
                checked: true,
                nbgRequests: 3,
                span: '2026-10-09..2026-10-17',
            }),
        );
        expect(harness.since(lagging).requests).toEqual([TOMORROW_EN, TOMORROW_KA, TOMORROW_CSV]);
        expect(await held(harness.store, '2026-10-17')).toBeUndefined();
        const behind = await harness.state();
        expect(behind.unresolved).toEqual(['2026-10-17']);
        expect(behind.window).toMatchObject({ committed: false, quietRuns: 0 });
        expect(behind.freshUntil).toBe(at('2026-10-16T17:04'));

        harness.fake.publishCsv(SATURDAY);
        const listed = harness.mark();
        expect(await windowRun(harness, FRIDAY, 2)).toMatchObject({ syncResult: 'ok', committed: 1, nbgRequests: 3 });
        expect(harness.since(listed).requests).toEqual([TOMORROW_EN, TOMORROW_KA, TOMORROW_CSV]);
        expect(await held(harness.store, '2026-10-17')).toEqual(expectedHeld(SATURDAY, at('2026-10-16T17:02:02')));
        expect((await harness.state()).unresolved).toEqual([]);
    });

    it('skips a stopped window only on its own Tbilisi date', async () => {
        const harness = await setUpRuns({
            nbg: WEEK,
            seed: {
                state: {
                    window: {
                        date: date(FRIDAY),
                        committed: true,
                        quietRuns: 10,
                        stopped: true,
                        at: at('2026-10-16T17:11'),
                    },
                },
            },
        });
        expect(await windowRun(harness, FRIDAY, 20)).toMatchObject({
            syncResult: 'skipped',
            syncDetail: 'window_stopped',
        });
        const monday = harness.mark();
        expect(await windowRun(harness, '2026-10-19', 0)).toMatchObject({
            syncResult: 'ok',
            checked: false,
            nbgRequests: 1,
        });
        expect(harness.since(monday).requests).toEqual(['day:en:2026-10-20']);
        const state = await harness.state();
        expect(state.window).toEqual({
            date: '2026-10-19',
            committed: false,
            quietRuns: 0,
            stopped: false,
            at: at('2026-10-19T17:00'),
        });
        // Without a span the run checks nothing, so it records no fresh-until.
        expect(state.freshUntil).toBeUndefined();
    });
});

describe('runWindowCheck: unresolved dates and the deadline', () => {
    /** Friday's mirror with 2026-09-28 marked unresolved and NBG holding a table for it. */
    async function withOldUnresolved(): Promise<Harness> {
        const harness = await friday();
        harness.fake.publish(publication(tableFrom('2026-09-28', 2.6912)));
        const marked = await harness.store.updateState(
            (state) => ({ next: markUnresolved(state, [date('2026-09-28')]), outcome: undefined }),
            SIGNAL,
        );
        expect(marked.ok).toBe(true);
        return harness;
    }

    it("retries an unresolved date other than tomorrow after tomorrow's step, then records the window", async () => {
        const harness = await withOldUnresolved();
        const mark = harness.mark();
        expect(await windowRun(harness, FRIDAY, 0)).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            checked: true,
            committed: 1,
            nbgRequests: 4,
        });
        expect(harness.since(mark).requests).toEqual([
            TOMORROW_EN,
            'day:en:2026-09-28',
            'day:ka:2026-09-28',
            `range:${CODES.join(',')}:2026-09-28:2026-09-28`,
        ]);
        const state = await harness.state();
        expect(state.unresolved).toEqual([]);
        expect(state.window).toMatchObject({ quietRuns: 0, at: at('2026-10-16T17:00') });
        expect(state.freshUntil).toBe(at('2026-10-16T17:03'));
    });

    it('fails the run on a failed retry, writing no window state and no fresh-until', async () => {
        const harness = await withOldUnresolved();
        const client: NbgClient = {
            fetchDay: (day, language) =>
                day === '2026-09-28' ? Promise.resolve(err(UNAVAILABLE)) : harness.fake.client.fetchDay(day, language),
            fetchRange: (codes, start, end) => harness.fake.client.fetchRange(codes, start, end),
        };
        const before = await harness.state();
        const mark = harness.mark();
        expect(await windowRun(harness, FRIDAY, 0, { client })).toMatchObject({
            syncResult: 'failed',
            syncDetail: 'upstream_unavailable',
            checked: false,
            nbgRequests: 2,
        });
        expect(harness.since(mark).writes).toEqual([{ operation: 'state', key: 'state/state' }]);
        const after = await harness.state();
        expect(after.window).toBeUndefined();
        expect(after.freshUntil).toBe(before.freshUntil);
        expect(after.unresolved).toEqual(['2026-09-28']);
    });

    it("writes neither window state nor fresh-until when the deadline comes during tomorrow's step", async () => {
        const harness = await friday();
        expect(await windowRun(harness, FRIDAY, 0)).toMatchObject({ syncResult: 'ok', checked: true });
        const before = await harness.state();
        harness.fake.publish(SATURDAY);
        const sent = harness.mark().requests;
        const mark = harness.mark();
        // After tomorrow's English table, too little time is left to ask for the Georgian one.
        expect(
            await windowRun(harness, FRIDAY, 1, {
                remainingMs: () => (harness.fake.requests.length > sent ? 5_000 : 25_000),
            }),
        ).toMatchObject({ syncResult: 'ok', syncDetail: 'deadline', checked: false, committed: 0, nbgRequests: 1 });
        expect(harness.since(mark).writes).toEqual([{ operation: 'state', key: 'state/state' }]);
        const after = await harness.state();
        expect(after.window).toEqual(before.window);
        expect(after.freshUntil).toBe(before.freshUntil);
    });

    it('still records the window and fresh-until when the deadline comes during the retries', async () => {
        const harness = await withOldUnresolved();
        const sent = harness.mark().requests;
        // Tomorrow's English table leaves time for state writes but not for another request.
        expect(
            await windowRun(harness, FRIDAY, 0, {
                remainingMs: () => (harness.fake.requests.length > sent ? 5_000 : 25_000),
            }),
        ).toMatchObject({ syncResult: 'ok', syncDetail: 'deadline', checked: true, nbgRequests: 1 });
        const state = await harness.state();
        expect(state.window).toEqual({
            date: FRIDAY,
            committed: false,
            quietRuns: 0,
            stopped: false,
            at: at('2026-10-16T17:00'),
        });
        expect(state.freshUntil).toBe(at('2026-10-16T17:03'));
        expect(state.unresolved).toEqual(['2026-09-28']);
    });
});
