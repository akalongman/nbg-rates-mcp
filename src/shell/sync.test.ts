import { describe, expect, it, vi } from 'vitest';
import { createFakeNbg, type FakeNbg } from '../../test/helpers/fake-nbg.js';
import {
    createMemoryMirrorStore,
    seedMirror,
    type MemoryMirrorStore,
    type MemoryWrite,
} from '../../test/helpers/memory-mirror-store.js';
import { publication, tableFixture } from '../../test/helpers/publications.js';
import { date } from '../../test/helpers/values.js';
import { addDays } from '../core/dates.js';
import { markUnresolved, recordFreshUntil, type MirrorState } from '../core/mirror.js';
import { tableCodes, type MirrorPublication } from '../core/mirror-publication.js';
import type { NbgCsvRow } from '../core/nbg-csv.js';
import type { NbgDay } from '../core/nbg-schema.js';
import type { SyncKind } from '../core/sync-schedule.js';
import { err, type RatesError } from '../core/types.js';
import { createSnapshotCache } from './cache.js';
import { createLookupScopes } from './lookup-scope.js';
import { createMirroredRatesService } from './mirrored-rates-service.js';
import type { NbgClient } from './nbg-client.js';
import { createRatesService, type RatesService } from './rates-service.js';
import { notConfiguredLine, runSync, type SyncLogLine } from './sync.js';

const SIGNAL = new AbortController().signal;
/** The recorded publications of 2026-10-01 to 2026-10-07: 10-04 and 10-05 repeat the table valid from 10-03. */
const OCTOBER: ReadonlyArray<MirrorPublication> = [
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-06',
    '2026-10-07',
].map((day) => publication(tableFixture('en', day), day === '2026-10-07' ? { ka: tableFixture('ka', day) } : {}));
/** Every recorded table quotes these codes in this order, so each CSV request names them. */
const CODES = tableCodes(tableFixture('en', '2026-10-07')).join(',');
const UNAVAILABLE: RatesError = { kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' };

/** An instant from Tbilisi wall-clock time, UTC+4 all year: '2026-10-08T10:00' is 06:00 UTC. */
function tbilisi(wallClock: string): Date {
    return new Date(`${wallClock.length === 16 ? `${wallClock}:00` : wallClock}+04:00`);
}

function at(wallClock: string): number {
    return tbilisi(wallClock).getTime();
}

/** The 2026-10-07 table as NBG would publish it valid from `validFrom`, with USD at `usd`. */
function tableFrom(validFrom: string, usd: number): NbgDay {
    const base = tableFixture('en', '2026-10-07');
    const midnight = `${validFrom}T00:00:00.000Z`;
    const writtenAt = `${addDays(date(validFrom), -1)}T17:01:00.000Z`;
    return {
        ...base,
        date: midnight,
        currencies: base.currencies.map((row) => ({
            ...row,
            rate: row.code === 'USD' ? usd : row.rate,
            date: writtenAt,
            validFromDate: midnight,
        })),
    };
}

function withRates(table: NbgDay, rates: Readonly<Record<string, number>>): NbgDay {
    return { ...table, currencies: table.currencies.map((row) => ({ ...row, rate: rates[row.code] ?? row.rate })) };
}

function withoutCode(table: NbgDay, withdrawn: string): NbgDay {
    return { ...table, currencies: table.currencies.filter((row) => row.code !== withdrawn) };
}

interface Held {
    readonly en: NbgDay;
    readonly ka: NbgDay;
    readonly rows: ReadonlyArray<NbgCsvRow>;
    readonly observedAt: number;
}

function expectedHeld(subject: MirrorPublication, observedAt: number = subject.observedAt): Held {
    return { en: subject.en, ka: subject.ka, rows: subject.rows, observedAt };
}

/** What the mirror holds for a publication, or undefined when it holds none of its three items; a part throws. */
async function held(store: MemoryMirrorStore, validFrom: string): Promise<Held | undefined> {
    const parts = ['rows', 'table#en', 'table#ka'].map((pk) => store.rawItem(pk, validFrom));
    if (parts.every((part) => part === undefined)) {
        return undefined;
    }
    if (parts.some((part) => part === undefined)) {
        throw new Error(`${validFrom} is half written`);
    }
    const tables = await store.readTablesBetween(date(validFrom), date(validFrom), SIGNAL);
    const rows = await store.readRowsBetween(date(validFrom), date(validFrom), SIGNAL);
    const [pair] = tables.ok ? tables.value : [];
    const [item] = rows.ok ? rows.value : [];
    if (pair === undefined || item === undefined) {
        throw new Error(`${validFrom} could not be read back`);
    }
    expect(pair.observedAt).toBe(item.observedAt);
    return { en: pair.en, ka: pair.ka, rows: item.rows, observedAt: item.observedAt };
}

interface RunOptions {
    readonly kind?: SyncKind;
    readonly remainingMs?: () => number;
    /** The clock during the run; default the scheduled time plus 2 seconds. */
    readonly now?: Date;
    readonly client?: NbgClient;
}

interface Mark {
    readonly requests: number;
    readonly writes: number;
    readonly sleeps: number;
    readonly operations: number;
}

interface Since {
    readonly requests: ReadonlyArray<string>;
    readonly writes: ReadonlyArray<MemoryWrite>;
    readonly sleeps: ReadonlyArray<number>;
    readonly operations: ReadonlyArray<string>;
}

interface Harness {
    readonly store: MemoryMirrorStore;
    readonly fake: FakeNbg;
    readonly lines: ReadonlyArray<SyncLogLine>;
    /** Runs an event scheduled at a Tbilisi wall-clock time, or at an instant. */
    run(scheduled: string | Date, options?: RunOptions): Promise<SyncLogLine>;
    state(): Promise<MirrorState>;
    mark(): Mark;
    /** The requests, writes, sleeps and store operations since `mark`. */
    since(mark: Mark): Since;
}

async function setUp(
    options: {
        readonly nbg?: ReadonlyArray<MirrorPublication>;
        readonly seed?: Parameters<typeof seedMirror>[1];
    } = {},
): Promise<Harness> {
    const store = createMemoryMirrorStore();
    if (options.seed !== undefined) {
        await seedMirror(store, options.seed);
    }
    const fake = createFakeNbg(options.nbg ?? OCTOBER);
    const sleeps: number[] = [];
    const lines: SyncLogLine[] = [];
    const operations: string[] = [];
    store.before((operation) => {
        operations.push(operation);
    });
    return {
        store,
        fake,
        lines,
        run(scheduled, runOptions = {}) {
            const scheduledTime = typeof scheduled === 'string' ? tbilisi(scheduled) : scheduled;
            const now = runOptions.now ?? new Date(scheduledTime.getTime() + 2_000);
            return runSync(
                { kind: runOptions.kind ?? 'hourly', scheduledTime },
                runOptions.remainingMs ?? (() => 25_000),
                {
                    store,
                    client: runOptions.client ?? fake.client,
                    now: () => now,
                    sleep: (ms) => {
                        sleeps.push(ms);
                        return Promise.resolve();
                    },
                    log: (line) => {
                        lines.push(line);
                    },
                },
            );
        },
        async state() {
            const read = await store.readState(SIGNAL);
            if (!read.ok) {
                throw new Error(read.error.detail);
            }
            return read.value;
        },
        mark() {
            return {
                requests: fake.requests.length,
                writes: store.writes.length,
                sleeps: sleeps.length,
                operations: operations.length,
            };
        },
        since(mark) {
            return {
                requests: fake.requests.slice(mark.requests),
                writes: store.writes.slice(mark.writes),
                sleeps: sleeps.slice(mark.sleeps),
                operations: operations.slice(mark.operations),
            };
        },
    };
}

/** A harness whose 10:00 run on Thursday 2026-10-08 has bootstrapped the mirror. */
async function bootstrapped(nbg?: ReadonlyArray<MirrorPublication>): Promise<Harness> {
    const harness = await setUp(nbg === undefined ? {} : { nbg });
    const line = await harness.run('2026-10-08T10:00');
    expect(line.syncResult).toBe('ok');
    return harness;
}

function counted(name: string, service: RatesService, asked: string[]): RatesService {
    return {
        getSnapshot(args) {
            asked.push(`${name}.getSnapshot`);
            return service.getSnapshot(args);
        },
        getHistory(args) {
            asked.push(`${name}.getHistory`);
            return service.getHistory(args);
        },
    };
}

/** The service of the hosted endpoint over this mirror and NBG, each call's asks listed in `asked`. */
function mirroredService(
    harness: Harness,
    now: Date,
): { readonly service: RatesService; readonly asked: ReadonlyArray<string> } {
    const clock = (): Date => now;
    const live = createRatesService({ client: harness.fake.client, cache: createSnapshotCache(), now: clock });
    const asked: string[] = [];
    const service = createMirroredRatesService({
        mirror: harness.store,
        live: counted('live', live, asked),
        shortLive: counted('shortLive', live, asked),
        scopes: createLookupScopes(),
        now: clock,
    });
    return { service, asked };
}

function line(fields: Partial<SyncLogLine> & Pick<SyncLogLine, 'time' | 'scheduledTime'>): SyncLogLine {
    return {
        syncRun: 'hourly',
        syncResult: 'ok',
        syncDetail: null,
        checked: false,
        committed: 0,
        nbgRequests: 0,
        span: null,
        durationMs: 0,
        ...fields,
    };
}

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

    it('skips a window event as not built yet, before any store call', async () => {
        const harness = await setUp();
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T17:01', { kind: 'window' });
        expect(result).toEqual(
            line({
                time: '2026-10-08T13:01:02.000Z',
                syncRun: 'window',
                scheduledTime: '2026-10-08T13:01:00.000Z',
                syncResult: 'skipped',
                syncDetail: 'not_built',
            }),
        );
        expect(harness.since(mark)).toEqual({ requests: [], writes: [], sleeps: [], operations: [] });
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
        const mark = harness.mark();
        const result = await harness.run('2026-10-08T11:00');
        expect(result).toEqual(
            line({
                time: '2026-10-08T07:00:02.000Z',
                scheduledTime: '2026-10-08T07:00:00.000Z',
                checked: true,
                nbgRequests: 1,
                span: '2026-10-01..2026-10-09',
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
        const withdrawn = publication(withoutCode(tableFixture('en', '2026-10-06'), 'AMD'));
        harness.fake.publish(withdrawn);
        await harness.run('2026-10-08T11:00');
        const stored = await held(harness.store, '2026-10-06');
        expect(stored).toEqual(expectedHeld(withdrawn, at('2026-10-08T11:00:02')));
        expect(stored?.en.currencies.map((row) => row.code)).not.toContain('AMD');
        expect(stored?.ka.currencies.map((row) => row.code)).not.toContain('AMD');
        expect(stored?.rows.map((row) => row.code)).not.toContain('AMD');
    });

    it('removes a publication NBG withdraws from both views', async () => {
        const harness = await bootstrapped();
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

        // The unresolved date inside the span answers as the live path does, without asking NBG.
        const now = tbilisi('2026-10-08T18:00:30');
        const { service, asked } = mirroredService(harness, now);
        const reference = createRatesService({
            client: harness.fake.client,
            cache: createSnapshotCache(),
            now: () => now,
        });
        const ask = { date: date('2026-10-09'), language: 'en' as const };
        expect(await service.getSnapshot(ask)).toEqual(await reference.getSnapshot(ask));
        expect(asked).toEqual([]);

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
        expect(next).toMatchObject({ syncResult: 'ok', syncDetail: null, checked: true, committed: 3 });
        // A bootstrap resolves every publication in its window, the two already committed included.
        expect(harness.since(mark).requests).toEqual([
            'day:en:2026-10-08',
            `range:${CODES}:2026-10-01:2026-10-09`,
            ...OCTOBER.flatMap((subject) => [`day:en:${subject.validFrom}`, `day:ka:${subject.validFrom}`]),
        ]);
        const finished = await harness.state();
        expect(finished.span).toEqual({ start: '2026-10-01', end: '2026-10-09' });
        expect(finished.freshUntil).toBe(at('2026-10-08T12:05'));
        for (const subject of OCTOBER) {
            expect(await held(harness.store, subject.validFrom)).toBeDefined();
        }
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

    it('keeps a checked run ok when the retry fails, leaving the date unresolved', async () => {
        const { harness } = await withOldUnresolved();
        const client: NbgClient = {
            fetchDay: (day, language) =>
                day === '2026-09-28' ? Promise.resolve(err(UNAVAILABLE)) : harness.fake.client.fetchDay(day, language),
            fetchRange: (codes, start, end) => harness.fake.client.fetchRange(codes, start, end),
        };
        const result = await harness.run('2026-10-08T11:00', { client });
        expect(result).toMatchObject({ syncResult: 'ok', syncDetail: null, checked: true, committed: 0 });
        const state = await harness.state();
        expect(state.unresolved).toEqual(['2026-09-28']);
        expect(state.freshUntil).toBe(at('2026-10-08T12:05'));
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
