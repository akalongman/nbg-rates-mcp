import { describe, expect, it, vi } from 'vitest';
import { publication, syntheticTable, tableFixture } from '../../test/helpers/publications.js';
import {
    at,
    bootstrapped,
    CODES,
    expectedHeld,
    held,
    line,
    mirroredService,
    OCTOBER,
    setUp,
    SIGNAL,
    skipArchiveFill,
    skipDailySteps,
    tableFrom,
    tbilisi,
    UNAVAILABLE,
    withoutCode,
    withRates,
    type Harness,
} from '../../test/helpers/sync-harness.js';
import { date } from '../../test/helpers/values.js';
import { addDays } from '../core/dates.js';
import { markUnresolved, recordFreshUntil } from '../core/mirror.js';
import type { MirrorPublication } from '../core/mirror-publication.js';
import { err } from '../core/types.js';
import { createSnapshotCache } from './cache.js';
import type { NbgClient } from './nbg-client.js';
import { createRatesService } from './rates-service.js';
import { notConfiguredLine } from './sync.js';

describe('runSync: which events run', () => {
    it('skips an event 61 seconds old as late, with no store call, request or write', async () => {
        const harness = await setUp();
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T10:00', { now: tbilisi('2026-10-08T10:01:01') });
        expect(result).toEqual(
            line({
                time: '2026-10-08T06:01:01.000Z',
                scheduledTime: '2026-10-08T06:00:00.000Z',
                syncResult: 'skipped',
                syncDetail: 'late',
                durationMs: 0,
            }),
        );
        expect(harness.since(mark)).toEqual({ requests: [], writes: [], sleeps: [], operations: [] });
        expect(harness.lines).toEqual([result]);
    });

    it('runs an event exactly 60 seconds old', async () => {
        const harness = await setUp();
        const result = await harness.run('2026-10-08T10:00', { now: tbilisi('2026-10-08T10:01') });
        expect(result.syncResult).toBe('ok');
    });

    it('skips an event 61 seconds in the future as early, with no store call, request or write', async () => {
        const harness = await setUp();
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T12:00', { now: tbilisi('2026-10-08T11:58:59') });
        expect(result).toEqual(
            line({
                time: '2026-10-08T07:58:59.000Z',
                scheduledTime: '2026-10-08T08:00:00.000Z',
                syncResult: 'skipped',
                syncDetail: 'early',
            }),
        );
        expect(harness.since(mark)).toEqual({ requests: [], writes: [], sleeps: [], operations: [] });
        expect((await harness.state()).lastRun).toEqual({});
    });

    it('runs an event exactly 60 seconds early', async () => {
        const harness = await setUp();
        const result = await harness.run('2026-10-08T10:00', { now: tbilisi('2026-10-08T09:59') });
        expect(result.syncResult).toBe('ok');
    });

    it('skips an event whose scheduled time is not a valid date as late, before any store call', async () => {
        const harness = await setUp();
        const mark = harness.mark();
        const result = await harness.run(new Date(Number.NaN), { now: tbilisi('2026-10-08T10:00:02') });
        expect(result).toEqual(
            line({
                time: '2026-10-08T06:00:02.000Z',
                scheduledTime: 'Invalid Date',
                syncResult: 'skipped',
                syncDetail: 'late',
            }),
        );
        expect(harness.since(mark)).toEqual({ requests: [], writes: [], sleeps: [], operations: [] });
        expect((await harness.state()).lastRun).toEqual({});
    });

    it('skips the same scheduled time the second time as a duplicate, with no request', async () => {
        const harness = await bootstrapped();
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T10:00');
        expect(result).toEqual(
            line({
                time: '2026-10-08T06:00:02.000Z',
                scheduledTime: '2026-10-08T06:00:00.000Z',
                syncResult: 'skipped',
                syncDetail: 'duplicate',
                span: '2026-10-01..2026-10-09',
            }),
        );
        expect(harness.since(mark).requests).toEqual([]);
        expect(harness.since(mark).writes).toEqual([]);
    });

    it('fails a run whose state cannot be read, with no request', async () => {
        const harness = await setUp();
        harness.store.failWith('throttled');
        const result = await harness.run('2026-10-08T10:00');
        expect(result.syncResult).toBe('failed');
        expect(result.syncDetail).toBe('store_failed');
        expect(harness.fake.requests).toEqual([]);
    });
});

describe('runSync: the hourly check', () => {
    it('bootstraps the span over the last 7 days and tomorrow, committing every publication in it', async () => {
        const harness = await setUp();
        const result = await harness.run('2026-10-08T10:00');
        expect(result).toEqual(
            line({
                time: '2026-10-08T06:00:02.000Z',
                scheduledTime: '2026-10-08T06:00:00.000Z',
                checked: true,
                committed: 5,
                nbgRequests: 12,
                span: '2026-10-01..2026-10-09',
            }),
        );
        expect(harness.lines).toEqual([result]);
        const state = await harness.state();
        expect(state.span).toEqual({ start: '2026-10-01', end: '2026-10-09' });
        expect(state.freshUntil).toBe(at('2026-10-08T11:05'));
        expect(state.unresolved).toEqual([]);
        expect(state.lastRun).toEqual({ hourly: at('2026-10-08T10:00') });
        for (const subject of OCTOBER) {
            expect(await held(harness.store, subject.validFrom)).toEqual(
                expectedHeld(subject, at('2026-10-08T10:00:02')),
            );
        }
        expect(harness.fake.requests).toEqual([
            'day:en:2026-10-08',
            `range:${CODES}:2026-10-01:2026-10-09`,
            ...OCTOBER.flatMap((subject) => [`day:en:${subject.validFrom}`, `day:ka:${subject.validFrom}`]),
        ]);
        expect(harness.since({ requests: 0, writes: 0, sleeps: 0, operations: 0 }).sleeps).toEqual(
            Array.from({ length: 11 }, () => 500),
        );
    });

    it('asks one CSV and commits nothing at 11:00 when nothing changed, moving fresh-until to 12:05', async () => {
        const harness = await bootstrapped();
        await skipDailySteps(harness, '2026-10-08');
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T11:00');
        expect(result).toEqual(
            line({
                time: '2026-10-08T07:00:02.000Z',
                scheduledTime: '2026-10-08T07:00:00.000Z',
                checked: true,
                nbgRequests: 1,
                span: '2026-10-01..2026-10-09',
                rowsStart: '1995-10-14',
            }),
        );
        expect(harness.since(mark).requests).toEqual([`range:${CODES}:2026-10-01:2026-10-09`]);
        expect(harness.since(mark).writes).toEqual([
            { operation: 'state', key: 'state/state' },
            { operation: 'state', key: 'state/state' },
        ]);
        expect((await harness.state()).freshUntil).toBe(at('2026-10-08T12:05'));
    });

    it('commits a USD change to 2026-10-06 in both views with the newer observation', async () => {
        const harness = await bootstrapped();
        await skipDailySteps(harness, '2026-10-08');
        const changed = publication(withRates(tableFixture('en', '2026-10-06'), { USD: 2.6111 }));
        harness.fake.publish(changed);
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T11:00');
        expect(result.committed).toBe(1);
        expect(result.checked).toBe(true);
        expect(harness.since(mark).requests).toEqual([
            `range:${CODES}:2026-10-01:2026-10-09`,
            'day:en:2026-10-06',
            'day:ka:2026-10-06',
        ]);
        expect(harness.since(mark).sleeps).toEqual([500, 500]);
        expect(await held(harness.store, '2026-10-06')).toEqual(expectedHeld(changed, at('2026-10-08T11:00:02')));
    });

    it('drops AMD from the mirror for 2026-10-06 when NBG withdraws it from both views', async () => {
        const harness = await bootstrapped();
        await skipDailySteps(harness, '2026-10-08');
        const withdrawn = publication(withoutCode(tableFixture('en', '2026-10-06'), 'AMD'));
        harness.fake.publish(withdrawn);
        expect(await harness.run('2026-10-08T11:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            checked: true,
            committed: 1,
        });
        const stored = await held(harness.store, '2026-10-06');
        expect(stored).toEqual(expectedHeld(withdrawn, at('2026-10-08T11:00:02')));
        expect(stored?.en.currencies.map((row) => row.code)).not.toContain('AMD');
        expect(stored?.ka.currencies.map((row) => row.code)).not.toContain('AMD');
        expect(stored?.rows.map((row) => row.code)).not.toContain('AMD');
    });

    it('removes a publication NBG withdraws from both views', async () => {
        const harness = await bootstrapped();
        await skipDailySteps(harness, '2026-10-08');
        harness.fake.withdraw(date('2026-10-06'));
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T11:00');
        expect(result).toMatchObject({ syncResult: 'ok', checked: true, committed: 1 });
        expect(harness.since(mark).requests).toEqual([
            `range:${CODES}:2026-10-01:2026-10-09`,
            'day:en:2026-10-06',
            'day:ka:2026-10-06',
        ]);
        expect(harness.since(mark).writes).toContainEqual({ operation: 'remove', key: 'rows/2026-10-06' });
        expect(await held(harness.store, '2026-10-06')).toBeUndefined();
    });

    it('leaves a date the CSV shows before the JSON unresolved, still checked, and commits it once the JSON has it', async () => {
        const harness = await bootstrapped();
        await skipDailySteps(harness, '2026-10-08');
        // NBG's CSV lists the table valid from 2026-10-09 at 17:00:30; its JSON still answers 2026-10-07's table.
        const tomorrow = publication(tableFrom('2026-10-09', 2.6013));
        harness.fake.publishCsv(tomorrow);
        const evening = harness.mark();
        const first = await harness.run('2026-10-08T18:00');
        expect(first).toMatchObject({ syncResult: 'ok', checked: true, committed: 0 });
        expect(harness.since(evening).requests).toEqual([
            `range:${CODES}:2026-10-01:2026-10-09`,
            'day:en:2026-10-09',
            'day:ka:2026-10-09',
        ]);
        expect(await held(harness.store, '2026-10-09')).toBeUndefined();
        const afterFirst = await harness.state();
        expect(afterFirst.unresolved).toEqual(['2026-10-09']);
        expect(afterFirst.freshUntil).toBe(at('2026-10-08T19:05'));

        // The unresolved date inside the span takes the live path, so its answer is NBG's own.
        const now = tbilisi('2026-10-08T18:00:30');
        const { service, asked } = mirroredService(harness, now);
        const reference = createRatesService({
            client: harness.fake.client,
            cache: createSnapshotCache(),
            now: () => now,
        });
        const ask = { date: date('2026-10-09'), language: 'en' as const };
        expect(await service.getSnapshot(ask)).toEqual(await reference.getSnapshot(ask));
        expect(asked).toEqual(['live.getSnapshot']);

        harness.fake.publishJson(tomorrow);
        const result = await harness.run('2026-10-08T19:00');
        expect(result).toMatchObject({ syncResult: 'ok', checked: true, committed: 1 });
        expect(await held(harness.store, '2026-10-09')).toEqual(expectedHeld(tomorrow, at('2026-10-08T19:00:02')));
        expect((await harness.state()).unresolved).toEqual([]);
    });

    it('starts no span while a date in the bootstrap window is unresolved, and starts it once all agree', async () => {
        const harness = await setUp();
        const tomorrow = publication(tableFrom('2026-10-09', 2.6013));
        harness.fake.publishCsv(tomorrow);
        const first = await harness.run('2026-10-08T18:00');
        expect(first).toMatchObject({ syncResult: 'ok', syncDetail: null, checked: false, committed: 5, span: null });
        const unstarted = await harness.state();
        expect(unstarted.span).toBeUndefined();
        expect(unstarted.freshUntil).toBeUndefined();
        expect(unstarted.unresolved).toEqual(['2026-10-09']);

        harness.fake.publishJson(tomorrow);
        const next = await harness.run('2026-10-08T19:00');
        expect(next).toMatchObject({ checked: true, committed: 1, span: '2026-10-01..2026-10-09' });
        const started = await harness.state();
        expect(started.unresolved).toEqual([]);
        expect(started.freshUntil).toBe(at('2026-10-08T20:05'));
    });

    it('fetches a date marked unresolved again even when the CSV matches the mirror', async () => {
        const harness = await bootstrapped();
        await skipDailySteps(harness, '2026-10-08');
        const marked = await harness.store.updateState(
            (state) => ({ next: markUnresolved(state, [date('2026-10-06')]), outcome: undefined }),
            SIGNAL,
        );
        expect(marked.ok).toBe(true);
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T11:00');
        expect(result).toMatchObject({ syncResult: 'ok', checked: true, committed: 0 });
        expect(harness.since(mark).requests).toEqual([
            `range:${CODES}:2026-10-01:2026-10-09`,
            'day:en:2026-10-06',
            'day:ka:2026-10-06',
        ]);
        expect((await harness.state()).unresolved).toEqual([]);
    });

    it('does not read a code that left the latest table as a change to the publications before it', async () => {
        const harness = await bootstrapped();
        await skipArchiveFill(harness);
        harness.fake.publish(publication(withoutCode(tableFixture('en', '2026-10-07'), 'AMD')));
        expect(await harness.run('2026-10-08T11:00')).toMatchObject({ committed: 1 });
        const withoutAmd = CODES.split(',')
            .filter((candidate) => candidate !== 'AMD')
            .join(',');
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T12:00');
        expect(result).toMatchObject({ syncResult: 'ok', checked: true, committed: 0 });
        expect(harness.since(mark).requests).toEqual([`range:${withoutAmd}:2026-10-01:2026-10-09`]);
    });

    it("asks the CSV for the codes of NBG's table for today when no table is stored at the chunk's end", async () => {
        const harness = await setUp({
            seed: { state: { span: { start: date('2026-10-01'), end: date('2026-10-09') } } },
        });
        await skipArchiveFill(harness);
        const result = await harness.run('2026-10-08T11:00');
        expect(result).toMatchObject({ syncResult: 'ok', checked: true, committed: 5 });
        expect(harness.fake.requests.slice(0, 2)).toEqual([
            'day:en:2026-10-08',
            `range:${CODES}:2026-10-01:2026-10-09`,
        ]);
    });

    it('fails on an export with no rows, writing nothing but the claim and leaving fresh-until', async () => {
        const harness = await bootstrapped();
        for (const subject of OCTOBER) {
            harness.fake.withdraw(subject.validFrom);
        }
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T11:00');
        expect(result).toEqual(
            line({
                time: '2026-10-08T07:00:02.000Z',
                scheduledTime: '2026-10-08T07:00:00.000Z',
                syncResult: 'failed',
                syncDetail: 'empty_export',
                nbgRequests: 1,
                span: '2026-10-01..2026-10-09',
            }),
        );
        expect(harness.since(mark).writes).toEqual([{ operation: 'state', key: 'state/state' }]);
        expect((await harness.state()).freshUntil).toBe(at('2026-10-08T11:05'));
    });

    it('fails with the NBG failure kind when NBG fails, leaving fresh-until', async () => {
        const harness = await bootstrapped();
        harness.fake.failWith(UNAVAILABLE);
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T11:00');
        expect(result).toMatchObject({
            syncResult: 'failed',
            syncDetail: 'upstream_unavailable',
            checked: false,
            nbgRequests: 1,
        });
        expect(harness.since(mark).writes).toEqual([{ operation: 'state', key: 'state/state' }]);
        expect((await harness.state()).freshUntil).toBe(at('2026-10-08T11:05'));
    });

    it('fails a bootstrap whose first table fails, with no span', async () => {
        const harness = await setUp();
        harness.fake.failWith({ kind: 'upstream_shape_changed', detail: 'rates is not a number' });
        const result = await harness.run('2026-10-08T10:00');
        expect(result).toMatchObject({ syncResult: 'failed', syncDetail: 'upstream_shape_changed', span: null });
        expect(harness.fake.requests).toEqual(['day:en:2026-10-08']);
        expect((await harness.state()).span).toBeUndefined();
    });

    it('catches up ten days from the old span end, stopping the span before a date the JSON lacks', async () => {
        const harness = await bootstrapped();
        await skipDailySteps(harness, '2026-10-20');
        const later = Array.from({ length: 13 }, (_, index) =>
            publication(tableFrom(addDays(date('2026-10-08'), index), Number((2.6 + index / 1000).toFixed(4)))),
        );
        for (const subject of later) {
            if (subject.validFrom === '2026-10-14') {
                harness.fake.publishCsv(subject);
            } else {
                harness.fake.publish(subject);
            }
        }
        const mark = harness.mark();
        const result = await harness.run('2026-10-20T10:00');
        expect(result).toEqual(
            line({
                time: '2026-10-20T06:00:02.000Z',
                scheduledTime: '2026-10-20T06:00:00.000Z',
                committed: 12,
                nbgRequests: 27,
                span: '2026-10-01..2026-10-13',
                rowsStart: '1995-10-14',
            }),
        );
        expect(harness.since(mark).requests).toEqual([
            `range:${CODES}:2026-10-02:2026-10-21`,
            ...later.flatMap((subject) => [`day:en:${subject.validFrom}`, `day:ka:${subject.validFrom}`]),
        ]);
        const state = await harness.state();
        expect(state.span).toEqual({ start: '2026-10-01', end: '2026-10-13' });
        expect(state.unresolved).toEqual(['2026-10-14']);
        expect(state.freshUntil).toBe(at('2026-10-08T11:05'));
        expect(await held(harness.store, '2026-10-14')).toBeUndefined();
        expect(await held(harness.store, '2026-10-15')).toBeDefined();
    });

    it('splits a catch-up longer than 31 days into CSV chunks, each coded from its latest stored table', async () => {
        const harness = await bootstrapped();
        await skipDailySteps(harness, '2026-11-20');
        // AMD leaves NBG's tables from 2026-10-20, so the second chunk's request no longer names it.
        const october20 = publication(withoutCode(tableFrom('2026-10-20', 2.62), 'AMD'));
        const november10 = publication(withoutCode(tableFrom('2026-11-10', 2.63), 'AMD'));
        harness.fake.publish(october20);
        harness.fake.publish(november10);
        const withoutAmd = CODES.split(',')
            .filter((candidate) => candidate !== 'AMD')
            .join(',');
        const mark = harness.mark();
        const result = await harness.run('2026-11-20T10:00');
        expect(result).toMatchObject({
            syncResult: 'ok',
            checked: true,
            committed: 2,
            span: '2026-10-01..2026-11-21',
        });
        expect(harness.since(mark).requests).toEqual([
            `range:${CODES}:2026-10-02:2026-11-01`,
            'day:en:2026-10-20',
            'day:ka:2026-10-20',
            `range:${withoutAmd}:2026-11-02:2026-11-21`,
            'day:en:2026-11-10',
            'day:ka:2026-11-10',
        ]);
        expect((await harness.state()).freshUntil).toBe(at('2026-11-20T11:05'));
    });
});

describe('runSync: the deadline', () => {
    it('stops a bootstrap whose time runs short after two publications, and the next run finishes it', async () => {
        const harness = await setUp();
        const commits = (): number => harness.store.writes.filter((write) => write.operation === 'commit').length;
        const result = await harness.run('2026-10-08T10:00', {
            remainingMs: () => (commits() >= 2 ? 15_000 : 25_000),
        });
        expect(result).toMatchObject({ syncResult: 'ok', syncDetail: 'deadline', checked: false, committed: 2 });
        expect(harness.fake.requests).toHaveLength(6);
        expect(await held(harness.store, '2026-10-01')).toBeDefined();
        expect(await held(harness.store, '2026-10-02')).toBeDefined();
        for (const day of ['2026-10-03', '2026-10-06', '2026-10-07']) {
            expect(await held(harness.store, day)).toBeUndefined();
        }
        const stopped = await harness.state();
        expect(stopped.span).toBeUndefined();
        expect(stopped.freshUntil).toBeUndefined();

        const mark = harness.mark();
        const next = await harness.run('2026-10-08T11:00');
        // Today's table, the CSV and the three publications not yet committed, each in both languages.
        expect(next).toMatchObject({ syncResult: 'ok', syncDetail: null, checked: true, committed: 3, nbgRequests: 8 });
        expect(harness.since(mark).requests).toHaveLength(8);
        const finished = await harness.state();
        expect(finished.span).toEqual({ start: '2026-10-01', end: '2026-10-09' });
        expect(finished.freshUntil).toBe(at('2026-10-08T12:05'));
        for (const subject of OCTOBER) {
            expect(await held(harness.store, subject.validFrom)).toBeDefined();
        }
    });

    /** A bootstrap at 10:00 whose time runs short once it has committed 2026-10-01 and 2026-10-02. */
    async function cutShortBootstrap(): Promise<Harness> {
        const harness = await setUp();
        const commits = (): number => harness.store.writes.filter((write) => write.operation === 'commit').length;
        const result = await harness.run('2026-10-08T10:00', {
            remainingMs: () => (commits() >= 2 ? 15_000 : 25_000),
        });
        expect(result).toMatchObject({ syncDetail: 'deadline', committed: 2 });
        return harness;
    }

    it('fetches on the next run only the publications a bootstrap cut short left uncommitted', async () => {
        const harness = await cutShortBootstrap();
        const mark = harness.mark();
        const next = await harness.run('2026-10-08T11:00');
        expect(next).toMatchObject({ syncResult: 'ok', checked: true, committed: 3, nbgRequests: 8 });
        // 2026-10-01 and 2026-10-02 hold the export's rows and both tables: the cut-short run committed them.
        expect(harness.since(mark).requests).toEqual([
            'day:en:2026-10-08',
            `range:${CODES}:2026-10-01:2026-10-09`,
            ...['2026-10-03', '2026-10-06', '2026-10-07'].flatMap((day) => [`day:en:${day}`, `day:ka:${day}`]),
        ]);
        expect((await harness.state()).span).toEqual({ start: '2026-10-01', end: '2026-10-09' });
    });

    it('resolves again a publication the cut-short bootstrap committed when NBG has changed its rows since', async () => {
        const harness = await cutShortBootstrap();
        const changed = publication(withRates(tableFixture('en', '2026-10-02'), { USD: 2.6111 }));
        harness.fake.publish(changed);
        const mark = harness.mark();
        const next = await harness.run('2026-10-08T11:00');
        expect(next).toMatchObject({ syncResult: 'ok', checked: true, committed: 4 });
        expect(harness.since(mark).requests).toEqual([
            'day:en:2026-10-08',
            `range:${CODES}:2026-10-01:2026-10-09`,
            ...['2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07'].flatMap((day) => [
                `day:en:${day}`,
                `day:ka:${day}`,
            ]),
        ]);
        expect(await held(harness.store, '2026-10-02')).toEqual(expectedHeld(changed, at('2026-10-08T11:00:02')));
    });

    it('records no fresh-until without time left for the write', async () => {
        const harness = await bootstrapped();
        const sent = harness.mark().requests;
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T11:00', {
            remainingMs: () => (harness.fake.requests.length > sent ? 2_400 : 25_000),
        });
        expect(result).toMatchObject({ syncResult: 'ok', syncDetail: 'deadline', checked: false, nbgRequests: 1 });
        expect(harness.since(mark).writes).toEqual([{ operation: 'state', key: 'state/state' }]);
        expect((await harness.state()).freshUntil).toBe(at('2026-10-08T11:05'));
    });

    it('does not start a commit without its reserve', async () => {
        const harness = await setUp();
        // The fourth request is the first publication's Georgian table; after it only 4,900 ms are left.
        const result = await harness.run('2026-10-08T10:00', {
            remainingMs: () => (harness.fake.requests.length >= 4 ? 4_900 : 25_000),
        });
        expect(result).toMatchObject({ syncResult: 'ok', syncDetail: 'deadline', committed: 0, nbgRequests: 4 });
        expect(harness.store.writes).toEqual([{ operation: 'state', key: 'state/state' }]);
    });

    it('leaves the answers of a catch-up stopped right after committing beyond the span as before the run', async () => {
        const beyond = ['2026-10-10', '2026-10-11', '2026-10-12'].map((day, index) =>
            publication(tableFrom(day, 2.61 + index / 1000)),
        );
        // The mirror is fresh at 10:00:30, so the answers inside the span come from it without asking NBG.
        const harness = await setUp({
            nbg: [...OCTOBER, ...beyond],
            seed: {
                publications: OCTOBER,
                state: {
                    span: { start: date('2026-10-01'), end: date('2026-10-09') },
                    freshUntil: at('2026-10-12T10:05'),
                },
            },
        });
        const now = tbilisi('2026-10-12T10:00:30');
        const days = Array.from({ length: 10 }, (_, index) => addDays(date('2026-10-01'), index));
        /** Each day's snapshot from a new instance of the service, and what it asked. */
        async function answers(): Promise<{ readonly answers: unknown[]; readonly asked: ReadonlyArray<string> }> {
            const { service, asked } = mirroredService(harness, now);
            const found: unknown[] = [];
            for (const day of days) {
                found.push(await service.getSnapshot({ date: day, language: 'en' }));
            }
            return { answers: found, asked };
        }
        const before = await answers();
        // Only 2026-10-10, outside the span, goes to NBG, through today's live path.
        expect(before.asked).toEqual(['live.getSnapshot']);

        const mark = harness.mark();
        const committedTen = (): boolean =>
            harness.store.writes.some((write) => write.operation === 'commit' && write.key === 'rows/2026-10-10');
        // 5,000 ms leave room for a state write but not for another request.
        const result = await harness.run('2026-10-12T10:00', {
            remainingMs: () => (committedTen() ? 5_000 : 25_000),
        });
        expect(result).toMatchObject({
            syncResult: 'ok',
            syncDetail: 'deadline',
            committed: 1,
            span: '2026-10-01..2026-10-09',
        });
        expect(harness.since(mark).requests).toEqual([
            `range:${CODES}:2026-10-02:2026-10-13`,
            'day:en:2026-10-10',
            'day:ka:2026-10-10',
        ]);
        expect(await held(harness.store, '2026-10-10')).toBeDefined();
        expect((await harness.state()).span).toEqual({ start: '2026-10-01', end: '2026-10-09' });

        const after = await answers();
        expect(after).toEqual(before);
    });
});

describe('runSync: two runs at once', () => {
    it('lets a held 16:00 run change neither a later commit of 2026-10-09 nor fresh-until 17:03', async () => {
        const harness = await bootstrapped();
        await skipArchiveFill(harness);
        // NBG shows a 2026-10-09 table to the 16:00 run; the 17:01 window run later stores a newer one.
        harness.fake.publish(publication(tableFrom('2026-10-09', 2.6013)));
        const newer = publication(tableFrom('2026-10-09', 2.6111), { observedAt: at('2026-10-08T17:01:02') });
        let release: (() => void) | undefined;
        const client: NbgClient = {
            fetchDay: (day, language) => harness.fake.client.fetchDay(day, language),
            async fetchRange(codes, start, end) {
                const exported = await harness.fake.client.fetchRange(codes, start, end);
                release = harness.fake.hold();
                return exported;
            },
        };
        const running = harness.run('2026-10-08T16:00', { client });
        await vi.waitFor(() => {
            expect(harness.fake.requests).toContain('day:en:2026-10-09');
        });
        expect(await harness.store.commitPublication(newer, SIGNAL)).toEqual({ ok: true, value: 'committed' });
        const recorded = await harness.store.updateState(
            (state) => ({ next: recordFreshUntil(state, at('2026-10-08T17:03')), outcome: undefined }),
            SIGNAL,
        );
        expect(recorded.ok).toBe(true);
        release?.();
        const result = await running;
        expect(result).toMatchObject({ syncResult: 'ok', committed: 0 });
        expect(await held(harness.store, '2026-10-09')).toEqual(expectedHeld(newer));
        expect((await harness.state()).freshUntil).toBe(at('2026-10-08T17:03'));
    });
});

describe('runSync: unresolved dates outside the check', () => {
    async function withOldUnresolved(): Promise<{ readonly harness: Harness; readonly old: MirrorPublication }> {
        const harness = await bootstrapped();
        await skipDailySteps(harness, '2026-10-08');
        const old = publication(tableFrom('2026-09-28', 2.7123));
        harness.fake.publish(old);
        const marked = await harness.store.updateState(
            (state) => ({ next: markUnresolved(state, [date('2026-09-28')]), outcome: undefined }),
            SIGNAL,
        );
        expect(marked.ok).toBe(true);
        return { harness, old };
    }

    it('retries an unresolved date before the checked range after the check', async () => {
        const { harness, old } = await withOldUnresolved();
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T11:00');
        expect(result).toMatchObject({ syncResult: 'ok', checked: true, committed: 1 });
        expect(harness.since(mark).requests).toEqual([
            `range:${CODES}:2026-10-01:2026-10-09`,
            'day:en:2026-09-28',
            'day:ka:2026-09-28',
            `range:${CODES}:2026-09-28:2026-09-28`,
        ]);
        expect(await held(harness.store, '2026-09-28')).toEqual(expectedHeld(old, at('2026-10-08T11:00:02')));
        expect((await harness.state()).unresolved).toEqual([]);
    });

    it('fails a checked run on a failed retry, keeping the fresh-until of the check and the date unresolved', async () => {
        const { harness } = await withOldUnresolved();
        const client: NbgClient = {
            fetchDay: (day, language) =>
                day === '2026-09-28' ? Promise.resolve(err(UNAVAILABLE)) : harness.fake.client.fetchDay(day, language),
            fetchRange: (codes, start, end) => harness.fake.client.fetchRange(codes, start, end),
        };
        const result = await harness.run('2026-10-08T11:00', { client });
        expect(result).toMatchObject({
            syncResult: 'failed',
            syncDetail: 'upstream_unavailable',
            checked: true,
            committed: 0,
            nbgRequests: 2,
        });
        const state = await harness.state();
        expect(state.unresolved).toEqual(['2026-09-28']);
        expect(state.freshUntil).toBe(at('2026-10-08T12:05'));
    });

    it('keeps a date the CSV still lists and the JSON lacks unresolved, asking the CSV for it alone', async () => {
        const harness = await bootstrapped();
        await skipDailySteps(harness, '2026-10-08');
        // NBG's JSON answers the 2026-09-20 table for 2026-09-28; its CSV still lists a table valid from 2026-09-28.
        harness.fake.publishJson(publication(tableFrom('2026-09-20', 2.7001)));
        harness.fake.publishCsv(publication(tableFrom('2026-09-28', 2.7123)));
        const marked = await harness.store.updateState(
            (state) => ({ next: markUnresolved(state, [date('2026-09-28')]), outcome: undefined }),
            SIGNAL,
        );
        expect(marked.ok).toBe(true);
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T11:00');
        expect(result).toMatchObject({ syncResult: 'ok', syncDetail: null, checked: true, committed: 0 });
        expect(harness.since(mark).requests).toEqual([
            `range:${CODES}:2026-10-01:2026-10-09`,
            'day:en:2026-09-28',
            'day:ka:2026-09-28',
            `range:${CODES}:2026-09-28:2026-09-28`,
        ]);
        // The claim and the fresh-until write; the mark already stands, and nothing is removed.
        expect(harness.since(mark).writes.map((write) => write.operation)).toEqual(['state', 'state']);
        expect(await held(harness.store, '2026-09-28')).toBeUndefined();
        expect((await harness.state()).unresolved).toEqual(['2026-09-28']);
    });
});

describe('runSync: the log line', () => {
    it("shows the rows' start the run last saw: 2025-01-01 once it has filled 2025", async () => {
        const harness = await setUp({
            nbg: [publication(syntheticTable('2025-01-01', { EUR: 2.9876, USD: 2.7012 })), ...OCTOBER],
            seed: {
                publications: OCTOBER,
                state: {
                    span: { start: date('2026-10-01'), end: date('2026-10-09') },
                    rowsStart: date('2026-01-01'),
                    refetch: { day: date('2026-10-08') },
                },
            },
        });
        const mark = harness.mark();
        // The check's CSV, then 2025's thirteen tables and CSV; no time is left for 2024's first table.
        const result = await harness.run('2026-10-08T10:00', {
            remainingMs: () => (harness.fake.requests.length - mark.requests >= 15 ? 15_000 : 25_000),
        });
        expect(result).toEqual(
            line({
                time: '2026-10-08T06:00:02.000Z',
                scheduledTime: '2026-10-08T06:00:00.000Z',
                syncDetail: 'deadline',
                checked: true,
                nbgRequests: 15,
                span: '2026-10-01..2026-10-09',
                rowsStart: '2025-01-01',
            }),
        );
    });

    it("shows no rows' start, as no span, for a run that sees no span", async () => {
        const harness = await setUp();
        harness.fake.failWith(UNAVAILABLE);
        expect(await harness.run('2026-10-08T10:00')).toEqual(
            line({
                time: '2026-10-08T06:00:02.000Z',
                scheduledTime: '2026-10-08T06:00:00.000Z',
                syncResult: 'failed',
                syncDetail: 'upstream_unavailable',
                nbgRequests: 1,
                span: null,
                rowsStart: null,
            }),
        );
    });
});

describe('notConfiguredLine', () => {
    it('is a failed line saying the mirror is not configured', () => {
        expect(
            notConfiguredLine(
                { kind: 'window', scheduledTime: tbilisi('2026-10-08T17:01') },
                tbilisi('2026-10-08T17:01:03'),
            ),
        ).toEqual(
            line({
                time: '2026-10-08T13:01:03.000Z',
                syncRun: 'window',
                scheduledTime: '2026-10-08T13:01:00.000Z',
                syncResult: 'failed',
                syncDetail: 'mirror_not_configured',
            }),
        );
    });

    it('prints a scheduled time that is not a valid date without throwing', () => {
        const result = notConfiguredLine(
            { kind: 'hourly', scheduledTime: new Date(Number.NaN) },
            tbilisi('2026-10-08T10:00'),
        );
        expect(result.scheduledTime).toBe('Invalid Date');
    });
});
