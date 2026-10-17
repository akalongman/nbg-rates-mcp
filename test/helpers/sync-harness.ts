import { expect } from 'vitest';
import { addDays } from '../../src/core/dates.js';
import type { MirrorState } from '../../src/core/mirror.js';
import { tableCodes, type MirrorPublication } from '../../src/core/mirror-publication.js';
import type { NbgCsvRow } from '../../src/core/nbg-csv.js';
import type { NbgDay } from '../../src/core/nbg-schema.js';
import type { SyncKind } from '../../src/core/sync-schedule.js';
import type { RatesError } from '../../src/core/types.js';
import { createSnapshotCache } from '../../src/shell/cache.js';
import { createLookupScopes } from '../../src/shell/lookup-scope.js';
import { createMirroredRatesService } from '../../src/shell/mirrored-rates-service.js';
import type { NbgClient } from '../../src/shell/nbg-client.js';
import { createRatesService, type RatesService } from '../../src/shell/rates-service.js';
import { runSync, type SyncLogLine } from '../../src/shell/sync.js';
import { createFakeNbg, type FakeNbg } from './fake-nbg.js';
import {
    createMemoryMirrorStore,
    seedMirror,
    type MemoryMirrorStore,
    type MemoryWrite,
} from './memory-mirror-store.js';
import { publication, tableFixture } from './publications.js';
import { date } from './values.js';

export const SIGNAL = new AbortController().signal;
/** The recorded publications of 2026-10-01 to 2026-10-07: 10-04 and 10-05 repeat the table valid from 10-03. */
export const OCTOBER: ReadonlyArray<MirrorPublication> = [
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-06',
    '2026-10-07',
].map((day) => publication(tableFixture('en', day), day === '2026-10-07' ? { ka: tableFixture('ka', day) } : {}));
/** Every recorded table quotes these codes in this order, so each CSV request names them. */
export const CODES = tableCodes(tableFixture('en', '2026-10-07')).join(',');
export const UNAVAILABLE: RatesError = { kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' };

/** An instant from Tbilisi wall-clock time, UTC+4 all year: '2026-10-08T10:00' is 06:00 UTC. */
export function tbilisi(wallClock: string): Date {
    return new Date(`${wallClock.length === 16 ? `${wallClock}:00` : wallClock}+04:00`);
}

export function at(wallClock: string): number {
    return tbilisi(wallClock).getTime();
}

/** The 2026-10-07 table as NBG would publish it valid from `validFrom`, with USD at `usd`. */
export function tableFrom(validFrom: string, usd: number): NbgDay {
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

export function withRates(table: NbgDay, rates: Readonly<Record<string, number>>): NbgDay {
    return { ...table, currencies: table.currencies.map((row) => ({ ...row, rate: rates[row.code] ?? row.rate })) };
}

export function withoutCode(table: NbgDay, withdrawn: string): NbgDay {
    return { ...table, currencies: table.currencies.filter((row) => row.code !== withdrawn) };
}

export interface Held {
    readonly en: NbgDay;
    readonly ka: NbgDay;
    readonly rows: ReadonlyArray<NbgCsvRow>;
    readonly observedAt: number;
}

export function expectedHeld(subject: MirrorPublication, observedAt: number = subject.observedAt): Held {
    return { en: subject.en, ka: subject.ka, rows: subject.rows, observedAt };
}

/** What the mirror holds for a publication, or undefined when it holds none of its three items; a part throws. */
export async function held(store: MemoryMirrorStore, validFrom: string): Promise<Held | undefined> {
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

export interface RunOptions {
    readonly kind?: SyncKind;
    readonly remainingMs?: () => number;
    /** The clock during the run; default the scheduled time plus 2 seconds. */
    readonly now?: Date;
    readonly client?: NbgClient;
}

export interface Mark {
    readonly requests: number;
    readonly writes: number;
    readonly sleeps: number;
    readonly operations: number;
}

export interface Since {
    readonly requests: ReadonlyArray<string>;
    readonly writes: ReadonlyArray<MemoryWrite>;
    readonly sleeps: ReadonlyArray<number>;
    readonly operations: ReadonlyArray<string>;
}

export interface Harness {
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

export async function setUp(
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
export async function bootstrapped(nbg?: ReadonlyArray<MirrorPublication>): Promise<Harness> {
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
export function mirroredService(
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

export function line(fields: Partial<SyncLogLine> & Pick<SyncLogLine, 'time' | 'scheduledTime'>): SyncLogLine {
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
