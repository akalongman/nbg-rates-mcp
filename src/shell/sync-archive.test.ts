import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeNbg } from '../../test/helpers/fake-nbg.js';
import { createMemoryMirrorStore, seedMirror } from '../../test/helpers/memory-mirror-store.js';
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
    tableFrom,
    tbilisi,
    UNAVAILABLE,
    type Harness,
} from '../../test/helpers/sync-harness.js';
import { date } from '../../test/helpers/values.js';
import { NBG_ARCHIVE_START } from '../core/dates.js';
import { EMPTY_MIRROR_STATE, markUnresolved, type MirrorState } from '../core/mirror.js';
import type { MirrorPublication } from '../core/mirror-publication.js';
import type { NbgDay } from '../core/nbg-schema.js';
import { err, ok, type RatesError } from '../core/types.js';
import type { StoredRows } from './mirror-store.js';
import type { NbgClient } from './nbg-client.js';
import type { SyncLogLine } from './sync.js';
import { runArchiveFill, runDailyRefetch, runRecheckSlice } from './sync-archive.js';
import { createSyncContext, type SyncContext } from './sync-publication.js';

/**
 * The fill and the re-check slice both read rowsStart, so no seeded state takes the fill out of the slice cases' way:
 * each describe's beforeEach picks the real runArchiveFill or a stub that answers complete and asks and writes nothing.
 */
const fill = vi.hoisted(() => ({ real: false }));

vi.mock('./sync-archive.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('./sync-archive.js')>();
    return {
        ...original,
        runArchiveFill: (context: SyncContext, state: MirrorState) =>
            fill.real ? original.runArchiveFill(context, state) : Promise.resolve(ok('complete' as const)),
    };
});

/** The check's CSV on Thursday 2026-10-08: the last 7 days and tomorrow. */
const CHECK_CSV = `range:${CODES}:2026-10-01:2026-10-09`;
const SHAPE_CHANGED: RatesError = { kind: 'upstream_shape_changed', detail: 'rates is not a number' };
/** When the archive rows below were fetched: before every run in this file. */
const ARCHIVED_AT = Date.parse('2026-09-01T00:00:00.000Z');

/** Tables valid from five Tuesdays in September 2026, each with its own USD rate. */
const SEPTEMBER: ReadonlyArray<MirrorPublication> = [
    '2026-09-01',
    '2026-09-08',
    '2026-09-15',
    '2026-09-22',
    '2026-09-29',
].map((day, index) => publication(tableFrom(day, Number((2.681 + index / 1000).toFixed(4)))));

/** One archive publication in each of 2024, 2025 and 2026, before the October span. */
const YEARLY: ReadonlyArray<MirrorPublication> = [
    publication(syntheticTable('2024-06-03', { EUR: 2.9512, USD: 2.6801 })),
    publication(syntheticTable('2025-06-02', { EUR: 3.0123, USD: 2.7345 })),
    publication(syntheticTable('2026-06-01', { EUR: 3.1234, USD: 2.7012 })),
];

/** Tables from 2024 to 2026 before the October span; XYZ is quoted from 2025-06-02 to 2025-07-31 only. */
const BEFORE_SPAN: ReadonlyArray<MirrorPublication> = [
    publication(syntheticTable('2024-01-01', { EUR: 2.9012, USD: 2.6801 })),
    publication(syntheticTable('2025-01-01', { EUR: 2.9876, USD: 2.7012 })),
    publication(syntheticTable('2025-06-02', { EUR: 3.0123, USD: 2.7345, XYZ: 1.2345 })),
    publication(syntheticTable('2025-08-01', { EUR: 3.0234, USD: 2.7111 })),
    publication(syntheticTable('2026-03-02', { EUR: 3.1234, USD: 2.7012 })),
];

function tableRequests(days: ReadonlyArray<string>): ReadonlyArray<string> {
    return days.flatMap((day) => [`day:en:${day}`, `day:ka:${day}`]);
}

function renamed(table: NbgDay, code: string, name: string): NbgDay {
    return { ...table, currencies: table.currencies.map((row) => (row.code === code ? { ...row, name } : row)) };
}

/** The fill's month samples for a year: the English tables of the first day of its months 1 to `lastMonth`. */
function monthTables(year: number, lastMonth: number): ReadonlyArray<string> {
    return Array.from({ length: lastMonth }, (_, index) => `day:en:${year}-${String(index + 1).padStart(2, '0')}-01`);
}

/** The publications' rows as the archive rows' fill stores them. */
function archived(
    subjects: ReadonlyArray<MirrorPublication>,
    observedAt: number = ARCHIVED_AT,
): ReadonlyArray<StoredRows> {
    return subjects.map((subject) => ({ validFrom: subject.validFrom, rows: subject.rows, observedAt }));
}

/**
 * `harness.fake`, except that it answers `failing` days in `language` (both when omitted) with `error`. Every request
 * reaches the fake, so its request list shows the failing ones too.
 */
function failingDays(
    harness: Harness,
    failing: ReadonlyArray<string>,
    error: RatesError,
    language?: 'en' | 'ka',
): NbgClient {
    return {
        async fetchDay(day, asked) {
            const answer = await harness.fake.client.fetchDay(day, asked);
            return failing.includes(day) && (language === undefined || asked === language) ? err(error) : answer;
        },
        fetchRange: (codes, start, end) => harness.fake.client.fetchRange(codes, start, end),
    };
}

/** `harness.fake`, except that it answers each CSV request starting on `start` with `error`. */
function failingRanges(harness: Harness, start: string, error: RatesError): NbgClient {
    return {
        fetchDay: (day, language) => harness.fake.client.fetchDay(day, language),
        async fetchRange(codes, from, to) {
            const answer = await harness.fake.client.fetchRange(codes, from, to);
            return from === start ? err(error) : answer;
        },
    };
}

/**
 * A run's remaining time: enough for an NBG request until the run has made `requests` of them, then 15,000 ms, which
 * covers a store operation and the log line but no request. Call it just before the run.
 */
function stopsAfter(harness: Harness, requests: number): () => number {
    const before = harness.fake.requests.length;
    return () => (harness.fake.requests.length - before >= requests ? 15_000 : 25_000);
}

/** A span from 2026-09-01 holding SEPTEMBER and OCTOBER as NBG holds them, with the 2026-10-08 refetch done. */
function septemberSpan(state: Partial<Omit<MirrorState, 'revision'>> = {}): Promise<Harness> {
    return setUp({
        nbg: [...SEPTEMBER, ...OCTOBER],
        seed: {
            publications: [...SEPTEMBER, ...OCTOBER],
            state: {
                span: { start: date('2026-09-01'), end: date('2026-10-09') },
                refetch: { day: date('2026-10-08') },
                ...state,
            },
        },
    });
}

/** The October span with archive rows from `rowsStart`, as NBG holds them, and the 2026-10-08 refetch done. */
function withArchive(
    rowsStart: string,
    archive: ReadonlyArray<MirrorPublication>,
    later: ReadonlyArray<MirrorPublication> = [],
): Promise<Harness> {
    return setUp({
        nbg: [...archive, ...OCTOBER, ...later],
        seed: {
            archiveRows: archived(archive),
            publications: [...OCTOBER, ...later],
            state: {
                span: { start: date('2026-10-01'), end: date('2026-10-09') },
                rowsStart: date(rowsStart),
                refetch: { day: date('2026-10-08') },
            },
        },
    });
}

/** The October span with the 2026-10-08 refetch done and no archive rows stored; NBG also holds `archive`. */
function beforeFill(
    archive: ReadonlyArray<MirrorPublication>,
    state: Partial<Omit<MirrorState, 'revision'>> = {},
): Promise<Harness> {
    return setUp({
        nbg: [...archive, ...OCTOBER],
        seed: {
            publications: OCTOBER,
            state: {
                span: { start: date('2026-10-01'), end: date('2026-10-09') },
                refetch: { day: date('2026-10-08') },
                ...state,
            },
        },
    });
}

/** A context for a step called directly, as a run scheduled at the Tbilisi wall-clock time would build it. */
function contextAt(harness: Harness, scheduled: string): SyncContext {
    const scheduledAt = tbilisi(scheduled);
    return createSyncContext({
        store: harness.store,
        client: harness.fake.client,
        now: () => new Date(scheduledAt.getTime() + 2_000),
        sleep: () => Promise.resolve(),
        scheduledAt,
        remainingMs: () => 25_000,
    });
}

describe('the hourly steps without a span', () => {
    beforeEach(() => {
        fill.real = false;
    });

    it('finds neither the refetch nor a re-check slice due, with no store call or request', async () => {
        const store = createMemoryMirrorStore();
        const operations: string[] = [];
        store.before((operation) => {
            operations.push(operation);
        });
        const fake = createFakeNbg(OCTOBER);
        const context = createSyncContext({
            store,
            client: fake.client,
            now: () => tbilisi('2026-10-08T10:00:02'),
            sleep: () => Promise.resolve(),
            scheduledAt: tbilisi('2026-10-08T10:00'),
            remainingMs: () => 25_000,
        });
        expect(await runDailyRefetch(context, EMPTY_MIRROR_STATE)).toEqual({ ok: true, value: 'not_due' });
        expect(await runRecheckSlice(context, EMPTY_MIRROR_STATE)).toEqual({ ok: true, value: 'not_due' });
        expect(operations).toEqual([]);
        expect(fake.requests).toEqual([]);
    });
});

describe('runDailyRefetch: the daily refetch', () => {
    beforeEach(() => {
        fill.real = false;
    });

    it('commits a changed English name of 2026-10-06 at 03:00, refetching nothing at 02:00 or 04:00', async () => {
        const harness = await setUp();
        expect(await harness.run('2026-10-08T01:00')).toMatchObject({ syncResult: 'ok', checked: true, committed: 5 });
        // NBG renames USD in the English table of 2026-10-06; no rate changes, so the CSV is unchanged.
        const original = publication(tableFixture('en', '2026-10-06'));
        const changed = publication(renamed(original.en, 'USD', 'United States Dollar'), { ka: original.ka });
        harness.fake.publish(changed);

        const night = harness.mark();
        expect(await harness.run('2026-10-08T02:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            checked: true,
            committed: 0,
            nbgRequests: 1,
        });
        expect(harness.since(night).requests).toEqual([CHECK_CSV]);
        expect((await harness.state()).refetch).toEqual({});

        const three = harness.mark();
        expect(await harness.run('2026-10-08T03:00')).toEqual(
            line({
                time: '2026-10-07T23:00:02.000Z',
                scheduledTime: '2026-10-07T23:00:00.000Z',
                checked: true,
                committed: 1,
                nbgRequests: 12,
                span: '2026-10-01..2026-10-09',
            }),
        );
        expect(harness.since(three).requests).toEqual([
            CHECK_CSV,
            ...tableRequests(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06']),
            `range:${CODES}:2026-10-06:2026-10-06`,
            ...tableRequests(['2026-10-07']),
        ]);
        expect(await held(harness.store, '2026-10-06')).toEqual(expectedHeld(changed, at('2026-10-08T03:00:02')));
        expect((await harness.state()).refetch).toEqual({ day: '2026-10-08' });

        const four = harness.mark();
        expect(await harness.run('2026-10-08T04:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            committed: 0,
            nbgRequests: 1,
        });
        expect(harness.since(four).requests).toEqual([CHECK_CSV]);
    });

    it('keeps the cursor at the third publication when the deadline comes after two, and the next run finishes', async () => {
        const harness = await bootstrapped();
        const mark = harness.mark();
        // The check's CSV and both tables of 2026-10-01 and 2026-10-02 leave room for a state write, not a request.
        const result = await harness.run('2026-10-08T11:00', {
            remainingMs: () => (harness.fake.requests.length - mark.requests >= 5 ? 5_000 : 25_000),
        });
        expect(result).toMatchObject({
            syncResult: 'ok',
            syncDetail: 'deadline',
            checked: true,
            committed: 0,
            nbgRequests: 5,
        });
        expect(harness.since(mark).requests).toEqual([CHECK_CSV, ...tableRequests(['2026-10-01', '2026-10-02'])]);
        const stopped = await harness.state();
        expect(stopped.refetch).toEqual({ cursor: '2026-10-03' });
        // The deadline ends the run before the re-check.
        expect(stopped.recheck).toEqual({});

        const next = harness.mark();
        expect(await harness.run('2026-10-08T12:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            checked: true,
            nbgRequests: 7,
        });
        expect(harness.since(next).requests).toEqual([
            CHECK_CSV,
            ...tableRequests(['2026-10-03', '2026-10-06', '2026-10-07']),
        ]);
        expect((await harness.state()).refetch).toEqual({ day: '2026-10-08' });
    });

    it('commits a changed Georgian name of 2026-10-07, which only the refetch sees', async () => {
        const harness = await bootstrapped();
        const original = publication(tableFixture('en', '2026-10-07'), { ka: tableFixture('ka', '2026-10-07') });
        const changed = publication(original.en, { ka: renamed(original.ka, 'USD', 'ka: US dollar, renamed') });
        harness.fake.publish(changed);
        const mark = harness.mark();
        expect(await harness.run('2026-10-08T11:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            checked: true,
            committed: 1,
            nbgRequests: 12,
        });
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            ...tableRequests(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07']),
            `range:${CODES}:2026-10-07:2026-10-07`,
        ]);
        expect(await held(harness.store, '2026-10-07')).toEqual(expectedHeld(changed, at('2026-10-08T11:00:02')));
    });
});

describe('runRecheckSlice: the weekly re-check', () => {
    beforeEach(() => {
        fill.real = false;
    });

    it('commits a 2026-09-15 rate changed in both views through the slice for 2026', async () => {
        const harness = await septemberSpan();
        const changed = publication(tableFrom('2026-09-15', 2.6999));
        harness.fake.publish(changed);
        const mark = harness.mark();
        expect(await harness.run('2026-10-08T10:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            checked: true,
            committed: 1,
            nbgRequests: 4,
        });
        // The slice is 2026 from the span's start to 8 days before today, coded from its own stored rows.
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            `range:${CODES}:2026-09-01:2026-09-30`,
            ...tableRequests(['2026-09-15']),
        ]);
        expect(await held(harness.store, '2026-09-15')).toEqual(expectedHeld(changed, at('2026-10-08T10:00:02')));
        expect((await harness.state()).recheck).toEqual({
            cycleStartedAt: at('2026-10-08T10:00'),
            lastSliceAt: at('2026-10-08T10:00'),
            nextYear: 2027,
        });
    });

    it('rewrites the 2024-03-16 rows the CSV changed and deletes both past tables, which a later request writes again', async () => {
        const stored = publication(syntheticTable('2024-03-16', { EUR: 2.9533, USD: 2.6822 }));
        const march = [
            publication(syntheticTable('2024-03-15', { EUR: 2.9512, USD: 2.6801 })),
            stored,
            publication(syntheticTable('2024-03-19', { EUR: 2.9547, USD: 2.6838 })),
        ];
        const harness = await withArchive('2024-01-01', march);
        for (const language of ['en', 'ka'] as const) {
            const filled = await harness.store.fillPastTable(date('2024-03-16'), language, stored[language], SIGNAL);
            expect(filled).toEqual({ ok: true, value: 'written' });
        }
        const changed = publication(syntheticTable('2024-03-16', { EUR: 2.9533, USD: 2.6855 }));
        harness.fake.publish(changed);

        const mark = harness.mark();
        expect(await harness.run('2026-10-08T10:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            checked: true,
            committed: 1,
            nbgRequests: 2,
        });
        expect(harness.since(mark).requests).toEqual([CHECK_CSV, 'range:EUR,USD:2024-01-01:2024-12-31']);
        expect(harness.since(mark).writes).toEqual([
            { operation: 'state', key: 'state/state' },
            { operation: 'state', key: 'state/state' },
            { operation: 'replace', key: 'rows/2024-03-16' },
            { operation: 'state', key: 'state/state' },
        ]);
        expect(await harness.store.readRowsBetween(date('2024-03-16'), date('2024-03-16'), SIGNAL)).toEqual({
            ok: true,
            value: [{ validFrom: '2024-03-16', rows: changed.rows, observedAt: at('2026-10-08T10:00:02') }],
        });
        expect(harness.store.rawItem('table#en', '2024-03-16')).toBeUndefined();
        expect(harness.store.rawItem('table#ka', '2024-03-16')).toBeUndefined();
        expect(harness.store.rawItem('rows', '2024-03-15')?.observedAt).toBe(ARCHIVED_AT);

        const { service, asked } = mirroredService(harness, tbilisi('2026-10-08T10:30'));
        expect((await service.getSnapshot({ date: date('2024-03-16'), language: 'en' })).ok).toBe(true);
        expect(asked).toEqual(['live.getSnapshot']);
        expect(await harness.store.readTable(date('2024-03-16'), 'en', SIGNAL)).toEqual({
            ok: true,
            value: { validFrom: '2024-03-16', day: changed.en },
        });
    });

    it('waits 5 hours for a second slice, asks BGN for 2005 and leaves AZN out for 2006', async () => {
        // BGN is quoted in 2005 and absent from today's tables; NBG's filter drops every row asked with AZN in 2006.
        const year2005 = publication(syntheticTable('2005-06-01', { BGN: 1.2345, EUR: 2.2876, USD: 1.8123 }));
        const year2006 = publication(syntheticTable('2006-06-01', { AZN: 1.9876, EUR: 2.2654, USD: 1.7891 }));
        const harness = await withArchive('2005-01-01', [year2005, year2006]);

        const first = harness.mark();
        expect(await harness.run('2026-10-08T10:00')).toMatchObject({ syncResult: 'ok', nbgRequests: 2 });
        expect(harness.since(first).requests).toEqual([CHECK_CSV, 'range:BGN,EUR,USD:2005-01-01:2005-12-31']);
        expect((await harness.state()).recheck).toEqual({
            cycleStartedAt: at('2026-10-08T10:00'),
            lastSliceAt: at('2026-10-08T10:00'),
            nextYear: 2006,
        });

        for (const hour of ['11', '12', '13', '14']) {
            const waiting = harness.mark();
            expect(await harness.run(`2026-10-08T${hour}:00`)).toMatchObject({ syncResult: 'ok', nbgRequests: 1 });
            expect(harness.since(waiting).requests).toEqual([CHECK_CSV]);
        }

        const second = harness.mark();
        expect(await harness.run('2026-10-08T15:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            committed: 0,
            nbgRequests: 2,
        });
        expect(harness.since(second).requests).toEqual([CHECK_CSV, 'range:EUR,USD:2006-01-01:2006-12-31']);
        // The stored AZN row is not asked, so its absence from the export is no removal.
        expect(harness.since(second).writes.map((write) => write.operation)).toEqual(['state', 'state', 'state']);
        expect(await harness.store.readRowsBetween(date('2006-06-01'), date('2006-06-01'), SIGNAL)).toEqual({
            ok: true,
            value: [{ validFrom: '2006-06-01', rows: year2006.rows, observedAt: ARCHIVED_AT }],
        });
        expect((await harness.state()).recheck).toEqual({
            cycleStartedAt: at('2026-10-08T10:00'),
            lastSliceAt: at('2026-10-08T15:00'),
            nextYear: 2007,
        });
    });

    it('makes one CSV request per year over rows from 2024-01-01, and starts a new cycle 7 days after the first', async () => {
        // Tables from 2026-10-08 to 2026-10-16 at NBG and in the mirror, so the checks on 2026-10-15 find no change.
        const later = [
            '2026-10-08',
            '2026-10-09',
            '2026-10-10',
            '2026-10-13',
            '2026-10-14',
            '2026-10-15',
            '2026-10-16',
        ].map((day, index) => publication(tableFrom(day, Number((2.71 + index / 1000).toFixed(4)))));
        const harness = await withArchive('2024-01-01', YEARLY, later);

        const cycle: ReadonlyArray<readonly [string, string]> = [
            ['2026-10-08T10:00', 'range:EUR,USD:2024-01-01:2024-12-31'],
            ['2026-10-08T15:00', 'range:EUR,USD:2025-01-01:2025-12-31'],
            ['2026-10-08T20:00', 'range:EUR,USD:2026-01-01:2026-09-30'],
        ];
        for (const [scheduled, slice] of cycle) {
            const mark = harness.mark();
            expect(await harness.run(scheduled)).toMatchObject({ syncResult: 'ok', syncDetail: null, nbgRequests: 2 });
            expect(harness.since(mark).requests).toEqual([CHECK_CSV, slice]);
        }
        expect((await harness.state()).recheck).toEqual({
            cycleStartedAt: at('2026-10-08T10:00'),
            lastSliceAt: at('2026-10-08T20:00'),
            nextYear: 2027,
        });

        await seedMirror(harness.store, { state: { refetch: { day: date('2026-10-15') } } });
        const finished = harness.mark();
        expect(await harness.run('2026-10-15T09:00')).toMatchObject({
            syncResult: 'ok',
            checked: true,
            nbgRequests: 1,
        });
        expect(harness.since(finished).requests).toEqual([`range:${CODES}:2026-10-02:2026-10-16`]);

        const restarted = harness.mark();
        expect(await harness.run('2026-10-15T10:00')).toMatchObject({
            syncResult: 'ok',
            checked: true,
            nbgRequests: 2,
        });
        expect(harness.since(restarted).requests).toEqual([
            `range:${CODES}:2026-10-08:2026-10-16`,
            'range:EUR,USD:2024-01-01:2024-12-31',
        ]);
        expect((await harness.state()).recheck).toEqual({
            cycleStartedAt: at('2026-10-15T10:00'),
            lastSliceAt: at('2026-10-15T10:00'),
            nextYear: 2025,
        });
    });

    it('leaves a slice the deadline stops for the next run, which redoes it', async () => {
        const harness = await septemberSpan();
        const changed = publication(tableFrom('2026-09-15', 2.6999));
        harness.fake.publish(changed);
        const mark = harness.mark();
        // After the slice's CSV, too little time is left to ask for the changed date's tables.
        expect(
            await harness.run('2026-10-08T10:00', {
                remainingMs: () => (harness.fake.requests.length - mark.requests >= 2 ? 5_000 : 25_000),
            }),
        ).toMatchObject({ syncResult: 'ok', syncDetail: 'deadline', checked: true, committed: 0, nbgRequests: 2 });
        expect((await harness.state()).recheck).toEqual({});

        const next = harness.mark();
        expect(await harness.run('2026-10-08T11:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            committed: 1,
            nbgRequests: 4,
        });
        expect(harness.since(next).requests).toEqual([
            CHECK_CSV,
            `range:${CODES}:2026-09-01:2026-09-30`,
            ...tableRequests(['2026-09-15']),
        ]);
        expect(await held(harness.store, '2026-09-15')).toEqual(expectedHeld(changed, at('2026-10-08T11:00:02')));
        expect((await harness.state()).recheck).toMatchObject({ lastSliceAt: at('2026-10-08T11:00'), nextYear: 2027 });
    });

    it('runs an unfinished cycle on past 7 days instead of starting it again', async () => {
        const harness = await withArchive('2024-01-01', YEARLY);
        const unfinished = {
            cycleStartedAt: at('2026-09-30T10:00'),
            lastSliceAt: at('2026-10-07T10:00'),
            nextYear: 2025,
        };
        await seedMirror(harness.store, { state: { recheck: unfinished } });
        const mark = harness.mark();
        expect(await harness.run('2026-10-08T10:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            nbgRequests: 2,
        });
        expect(harness.since(mark).requests).toEqual([CHECK_CSV, 'range:EUR,USD:2025-01-01:2025-12-31']);
        expect((await harness.state()).recheck).toEqual({
            cycleStartedAt: at('2026-09-30T10:00'),
            lastSliceAt: at('2026-10-08T10:00'),
            nextYear: 2026,
        });
    });

    it("ends the slice at the claimed span's end, writing no rows for NBG's publications after it", async () => {
        // After an outage the claimed span ends 2026-09-15, before today - 8 (2026-09-30), and NBG has published
        // 2026-09-22 and 2026-09-29 since. Those dates are the check's catch-up, which commits them with both tables.
        const harness = await setUp({
            nbg: [...SEPTEMBER, ...OCTOBER],
            seed: {
                publications: SEPTEMBER.slice(0, 3),
                state: { span: { start: date('2026-09-01'), end: date('2026-09-15') } },
            },
        });
        const claimed = await harness.state();
        const context = createSyncContext({
            store: harness.store,
            client: harness.fake.client,
            now: () => tbilisi('2026-10-08T10:00:02'),
            sleep: () => Promise.resolve(),
            scheduledAt: tbilisi('2026-10-08T10:00'),
            remainingMs: () => 25_000,
        });
        const mark = harness.mark();
        expect(await runRecheckSlice(context, claimed)).toEqual({ ok: true, value: 'done' });
        expect(harness.since(mark).writes).toEqual([{ operation: 'state', key: 'state/state' }]);
        expect(await harness.store.readRowsBetween(date('2026-09-16'), date('2026-09-30'), SIGNAL)).toEqual({
            ok: true,
            value: [],
        });
        expect(harness.since(mark).requests).toEqual([`range:${CODES}:2026-09-01:2026-09-15`]);
        expect((await harness.state()).recheck).toEqual({
            cycleStartedAt: at('2026-10-08T10:00'),
            lastSliceAt: at('2026-10-08T10:00'),
            nextYear: 2027,
        });
    });
});

describe("runArchiveFill: the archive rows' fill", () => {
    beforeEach(() => {
        fill.real = true;
    });

    it('asks and writes nothing without a span', async () => {
        const harness = await setUp();
        const claimed = await harness.state();
        const mark = harness.mark();
        expect(await runArchiveFill(contextAt(harness, '2026-10-08T10:00'), claimed)).toEqual({
            ok: true,
            value: 'progress',
        });
        expect(harness.since(mark).requests).toEqual([]);
        expect(harness.since(mark).operations).toEqual([]);
    });

    it('fills 2026 before the span, then 2025 with the XYZ of its mid-year table, from month tables, the last day and one CSV each', async () => {
        const harness = await beforeFill(BEFORE_SPAN);
        const mark = harness.mark();
        expect(await harness.run('2026-10-08T10:00')).toEqual(
            line({
                time: '2026-10-08T06:00:02.000Z',
                scheduledTime: '2026-10-08T06:00:00.000Z',
                checked: true,
                nbgRequests: 26,
                span: '2026-10-01..2026-10-09',
                rowsStart: '2025-01-01',
            }),
        );
        // XYZ is in the table in force on 2025-07-01 alone, so only 2025's CSV names it.
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            ...monthTables(2026, 9),
            'day:en:2026-09-30',
            'range:EUR,USD:2026-01-01:2026-09-30',
            ...monthTables(2025, 12),
            'day:en:2025-12-31',
            'range:EUR,USD,XYZ:2025-01-01:2025-12-31',
        ]);
        expect(harness.since(mark).sleeps).toEqual(Array.from({ length: 25 }, () => 500));
        // The claim, the check's fresh-until and the slice; then each year's rows, one item per publication, before
        // the rows' start moves over it.
        expect(harness.since(mark).writes).toEqual([
            { operation: 'state', key: 'state/state' },
            { operation: 'state', key: 'state/state' },
            { operation: 'state', key: 'state/state' },
            { operation: 'archive', key: 'rows/2026-03-02' },
            { operation: 'state', key: 'state/state' },
            { operation: 'archive', key: 'rows/2025-01-01' },
            { operation: 'archive', key: 'rows/2025-06-02' },
            { operation: 'archive', key: 'rows/2025-08-01' },
            { operation: 'state', key: 'state/state' },
        ]);
        expect(await harness.store.readRowsBetween(date('2024-01-01'), date('2026-09-30'), SIGNAL)).toEqual({
            ok: true,
            value: archived(BEFORE_SPAN.slice(1), at('2026-10-08T10:00:02')),
        });
        expect((await harness.state()).rowsStart).toBe('2025-01-01');
    });

    it("leaves AZN out of 2007's CSV and rows, and asks it for 2008", async () => {
        const year2007 = publication(syntheticTable('2007-01-01', { AZN: 1.9876, EUR: 2.2654, USD: 1.7891 }));
        const year2008 = publication(syntheticTable('2008-01-01', { AZN: 1.8765, EUR: 2.4321, USD: 1.6789 }));
        const harness = await beforeFill([year2007, year2008], { rowsStart: date('2009-01-01') });
        const mark = harness.mark();
        expect(await harness.run('2026-10-08T10:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            nbgRequests: 29,
        });
        expect(harness.since(mark).requests.filter((request) => request.startsWith('range:'))).toEqual([
            CHECK_CSV,
            'range:AZN,EUR,USD:2008-01-01:2008-12-31',
            'range:EUR,USD:2007-01-01:2007-12-31',
        ]);
        const observedAt = at('2026-10-08T10:00:02');
        expect(await harness.store.readRowsBetween(date('2007-01-01'), date('2008-12-31'), SIGNAL)).toEqual({
            ok: true,
            value: [
                { validFrom: '2007-01-01', rows: year2007.rows.filter((row) => row.code !== 'AZN'), observedAt },
                { validFrom: '2008-01-01', rows: year2008.rows, observedAt },
            ],
        });
        expect((await harness.state()).rowsStart).toBe('2007-01-01');
    });

    it("asks 2019's CSV for a code first quoted on 2019-12-10, which the table in force on 31 December names", async () => {
        const year2018 = publication(syntheticTable('2018-01-01', { EUR: 3.0456, USD: 2.5432 }));
        const year2019 = publication(syntheticTable('2019-01-01', { EUR: 3.0567, USD: 2.6543 }));
        const quoted = publication(syntheticTable('2019-12-10', { EUR: 3.1678, QQQ: 0.4321, USD: 2.8654 }));
        const year2020 = publication(syntheticTable('2020-01-01', { EUR: 3.2109, QQQ: 0.4432, USD: 2.8765 }));
        const harness = await beforeFill([year2018, year2019, quoted, year2020], { rowsStart: date('2020-01-01') });
        const mark = harness.mark();
        const run = await harness.run('2026-10-08T10:00');
        // No first day of a month in 2019 has QQQ in force; 2019-12-31 does.
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            ...monthTables(2019, 12),
            'day:en:2019-12-31',
            'range:EUR,QQQ,USD:2019-01-01:2019-12-31',
            ...monthTables(2018, 12),
            'day:en:2018-12-31',
            'range:EUR,USD:2018-01-01:2018-12-31',
        ]);
        expect(await harness.store.readRowsBetween(date('2019-01-01'), date('2019-12-31'), SIGNAL)).toEqual({
            ok: true,
            value: archived([year2019, quoted], at('2026-10-08T10:00:02')),
        });
        expect(run).toMatchObject({ syncResult: 'ok', syncDetail: null, nbgRequests: 29 });
        expect((await harness.state()).rowsStart).toBe('2018-01-01');
    });

    it("asks the first range's CSV for a code first quoted on 2026-09-02, which the table in force on 2026-09-30 names", async () => {
        const quoted = publication(syntheticTable('2026-09-02', { EUR: 3.1345, QQQ: 0.4567, USD: 2.7123 }));
        const harness = await beforeFill([...BEFORE_SPAN, quoted]);
        const mark = harness.mark();
        const run = await harness.run('2026-10-08T10:00');
        // The table in force on 2026-09-01 is the one valid from 2026-03-02, without QQQ; on 2026-09-30 it has QQQ.
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            ...monthTables(2026, 9),
            'day:en:2026-09-30',
            'range:EUR,QQQ,USD:2026-01-01:2026-09-30',
            ...monthTables(2025, 12),
            'day:en:2025-12-31',
            'range:EUR,USD,XYZ:2025-01-01:2025-12-31',
        ]);
        expect(await harness.store.readRowsBetween(date('2026-01-01'), date('2026-09-30'), SIGNAL)).toEqual({
            ok: true,
            value: archived([...BEFORE_SPAN.slice(4), quoted], at('2026-10-08T10:00:02')),
        });
        expect(run).toMatchObject({ syncResult: 'ok', syncDetail: null, nbgRequests: 26 });
        expect((await harness.state()).rowsStart).toBe('2025-01-01');
    });

    it("asks a range's last day once when it is the first day of a month", async () => {
        const harness = await beforeFill(BEFORE_SPAN, { span: { start: date('2026-10-02'), end: date('2026-10-09') } });
        const claimed = await harness.state();
        const mark = harness.mark();
        expect(await runArchiveFill(contextAt(harness, '2026-10-08T10:00'), claimed)).toEqual({
            ok: true,
            value: 'progress',
        });
        // The first range ends on 2026-10-01, October's sample.
        expect(harness.since(mark).requests.filter((request) => request.startsWith('day:'))).toEqual([
            ...monthTables(2026, 10),
            ...monthTables(2025, 12),
            'day:en:2025-12-31',
        ]);
    });

    it("keeps 2025's complete samples when the deadline refuses its CSV, and the next run's only fill request is the CSV", async () => {
        const harness = await beforeFill(BEFORE_SPAN);
        const mark = harness.mark();
        // The check's CSV, 2026's ten tables and CSV, and 2025's thirteen tables leave too little time for its CSV.
        expect(await harness.run('2026-10-08T10:00', { remainingMs: stopsAfter(harness, 25) })).toMatchObject({
            syncResult: 'ok',
            syncDetail: 'deadline',
            checked: true,
            nbgRequests: 25,
        });
        expect(harness.since(mark).requests.slice(-2)).toEqual(['day:en:2025-12-01', 'day:en:2025-12-31']);
        expect(await harness.store.readRowsBetween(date('2025-01-01'), date('2025-12-31'), SIGNAL)).toEqual({
            ok: true,
            value: [],
        });
        const stopped = await harness.state();
        expect(stopped.rowsStart).toBe('2026-01-01');
        expect(stopped.fill).toEqual({
            rangeEnd: '2025-12-31',
            sampledThrough: '2025-12-31',
            codes: ['EUR', 'USD', 'XYZ'],
        });

        // The next run may ask the check's CSV and one more: the fill's CSV, with no table asked again.
        const next = harness.mark();
        expect(await harness.run('2026-10-08T11:00', { remainingMs: stopsAfter(harness, 2) })).toEqual(
            line({
                time: '2026-10-08T07:00:02.000Z',
                scheduledTime: '2026-10-08T07:00:00.000Z',
                syncDetail: 'deadline',
                checked: true,
                nbgRequests: 2,
                span: '2026-10-01..2026-10-09',
                rowsStart: '2025-01-01',
            }),
        );
        expect(harness.since(next).requests).toEqual([CHECK_CSV, 'range:EUR,USD,XYZ:2025-01-01:2025-12-31']);
        expect(await harness.store.readRowsBetween(date('2025-01-01'), date('2025-12-31'), SIGNAL)).toEqual({
            ok: true,
            value: archived(BEFORE_SPAN.slice(1, 4), at('2026-10-08T11:00:02')),
        });
        const filled = await harness.state();
        expect(filled.rowsStart).toBe('2025-01-01');
        expect(filled.fill).toBeUndefined();
    });

    it('fills 2025 over three runs that may each ask five of its requests, asking each sample and the CSV once', async () => {
        const harness = await beforeFill(BEFORE_SPAN, { rowsStart: date('2026-01-01') });
        const mark = harness.mark();
        const logged = harness.lines.length;
        for (let hour = 10; hour < 15 && (await harness.state()).rowsStart !== '2025-01-01'; hour += 1) {
            // The check's CSV, then five of the fill's requests.
            await harness.run(`2026-10-08T${hour}:00`, { remainingMs: stopsAfter(harness, 6) });
        }
        // XYZ is quoted from 2025-06-02, so the second run's 2025-07-01 table adds it to the first run's codes.
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            ...monthTables(2025, 5),
            CHECK_CSV,
            ...monthTables(2025, 10).slice(5),
            CHECK_CSV,
            ...monthTables(2025, 12).slice(10),
            'day:en:2025-12-31',
            'range:EUR,USD,XYZ:2025-01-01:2025-12-31',
            'day:en:2024-01-01',
        ]);
        const stoppedAt = (utcHour: string, rowsStart: string): SyncLogLine =>
            line({
                time: `2026-10-08T${utcHour}:00:02.000Z`,
                scheduledTime: `2026-10-08T${utcHour}:00:00.000Z`,
                syncDetail: 'deadline',
                checked: true,
                nbgRequests: 6,
                span: '2026-10-01..2026-10-09',
                rowsStart,
            });
        expect(harness.lines.slice(logged)).toEqual([
            stoppedAt('06', '2026-01-01'),
            stoppedAt('07', '2026-01-01'),
            stoppedAt('08', '2025-01-01'),
        ]);
        expect(await harness.store.readRowsBetween(date('2025-01-01'), date('2025-12-31'), SIGNAL)).toEqual({
            ok: true,
            value: archived(BEFORE_SPAN.slice(1, 4), at('2026-10-08T12:00:02')),
        });
        // 2025's progress is gone with its rows written; the third run's fifth request began 2024's.
        const filled = await harness.state();
        expect(filled.rowsStart).toBe('2025-01-01');
        expect(filled.fill).toEqual({ rangeEnd: '2024-12-31', sampledThrough: '2024-01-01', codes: ['EUR', 'USD'] });
    });

    it('keeps the samples to 2025-04-01 when the deadline stops it, and the next run asks from 2025-05-01 with their codes', async () => {
        // QQQ is quoted from 2025-03-01 to 2025-03-16: only the 2025-03-01 sample sees it.
        const march = [
            publication(syntheticTable('2025-03-01', { EUR: 2.9911, QQQ: 0.4321, USD: 2.7022 })),
            publication(syntheticTable('2025-03-17', { EUR: 2.9922, USD: 2.7033 })),
        ];
        const harness = await beforeFill([...BEFORE_SPAN, ...march], { rowsStart: date('2026-01-01') });
        const mark = harness.mark();
        expect(await harness.run('2026-10-08T10:00', { remainingMs: stopsAfter(harness, 5) })).toMatchObject({
            syncResult: 'ok',
            syncDetail: 'deadline',
            nbgRequests: 5,
        });
        expect(harness.since(mark).requests).toEqual([CHECK_CSV, ...monthTables(2025, 4)]);
        expect((await harness.state()).fill).toEqual({
            rangeEnd: '2025-12-31',
            sampledThrough: '2025-04-01',
            codes: ['EUR', 'QQQ', 'USD'],
        });

        // No table the next run asks quotes QQQ; the stored codes still name it in the CSV.
        const next = harness.mark();
        expect(await harness.run('2026-10-08T11:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            nbgRequests: 25,
        });
        expect(harness.since(next).requests).toEqual([
            CHECK_CSV,
            ...monthTables(2025, 12).slice(4),
            'day:en:2025-12-31',
            'range:EUR,QQQ,USD,XYZ:2025-01-01:2025-12-31',
            ...monthTables(2024, 12),
            'day:en:2024-12-31',
            'range:EUR,USD:2024-01-01:2024-12-31',
        ]);
        expect(await harness.store.readRowsBetween(date('2025-01-01'), date('2025-12-31'), SIGNAL)).toEqual({
            ok: true,
            value: archived(
                [...BEFORE_SPAN.slice(1, 2), ...march, ...BEFORE_SPAN.slice(2, 4)],
                at('2026-10-08T11:00:02'),
            ),
        });
        const filled = await harness.state();
        expect(filled.rowsStart).toBe('2024-01-01');
        expect(filled.fill).toBeUndefined();
    });

    it("writes none of a year's rows when the time left after its CSV does not cover the write", async () => {
        const harness = await beforeFill(BEFORE_SPAN);
        const mark = harness.mark();
        // 2026's CSV is the twelfth request; after it, 2,400 ms do not cover a store operation and the log line.
        expect(
            await harness.run('2026-10-08T10:00', {
                remainingMs: () => (harness.fake.requests.length - mark.requests >= 12 ? 2_400 : 25_000),
            }),
        ).toMatchObject({ syncResult: 'ok', syncDetail: 'deadline', nbgRequests: 12 });
        expect(harness.since(mark).requests.at(-1)).toBe('range:EUR,USD:2026-01-01:2026-09-30');
        expect(harness.since(mark).writes.map((write) => write.operation)).not.toContain('archive');
        expect((await harness.state()).rowsStart).toBeUndefined();
    });

    it("fails the run at a month table NBG fails, keeping the year before and writing none of this year's rows", async () => {
        const harness = await beforeFill(BEFORE_SPAN);
        const mark = harness.mark();
        expect(
            await harness.run('2026-10-08T10:00', { client: failingDays(harness, ['2025-05-01'], UNAVAILABLE) }),
        ).toMatchObject({ syncResult: 'failed', syncDetail: 'upstream_unavailable', checked: true, nbgRequests: 17 });
        expect(harness.since(mark).requests.at(-1)).toBe('day:en:2025-05-01');
        expect(await harness.store.readRowsBetween(date('2025-01-01'), date('2026-09-30'), SIGNAL)).toEqual({
            ok: true,
            value: archived(BEFORE_SPAN.slice(4), at('2026-10-08T10:00:02')),
        });
        expect((await harness.state()).rowsStart).toBe('2026-01-01');
    });

    it('keeps the two samples a run took before NBG failed the third, and fails the run with that kind', async () => {
        const harness = await beforeFill(BEFORE_SPAN, { rowsStart: date('2026-01-01') });
        const mark = harness.mark();
        expect(
            await harness.run('2026-10-08T10:00', { client: failingDays(harness, ['2025-03-01'], UNAVAILABLE) }),
        ).toMatchObject({ syncResult: 'failed', syncDetail: 'upstream_unavailable', checked: true, nbgRequests: 4 });
        expect(harness.since(mark).requests).toEqual([CHECK_CSV, ...monthTables(2025, 3)]);
        // The claim, the check's fresh-until, the slice, then the fill's progress.
        expect(harness.since(mark).writes).toEqual(
            Array.from({ length: 4 }, () => ({ operation: 'state', key: 'state/state' })),
        );
        expect((await harness.state()).fill).toEqual({
            rangeEnd: '2025-12-31',
            sampledThrough: '2025-02-01',
            codes: ['EUR', 'USD'],
        });

        const next = harness.mark();
        await harness.run('2026-10-08T11:00', { remainingMs: stopsAfter(harness, 2) });
        expect(harness.since(next).requests).toEqual([CHECK_CSV, 'day:en:2025-03-01']);
    });

    it('fails the run with the store failure when the progress write after a failed sample fails', async () => {
        const harness = await beforeFill(BEFORE_SPAN, { rowsStart: date('2026-01-01') });
        const unavailable = failingDays(harness, ['2025-03-01'], UNAVAILABLE);
        const client: NbgClient = {
            fetchDay(day, language) {
                if (day === '2025-03-01') {
                    harness.store.failWith('throttled');
                }
                return unavailable.fetchDay(day, language);
            },
            fetchRange: (codes, start, end) => unavailable.fetchRange(codes, start, end),
        };
        expect(await harness.run('2026-10-08T10:00', { client })).toMatchObject({
            syncResult: 'failed',
            syncDetail: 'store_failed',
            nbgRequests: 4,
        });
        harness.store.failWith(undefined);
        expect((await harness.state()).fill).toBeUndefined();
    });

    it("keeps 2025's complete samples when NBG fails its CSV, and the next run asks the CSV and no table of 2025", async () => {
        const harness = await beforeFill(BEFORE_SPAN, { rowsStart: date('2026-01-01') });
        const mark = harness.mark();
        expect(
            await harness.run('2026-10-08T10:00', { client: failingRanges(harness, '2025-01-01', UNAVAILABLE) }),
        ).toMatchObject({ syncResult: 'failed', syncDetail: 'upstream_unavailable', checked: true, nbgRequests: 15 });
        expect(harness.since(mark).requests.at(-1)).toBe('range:EUR,USD,XYZ:2025-01-01:2025-12-31');
        expect((await harness.state()).fill).toEqual({
            rangeEnd: '2025-12-31',
            sampledThrough: '2025-12-31',
            codes: ['EUR', 'USD', 'XYZ'],
        });

        const next = harness.mark();
        expect(await harness.run('2026-10-08T11:00')).toMatchObject({ syncResult: 'ok', syncDetail: null });
        expect(harness.since(next).requests).toEqual([
            CHECK_CSV,
            'range:EUR,USD,XYZ:2025-01-01:2025-12-31',
            ...monthTables(2024, 12),
            'day:en:2024-12-31',
            'range:EUR,USD:2024-01-01:2024-12-31',
        ]);
        // The claim and the check's fresh-until; 2025's rows before the rows' start moves over them, then 2024's.
        expect(harness.since(next).writes).toEqual([
            { operation: 'state', key: 'state/state' },
            { operation: 'state', key: 'state/state' },
            { operation: 'archive', key: 'rows/2025-01-01' },
            { operation: 'archive', key: 'rows/2025-06-02' },
            { operation: 'archive', key: 'rows/2025-08-01' },
            { operation: 'state', key: 'state/state' },
            { operation: 'archive', key: 'rows/2024-01-01' },
            { operation: 'state', key: 'state/state' },
        ]);
        const filled = await harness.state();
        expect(filled.rowsStart).toBe('2024-01-01');
        expect(filled.fill).toBeUndefined();
    });

    it('fails a year whose CSV lists no row as empty_export, writing nothing and leaving the rows start', async () => {
        // The table in force on 2026-09-30 is valid from 2026-05-04, inside 2026, but NBG's CSV lists none of its rows.
        const harness = await beforeFill([publication(syntheticTable('2025-12-31', { EUR: 3.0345, USD: 2.7222 }))]);
        harness.fake.publishJson(publication(syntheticTable('2026-05-04', { EUR: 3.0456, USD: 2.7333 })));
        const mark = harness.mark();
        expect(await harness.run('2026-10-08T10:00')).toMatchObject({
            syncResult: 'failed',
            syncDetail: 'empty_export',
            checked: true,
            nbgRequests: 12,
        });
        expect(harness.since(mark).requests.at(-1)).toBe('range:EUR,USD:2026-01-01:2026-09-30');
        expect(harness.since(mark).writes.map((write) => write.operation)).not.toContain('archive');
        const failed = await harness.state();
        expect(failed.rowsStart).toBeUndefined();
        expect(failed.fill).toBeUndefined();
    });

    it("moves the rows start over 2026-01-01 to 2026-01-08 with no CSV when a span starts at the year's first publication", async () => {
        const harness = await beforeFill(
            [
                publication(syntheticTable('2025-01-01', { EUR: 2.9876, USD: 2.7012 })),
                publication(syntheticTable('2025-12-31', { EUR: 3.0345, USD: 2.7222 })),
                publication(syntheticTable('2026-01-09', { EUR: 3.0456, USD: 2.7333 })),
            ],
            { span: { start: date('2026-01-09'), end: date('2026-10-09') } },
        );
        const mark = harness.mark();
        expect(await harness.run('2026-10-08T10:00')).toEqual(
            line({
                time: '2026-10-08T06:00:02.000Z',
                scheduledTime: '2026-10-08T06:00:00.000Z',
                checked: true,
                nbgRequests: 17,
                span: '2026-01-09..2026-10-09',
                rowsStart: '2025-01-01',
            }),
        );
        // The table in force on 2026-01-08 is valid from 2025-12-31: no publication lies in the range.
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            'day:en:2026-01-01',
            'day:en:2026-01-08',
            ...monthTables(2025, 12),
            'day:en:2025-12-31',
            'range:EUR,USD:2025-01-01:2025-12-31',
        ]);
        // The claim, the check's fresh-until and the slice; the rows' start over the empty range; then 2025.
        expect(harness.since(mark).writes).toEqual([
            { operation: 'state', key: 'state/state' },
            { operation: 'state', key: 'state/state' },
            { operation: 'state', key: 'state/state' },
            { operation: 'state', key: 'state/state' },
            { operation: 'archive', key: 'rows/2025-01-01' },
            { operation: 'archive', key: 'rows/2025-12-31' },
            { operation: 'state', key: 'state/state' },
        ]);
        const filled = await harness.state();
        expect(filled.rowsStart).toBe('2025-01-01');
        expect(filled.fill).toBeUndefined();
    });

    it('keeps no progress for a range with no publication when the deadline refuses its rows start move', async () => {
        const harness = await beforeFill([publication(syntheticTable('2025-12-31', { EUR: 3.0345, USD: 2.7222 }))], {
            span: { start: date('2026-01-09'), end: date('2026-10-09') },
        });
        const mark = harness.mark();
        // After the check's CSV and both samples, 2,400 ms do not cover a store operation and the log line.
        expect(
            await harness.run('2026-10-08T10:00', {
                remainingMs: () => (harness.fake.requests.length - mark.requests >= 3 ? 2_400 : 25_000),
            }),
        ).toMatchObject({ syncResult: 'ok', syncDetail: 'deadline', nbgRequests: 3 });
        expect(harness.since(mark).requests).toEqual([CHECK_CSV, 'day:en:2026-01-01', 'day:en:2026-01-08']);
        const stopped = await harness.state();
        expect(stopped.rowsStart).toBeUndefined();
        expect(stopped.fill).toBeUndefined();

        const next = harness.mark();
        expect(await harness.run('2026-10-08T11:00', { remainingMs: stopsAfter(harness, 3) })).toMatchObject({
            syncResult: 'ok',
            syncDetail: 'deadline',
            nbgRequests: 3,
        });
        expect(harness.since(next).requests).toEqual([CHECK_CSV, 'day:en:2026-01-01', 'day:en:2026-01-08']);
        expect((await harness.state()).rowsStart).toBe('2026-01-01');
    });

    it('fills 1995-10-14 to 1995-12-31 from rows starting 1996-01-01 and is complete, after which it asks nothing', async () => {
        const first = [
            publication(syntheticTable('1995-10-14', { USD: 1.2987 })),
            publication(syntheticTable('1995-11-15', { USD: 1.2876 })),
        ];
        const harness = await beforeFill(first, { rowsStart: date('1996-01-01') });
        const claimed = await harness.state();
        const mark = harness.mark();
        expect(await runArchiveFill(contextAt(harness, '2026-10-08T10:00'), claimed)).toEqual({
            ok: true,
            value: 'complete',
        });
        // October's sample is the range's start: NBG has no table on 1995-10-01.
        expect(harness.since(mark).requests).toEqual([
            'day:en:1995-10-14',
            'day:en:1995-11-01',
            'day:en:1995-12-01',
            'day:en:1995-12-31',
            'range:USD:1995-10-14:1995-12-31',
        ]);
        expect(await harness.store.readRowsBetween(date('1995-01-01'), date('1995-12-31'), SIGNAL)).toEqual({
            ok: true,
            value: archived(first, at('2026-10-08T10:00:02')),
        });
        const complete = await harness.state();
        expect(complete.rowsStart).toBe(NBG_ARCHIVE_START);

        const after = harness.mark();
        expect(await runArchiveFill(contextAt(harness, '2026-10-08T11:00'), complete)).toEqual({
            ok: true,
            value: 'complete',
        });
        expect(harness.since(after).requests).toEqual([]);
        expect(harness.since(after).operations).toEqual([]);
    });

    it('leaves the fresh-until of a stale mirror as it was', async () => {
        const harness = await beforeFill(BEFORE_SPAN, { freshUntil: at('2026-10-08T09:05') });
        const claimed = await harness.state();
        expect(await runArchiveFill(contextAt(harness, '2026-10-08T10:00'), claimed)).toEqual({
            ok: true,
            value: 'progress',
        });
        const filled = await harness.state();
        expect(filled.rowsStart).toBe('2025-01-01');
        expect(filled.freshUntil).toBe(at('2026-10-08T09:05'));
    });
});

describe("runSync: the hourly kind's steps", () => {
    beforeEach(() => {
        fill.real = false;
    });

    it('runs neither step after a failed check', async () => {
        const harness = await bootstrapped();
        harness.fake.failWith(UNAVAILABLE);
        const mark = harness.mark();
        expect(await harness.run('2026-10-08T11:00')).toMatchObject({
            syncResult: 'failed',
            syncDetail: 'upstream_unavailable',
            checked: false,
            nbgRequests: 1,
        });
        expect(harness.since(mark).operations).not.toContain('readTablesBetween');
        const state = await harness.state();
        expect(state.refetch).toEqual({});
        expect(state.recheck).toEqual({});
    });

    it('runs the refetch and the re-check after a failed retry of an unresolved date, failing with that retry', async () => {
        const harness = await bootstrapped();
        harness.fake.publish(publication(tableFrom('2026-09-28', 2.7123)));
        const marked = await harness.store.updateState(
            (state) => ({ next: markUnresolved(state, [date('2026-09-28')]), outcome: undefined }),
            SIGNAL,
        );
        expect(marked.ok).toBe(true);
        const mark = harness.mark();
        expect(
            await harness.run('2026-10-08T11:00', { client: failingDays(harness, ['2026-09-28'], UNAVAILABLE) }),
        ).toEqual(
            line({
                time: '2026-10-08T07:00:02.000Z',
                scheduledTime: '2026-10-08T07:00:00.000Z',
                syncResult: 'failed',
                syncDetail: 'upstream_unavailable',
                checked: true,
                nbgRequests: 12,
                span: '2026-10-01..2026-10-09',
            }),
        );
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            'day:en:2026-09-28',
            ...tableRequests(OCTOBER.map((subject) => subject.validFrom)),
        ]);
        const state = await harness.state();
        expect(state.unresolved).toEqual(['2026-09-28']);
        expect(state.refetch).toEqual({ day: '2026-10-08' });
        expect(state.recheck).toMatchObject({ lastSliceAt: at('2026-10-08T11:00'), nextYear: 2027 });
    });

    it('runs the re-check after a failed refetch, failing with the refetch and keeping its cursor', async () => {
        const harness = await bootstrapped();
        const mark = harness.mark();
        expect(
            await harness.run('2026-10-08T11:00', {
                client: failingDays(harness, ['2026-10-06'], SHAPE_CHANGED, 'en'),
            }),
        ).toMatchObject({ syncResult: 'failed', syncDetail: 'upstream_shape_changed', checked: true, nbgRequests: 8 });
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            ...tableRequests(['2026-10-01', '2026-10-02', '2026-10-03']),
            'day:en:2026-10-06',
        ]);
        const state = await harness.state();
        expect(state.refetch).toEqual({ cursor: '2026-10-06' });
        expect(state.recheck).toMatchObject({ lastSliceAt: at('2026-10-08T11:00'), nextYear: 2027 });
    });

    it("names the retry's failure when the refetch fails too", async () => {
        const harness = await bootstrapped();
        harness.fake.publish(publication(tableFrom('2026-09-28', 2.7123)));
        const marked = await harness.store.updateState(
            (state) => ({ next: markUnresolved(state, [date('2026-09-28')]), outcome: undefined }),
            SIGNAL,
        );
        expect(marked.ok).toBe(true);
        const unavailable = failingDays(harness, ['2026-09-28'], UNAVAILABLE);
        const client: NbgClient = {
            async fetchDay(day, language) {
                const answer = await unavailable.fetchDay(day, language);
                return day === '2026-10-06' ? err(SHAPE_CHANGED) : answer;
            },
            fetchRange: (codes, start, end) => unavailable.fetchRange(codes, start, end),
        };
        expect(await harness.run('2026-10-08T11:00', { client })).toMatchObject({
            syncResult: 'failed',
            syncDetail: 'upstream_unavailable',
            checked: true,
        });
        expect((await harness.state()).refetch).toEqual({ cursor: '2026-10-06' });
    });

    it("clears an unresolved date NBG withdrew from both views with its year's slice", async () => {
        const harness = await septemberSpan({ unresolved: [date('2026-09-15')] });
        harness.fake.withdraw(date('2026-09-15'));
        const mark = harness.mark();
        // The retry asks the CSV for 2026-09-15 alone, which lists nothing: never read as a removal.
        expect(await harness.run('2026-10-08T10:00')).toMatchObject({
            syncResult: 'failed',
            syncDetail: 'empty_export',
            checked: true,
            committed: 1,
            nbgRequests: 7,
        });
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            ...tableRequests(['2026-09-15']),
            `range:${CODES}:2026-09-15:2026-09-15`,
            `range:${CODES}:2026-09-01:2026-09-30`,
            ...tableRequests(['2026-09-15']),
        ]);
        expect(harness.since(mark).writes).toContainEqual({ operation: 'remove', key: 'rows/2026-09-15' });
        expect(await held(harness.store, '2026-09-15')).toBeUndefined();
        expect((await harness.state()).unresolved).toEqual([]);

        const next = harness.mark();
        expect(await harness.run('2026-10-08T11:00')).toMatchObject({
            syncResult: 'ok',
            syncDetail: null,
            nbgRequests: 1,
        });
        expect(harness.since(next).requests).toEqual([CHECK_CSV]);
    });

    it("clears an unresolved date the mirror never held, once NBG lists it nowhere, with its year's slice", async () => {
        const harness = await septemberSpan({ unresolved: [date('2026-09-16')] });
        const mark = harness.mark();
        expect(await harness.run('2026-10-08T10:00')).toMatchObject({
            syncResult: 'failed',
            syncDetail: 'empty_export',
            checked: true,
            committed: 0,
            nbgRequests: 7,
        });
        // The slice's export agrees with the mirror; the date is resolved only because it is unresolved.
        expect(harness.since(mark).requests).toEqual([
            CHECK_CSV,
            ...tableRequests(['2026-09-16']),
            `range:${CODES}:2026-09-16:2026-09-16`,
            `range:${CODES}:2026-09-01:2026-09-30`,
            ...tableRequests(['2026-09-16']),
        ]);
        expect(harness.since(mark).writes.map((write) => write.operation)).not.toContain('remove');
        expect((await harness.state()).unresolved).toEqual([]);
    });

    it('lets an older run that finishes its refetch and slice after a newer one write nothing', async () => {
        const harness = await bootstrapped();
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        // The 11:00 run waits at its English table of 2026-10-02 while the 12:00 run does both steps.
        const client: NbgClient = {
            async fetchDay(day, language) {
                if (day === '2026-10-02' && language === 'en') {
                    await gate;
                }
                return harness.fake.client.fetchDay(day, language);
            },
            fetchRange: (codes, start, end) => harness.fake.client.fetchRange(codes, start, end),
        };
        const older = harness.run('2026-10-08T11:00', { client });
        await vi.waitFor(async () => {
            expect((await harness.state()).refetch).toEqual({ cursor: '2026-10-02' });
        });

        expect(await harness.run('2026-10-08T12:00')).toMatchObject({ syncResult: 'ok', syncDetail: null });
        const newer = await harness.state();
        expect(newer.refetch).toEqual({ day: '2026-10-08' });
        expect(newer.recheck).toEqual({
            cycleStartedAt: at('2026-10-08T12:00'),
            lastSliceAt: at('2026-10-08T12:00'),
            nextYear: 2027,
        });

        const released = harness.mark();
        release();
        expect(await older).toMatchObject({ syncResult: 'ok', syncDetail: null, checked: true, committed: 0 });
        expect(harness.since(released).writes).toEqual([]);
        expect(await harness.state()).toEqual(newer);
    });
});
