import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeNbg, type FakeNbg } from '../../test/helpers/fake-nbg.js';
import { startFixtureServer } from '../../test/helpers/fixture-server.js';
import { firstMessage, post, toolCall } from '../../test/helpers/mcp-http.js';
import {
    createMemoryMirrorStore,
    seedMirror,
    type MemoryMirrorStore,
    type MemoryWrite,
} from '../../test/helpers/memory-mirror-store.js';
import { publication, syntheticTable, tableFixture } from '../../test/helpers/publications.js';
import { code, date } from '../../test/helpers/values.js';
import { addDays } from '../core/dates.js';
import type { MirrorSpan } from '../core/mirror.js';
import { tableValidFrom, type MirrorPublication } from '../core/mirror-publication.js';
import type { NbgDay } from '../core/nbg-schema.js';
import { snapshotFromDay } from '../core/normalize.js';
import { err, type CalendarDate, type CurrencyCode, type Language } from '../core/types.js';
import { createSnapshotCache, type SnapshotCache } from './cache.js';
import { createHttpHandler, type RequestLogLine } from './http.js';
import { createLookupScopes, newLookupScope, type LookupScope, type LookupScopes } from './lookup-scope.js';
import type { StoredRows } from './mirror-store.js';
import { createMirroredRatesService, PAST_TABLE_WRITE_TIMEOUT_MS } from './mirrored-rates-service.js';
import { createNbgClient, type NbgClient } from './nbg-client.js';
import type { NbgFailure } from './nbg-failure.js';
import { createRatesService, type RatesService } from './rates-service.js';

/** 10:00 in Tbilisi (UTC+4) on Thursday 2026-10-08: today is 2026-10-08 and tomorrow 2026-10-09. */
const NOW = new Date('2026-10-08T06:00:00Z');
/** 11:05 in Tbilisi: the 11:00 check plus its margin. */
const FRESH_UNTIL = Date.parse('2026-10-08T07:05:00Z');
/** 09:05 in Tbilisi: the 10:00 check has not succeeded. */
const STALE_SINCE = Date.parse('2026-10-08T05:05:00Z');
const SPAN: MirrorSpan = { start: date('2026-10-01'), end: date('2026-10-09') };
const ROWS_START = date('2024-01-01');
const UNAVAILABLE: NbgFailure = { kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' };
const SIGNAL = new AbortController().signal;
const USD = code('USD');
const EUR = code('EUR');
const XYZ = code('XYZ');

const EN_2026_10_07 = tableFixture('en', '2026-10-07');
/** The recorded publications of 2026-10-01 to 2026-10-07: 10-04 and 10-05 repeat the table valid from 10-03. */
const OCTOBER = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07'].map((day) =>
    publication(tableFixture('en', day), day === '2026-10-07' ? { ka: tableFixture('ka', day) } : {}),
);
/** Archive publications: the mirror holds their rows only. 2024-03-16 is a Saturday, 2024-03-18 the Monday after. */
const MARCH_15 = publication(syntheticTable('2024-03-15', { USD: 2.6512, EUR: 2.8811 }));
const MARCH_16 = publication(syntheticTable('2024-03-16', { USD: 2.6534, EUR: 2.8842 }));
/** NBG's table before the archive rows start, so the live path has an answer that rule 7 must not keep. */
const DECEMBER_29 = publication(syntheticTable('2023-12-29', { USD: 2.6894, EUR: 2.9743 }));
const NBG: ReadonlyArray<MirrorPublication> = [...OCTOBER, MARCH_15, MARCH_16, DECEMBER_29];

function archiveItem(subject: MirrorPublication): StoredRows {
    return { validFrom: subject.validFrom, rows: subject.rows, observedAt: subject.observedAt };
}

/** A table for each of `count` consecutive days from `first`, with USD and EUR rates that differ per day. */
function consecutivePublications(first: string, count: number): ReadonlyArray<MirrorPublication> {
    return Array.from({ length: count }, (_, index) =>
        publication(
            syntheticTable(addDays(date(first), index), {
                USD: Number((2.6 + index / 1000).toFixed(4)),
                EUR: Number((3 + index / 1000).toFixed(4)),
            }),
        ),
    );
}

/** The service's calls to `service`, listed as `<name>.<method>` in `asked`. */
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

interface Options {
    readonly now?: Date;
    readonly freshUntil?: number;
    readonly span?: MirrorSpan;
    /** Committed with both tables and their rows; default OCTOBER. */
    readonly publications?: ReadonlyArray<MirrorPublication>;
    /** Stored as rows only; default MARCH_15 and MARCH_16. */
    readonly archive?: ReadonlyArray<MirrorPublication>;
    /** Past tables written before the service runs. */
    readonly pastTables?: ReadonlyArray<{ readonly language: Language; readonly day: NbgDay }>;
    /** What the fake NBG holds; default NBG. */
    readonly nbg?: ReadonlyArray<MirrorPublication>;
    /** The client behind shortLive; default the fake's. */
    readonly shortClient?: NbgClient;
    readonly readTimeoutMs?: number;
    /** The state's unresolved dates; default none. */
    readonly unresolved?: ReadonlyArray<CalendarDate>;
}

interface Fixture {
    readonly now: Date;
    readonly store: MemoryMirrorStore;
    readonly fake: FakeNbg;
    readonly cache: SnapshotCache;
    /** The live service the mirror wraps, uncounted, to fill the instance cache. */
    readonly live: RatesService;
    readonly scopes: LookupScopes;
    readonly service: RatesService;
    /** Today's live path over its own copy of NBG and its own cache: what the mirror's answers must equal. */
    readonly reference: RatesService;
    /** The services the mirror asked, in order: `live.getSnapshot`, `shortLive.getHistory`, ... */
    readonly asked: ReadonlyArray<string>;
    /** Every store operation after seeding, in order. */
    readonly operations: ReadonlyArray<string>;
    /** Also runs before each store operation, after it is listed. */
    onOperation(hook: ((operation: string) => Promise<void> | void) | undefined): void;
    /** Waits `ms`, or until the test ends, so a hanging hook leaves no timer behind. */
    wait(ms: number): Promise<void>;
    /** The writes since seeding, or since the last markSeeded. */
    writesSinceSeed(): ReadonlyArray<MemoryWrite>;
    /** Counts the writes so far as the test's own seeding. */
    markSeeded(): void;
}

/** Every fixture of the running test, checked and released after it. */
const opened: Array<{ readonly fixture: Fixture; readonly release: () => void }> = [];

afterEach(() => {
    const finished = opened.splice(0);
    for (const { release } of finished) {
        release();
    }
    // A request writes nothing but rule 7's past tables.
    for (const { fixture } of finished) {
        expect(fixture.writesSinceSeed().filter((write) => write.operation !== 'fill')).toEqual([]);
    }
});

async function setUp(options: Options = {}): Promise<Fixture> {
    const now = options.now ?? NOW;
    const clock = (): Date => now;
    const store = createMemoryMirrorStore();
    await seedMirror(store, {
        publications: options.publications ?? OCTOBER,
        archiveRows: (options.archive ?? [MARCH_15, MARCH_16]).map(archiveItem),
        state: {
            span: options.span ?? SPAN,
            rowsStart: ROWS_START,
            freshUntil: options.freshUntil ?? FRESH_UNTIL,
            unresolved: options.unresolved ?? [],
        },
    });
    for (const { language, day } of options.pastTables ?? []) {
        const filled = await store.fillPastTable(tableValidFrom(day), language, day, SIGNAL);
        if (!filled.ok || filled.value !== 'written') {
            throw new Error(`seeding a past table failed: ${JSON.stringify(filled)}`);
        }
    }
    let seeded = store.writes.length;
    const operations: string[] = [];
    let hook: ((operation: string) => Promise<void> | void) | undefined;
    store.before((operation) => {
        operations.push(operation);
        return hook?.(operation);
    });
    const released = new AbortController();
    const fake = createFakeNbg(options.nbg ?? NBG);
    const cache = createSnapshotCache();
    const live = createRatesService({ client: fake.client, cache, now: clock });
    const shortLive = createRatesService({ client: options.shortClient ?? fake.client, cache, now: clock });
    const asked: string[] = [];
    const scopes = createLookupScopes();
    const service = createMirroredRatesService({
        mirror: store,
        live: counted('live', live, asked),
        shortLive: counted('shortLive', shortLive, asked),
        scopes,
        now: clock,
        ...(options.readTimeoutMs === undefined ? {} : { readTimeoutMs: options.readTimeoutMs }),
    });
    const reference = createRatesService({
        client: createFakeNbg(options.nbg ?? NBG).client,
        cache: createSnapshotCache(),
        now: clock,
    });
    const fixture: Fixture = {
        now,
        store,
        fake,
        cache,
        live,
        scopes,
        service,
        reference,
        asked,
        operations,
        onOperation(next) {
            hook = next;
        },
        wait(ms) {
            return delay(ms, undefined, { signal: released.signal }).catch(() => undefined);
        },
        writesSinceSeed() {
            return store.writes.slice(seeded);
        },
        markSeeded() {
            seeded = store.writes.length;
        },
    };
    opened.push({ fixture, release: () => released.abort() });
    return fixture;
}

function snapshotArgs(
    day: string,
    language: Language = 'en',
    codes?: ReadonlyArray<CurrencyCode>,
): { date: CalendarDate; language: Language; codes?: ReadonlyArray<CurrencyCode> } {
    return { date: date(day), language, ...(codes === undefined ? {} : { codes }) };
}

function fills(fixture: Fixture): number {
    return fixture.operations.filter((operation) => operation === 'fill').length;
}

describe('createMirroredRatesService from a fresh mirror', () => {
    it.each<[Language, ReadonlyArray<CurrencyCode> | undefined]>([
        ['en', undefined],
        ['ka', undefined],
        ['en', [USD, EUR, XYZ]],
        ['ka', [USD, EUR, XYZ]],
    ])('answers 2026-10-05 in %s as the live path does, without asking NBG (codes %j)', async (language, codes) => {
        const fixture = await setUp();
        const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-05', language, codes));
        expect(answer.ok).toBe(true);
        expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2026-10-05', language, codes)));
        expect(fixture.fake.requests).toEqual([]);
        expect(fixture.asked).toEqual([]);
    });

    it.each([
        ['2026-10-01', '2026-10-07', 'ok'],
        ['2024-03-01', '2024-03-31', 'no_data_for_date'],
        ['2024-03-15', '2024-03-31', 'ok'],
    ])('answers a USD history of %s..%s as the live path does (%s), without asking NBG', async (from, to, kind) => {
        const fixture = await setUp();
        const args = { currency: USD, from: date(from), to: date(to) };
        const answer = await fixture.service.getHistory(args);
        expect(answer.ok ? 'ok' : answer.error.kind).toBe(kind);
        expect(answer).toEqual(await fixture.reference.getHistory(args));
        expect(fixture.fake.requests).toEqual([]);
        expect(fixture.asked).toEqual([]);
    });

    it('answers tomorrow without its table as not published, without asking NBG', async () => {
        const fixture = await setUp();
        const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-09'));
        expect(answer).toEqual(
            err({
                kind: 'rate_not_published',
                date: date('2026-10-09'),
                latestEffectiveDate: date('2026-10-07'),
                today: date('2026-10-08'),
            }),
        );
        expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2026-10-09')));
        expect(fixture.fake.requests).toEqual([]);
    });

    it('rejects a date after tomorrow as the live path does, before reading the mirror', async () => {
        const fixture = await setUp();
        const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-10'));
        expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2026-10-10')));
        expect(fixture.operations).toEqual([]);
        expect(fixture.fake.requests).toEqual([]);
    });
});

describe('createMirroredRatesService for a past date (rule 7)', () => {
    it('asks NBG once for a past date without its table, answers as the live path, and keeps the table alone', async () => {
        const fixture = await setUp();
        const answer = await fixture.service.getSnapshot(snapshotArgs('2024-03-16'));
        expect(answer.ok).toBe(true);
        expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2024-03-16')));
        expect(fixture.fake.requests).toEqual(['day:en:2024-03-16']);
        expect(fixture.writesSinceSeed()).toEqual([{ operation: 'fill', key: 'table#en/2024-03-16' }]);
        const item = fixture.store.rawItem('table#en', '2024-03-16');
        expect(Object.keys(item ?? {}).sort()).toEqual(['day', 'pk', 'sk']);
        expect(JSON.parse(String(item?.['day']))).toEqual(MARCH_16.en);
    });

    it('answers a later date of a kept publication from the mirror, and asks NBG for the other language', async () => {
        const fixture = await setUp();
        await fixture.service.getSnapshot(snapshotArgs('2024-03-16'));
        const monday = await fixture.service.getSnapshot(snapshotArgs('2024-03-18'));
        expect(monday.ok && monday.value.effectiveDate).toBe('2024-03-16');
        expect(monday).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2024-03-18')));
        expect(fixture.fake.requests).toEqual(['day:en:2024-03-16']);

        const georgian = await fixture.service.getSnapshot(snapshotArgs('2024-03-18', 'ka'));
        expect(georgian).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2024-03-18', 'ka')));
        expect(fixture.fake.requests).toEqual(['day:en:2024-03-16', 'day:ka:2024-03-18']);
        expect(fixture.writesSinceSeed()).toEqual([
            { operation: 'fill', key: 'table#en/2024-03-16' },
            { operation: 'fill', key: 'table#ka/2024-03-16' },
        ]);
        expect(JSON.parse(String(fixture.store.rawItem('table#ka', '2024-03-16')?.['day']))).toEqual(MARCH_16.ka);
    });

    describe('writes nothing when', () => {
        it('NBG answers with a table valid from another day than the rows in force (Review Focus 2)', async () => {
            const fixture = await setUp();
            fixture.fake.withdraw(date('2024-03-16')); // NBG now answers 2024-03-16 with the 2024-03-15 table
            const answer = await fixture.service.getSnapshot(snapshotArgs('2024-03-16'));
            expect(answer.ok && answer.value.effectiveDate).toBe('2024-03-15');
            expect(fills(fixture)).toBe(0);
        });

        it("the table's USD rate differs from the stored rows", async () => {
            const fixture = await setUp();
            fixture.fake.publish(publication(syntheticTable('2024-03-16', { USD: 2.6599, EUR: 2.8842 })));
            const answer = await fixture.service.getSnapshot(snapshotArgs('2024-03-16', 'en', [USD]));
            expect(answer.ok && answer.value.rates.map((entry) => entry.rate)).toEqual([2.6599]);
            expect(fills(fixture)).toBe(0);
        });

        it('the answer came from the instance cache', async () => {
            const fixture = await setUp();
            await fixture.live.getSnapshot(snapshotArgs('2024-03-16'));
            const answer = await fixture.service.getSnapshot(snapshotArgs('2024-03-16'));
            expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2024-03-16')));
            expect(fixture.asked).toEqual(['live.getSnapshot']);
            expect(fixture.fake.requests).toEqual(['day:en:2024-03-16']);
            expect(fills(fixture)).toBe(0);
        });

        it('NBG fails', async () => {
            const fixture = await setUp();
            fixture.fake.failWith(UNAVAILABLE);
            const scope = newLookupScope();
            const answer = await fixture.scopes.run(scope, () =>
                fixture.service.getSnapshot(snapshotArgs('2024-03-16')),
            );
            expect(answer).toEqual(err(UNAVAILABLE));
            expect(scope.failure).toEqual(UNAVAILABLE);
            expect(fills(fixture)).toBe(0);
        });

        it('the store fails its reads after finding the rows', async () => {
            const fixture = await setUp({ readTimeoutMs: 50 });
            fixture.onOperation((operation) => (operation === 'readTable' ? fixture.wait(60_000) : undefined));
            const answer = await fixture.service.getSnapshot(snapshotArgs('2024-03-16'));
            expect(answer.ok).toBe(true);
            expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2024-03-16')));
            expect(fixture.operations).toEqual(['readState', 'readRowsInForce', 'readTable']);
            expect(fixture.fake.requests).toEqual(['day:en:2024-03-16']);
        });

        it('the date is in the span', async () => {
            const fixture = await setUp({ freshUntil: STALE_SINCE });
            const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-07'));
            expect(answer.ok).toBe(true);
            expect(fixture.fake.requests).toEqual(['day:en:2026-10-07']);
            expect(fills(fixture)).toBe(0);
        });

        it('the request is a history', async () => {
            const fixture = await setUp();
            const args = { currency: USD, from: date('2024-01-10'), to: date('2024-01-20') };
            const answer = await fixture.service.getHistory(args);
            expect(answer.ok).toBe(true);
            expect(answer).toEqual(await fixture.reference.getHistory(args));
            expect(fixture.fake.requests).toEqual(['range:USD:2023-12-10:2024-01-20']);
            expect(fills(fixture)).toBe(0);
        });

        it('the date is before the rows start, even with rows stored for it', async () => {
            const fixture = await setUp({ archive: [DECEMBER_29, MARCH_15, MARCH_16] });
            const answer = await fixture.service.getSnapshot(snapshotArgs('2023-12-29'));
            expect(answer.ok).toBe(true);
            expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2023-12-29')));
            expect(fixture.fake.requests).toEqual(['day:en:2023-12-29']);
            expect(fills(fixture)).toBe(0);
        });
    });

    it('answers within the write bound when the write hangs, and writes nothing more in that request', async () => {
        const fixture = await setUp();
        fixture.onOperation((operation) => (operation === 'fill' ? fixture.wait(60_000) : undefined));
        const scope = newLookupScope();
        const started = performance.now();
        const first = await fixture.scopes.run(scope, () => fixture.service.getSnapshot(snapshotArgs('2024-03-16')));
        expect(performance.now() - started).toBeLessThan(PAST_TABLE_WRITE_TIMEOUT_MS + 100);
        expect(first).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2024-03-16')));
        expect(scope.fillStopped).toBe(true);

        const second = await fixture.scopes.run(scope, () => fixture.service.getSnapshot(snapshotArgs('2024-03-15')));
        expect(second).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2024-03-15')));
        expect(fixture.fake.requests).toEqual(['day:en:2024-03-16', 'day:en:2024-03-15']);
        expect(fills(fixture)).toBe(1);
        expect(fixture.writesSinceSeed()).toEqual([]);
    });
});

describe('createMirroredRatesService from a stale mirror', () => {
    it("makes the short attempt and answers NBG's newer rate", async () => {
        const fixture = await setUp({ freshUntil: STALE_SINCE });
        fixture.fake.publish(publication(syntheticTable('2026-10-07', { USD: 2.7, EUR: 3.1 })));
        const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-07', 'en', [USD]));
        expect(answer.ok && answer.value.rates.map((entry) => entry.rate)).toEqual([2.7]);
        expect(fixture.asked).toEqual(['shortLive.getSnapshot']);
        expect(fixture.fake.requests).toEqual(['day:en:2026-10-07']);
    });

    it("answers the mirror's rate for a stored publication and a stored past table, and records the failure", async () => {
        const fixture = await setUp({ freshUntil: STALE_SINCE, pastTables: [{ language: 'en', day: MARCH_16.en }] });
        fixture.fake.failWith(UNAVAILABLE);
        for (const day of ['2026-10-07', '2024-03-16']) {
            const scope = newLookupScope();
            const answer = await fixture.scopes.run(scope, () => fixture.service.getSnapshot(snapshotArgs(day)));
            expect(answer.ok).toBe(true);
            expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs(day)));
            expect(scope.failure).toEqual(UNAVAILABLE);
        }
        expect(fixture.asked).toEqual(['shortLive.getSnapshot', 'shortLive.getSnapshot']);
    });

    it("answers the mirror's history series and records the failure", async () => {
        const fixture = await setUp({ freshUntil: STALE_SINCE });
        fixture.fake.failWith(UNAVAILABLE);
        const args = { currency: USD, from: date('2026-10-01'), to: date('2026-10-07') };
        const scope = newLookupScope();
        const answer = await fixture.scopes.run(scope, () => fixture.service.getHistory(args));
        expect(answer.ok).toBe(true);
        expect(answer).toEqual(await fixture.reference.getHistory(args));
        expect(scope.failure).toEqual(UNAVAILABLE);
        expect(fixture.asked).toEqual(['shortLive.getHistory']);
    });

    it('returns the failure where the mirror holds no rate: not published, or an unknown currency', async () => {
        const fixture = await setUp({ freshUntil: STALE_SINCE });
        fixture.fake.failWith(UNAVAILABLE);
        const tomorrowScope = newLookupScope();
        const tomorrow = await fixture.scopes.run(tomorrowScope, () =>
            fixture.service.getSnapshot(snapshotArgs('2026-10-09')),
        );
        expect(tomorrow).toEqual(err(UNAVAILABLE));
        expect(tomorrowScope.failure).toEqual(UNAVAILABLE);

        const historyScope = newLookupScope();
        const history = await fixture.scopes.run(historyScope, () =>
            fixture.service.getHistory({ currency: code('XXX'), from: date('2026-10-01'), to: date('2026-10-07') }),
        );
        expect(history).toEqual(err(UNAVAILABLE));
        expect(historyScope.failure).toEqual(UNAVAILABLE);
        expect(fixture.asked).toEqual(['live.getSnapshot', 'live.getHistory']);
    });

    it("skips an instance cache entry older than the mirror's observation of the same publication", async () => {
        const observedAt0930 = publication(syntheticTable('2026-10-07', { USD: 2.7, EUR: 3.1 }), {
            observedAt: Date.parse('2026-10-08T05:30:00Z'),
        });
        const fixture = await setUp({
            freshUntil: STALE_SINCE,
            publications: [...OCTOBER.filter((subject) => subject.validFrom !== '2026-10-07'), observedAt0930],
        });
        const cached = snapshotFromDay(EN_2026_10_07, date('2026-10-07'), date('2026-10-08'));
        if (!cached.ok) {
            throw new Error('the recorded 2026-10-07 table does not answer 2026-10-07');
        }
        expect(cached.value.rates.find((entry) => entry.code === 'USD')?.rate).toBe(2.6025);
        fixture.cache.set('en', date('2026-10-07'), cached.value, new Date('2026-10-08T05:00:00Z'));
        fixture.fake.failWith(UNAVAILABLE);
        const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-07', 'en', [USD]));
        expect(answer.ok && answer.value.rates.map((entry) => entry.rate)).toEqual([2.7]);
        expect(fixture.fake.requests).toEqual(['day:en:2026-10-07']);
    });

    it('takes the live path when the store fails', async () => {
        const fixture = await setUp();
        fixture.store.failWith('down');
        const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-07'));
        expect(answer.ok).toBe(true);
        expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2026-10-07')));
        expect(fixture.asked).toEqual(['live.getSnapshot']);
        expect(fixture.fake.requests).toEqual(['day:en:2026-10-07']);
    });

    it('takes the live path within a second when the reads outlast their bound', async () => {
        const fixture = await setUp({ readTimeoutMs: 50 });
        fixture.onOperation((operation) => (operation.startsWith('read') ? fixture.wait(5_000) : undefined));
        const started = performance.now();
        const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-07'));
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2026-10-07')));
        expect(fixture.asked).toEqual(['live.getSnapshot']);
    });
});

describe('createMirroredRatesService after a failure in the same request', () => {
    async function staleAnswers(
        fixture: Fixture,
        ask: (args: ReturnType<typeof snapshotArgs>) => ReturnType<RatesService['getSnapshot']>,
    ): Promise<void> {
        const stale = await ask(snapshotArgs('2026-10-07'));
        expect(stale.ok).toBe(true);
        expect(stale).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2026-10-07')));
        expect(await ask(snapshotArgs('2024-03-16'))).toEqual(err(UNAVAILABLE));
        expect(fixture.fake.requests).toEqual([]);
        expect(fixture.asked).toEqual([]);
    }

    it('answers a stale rate from the mirror and fails a past date without its table, without asking NBG', async () => {
        const fixture = await setUp({ freshUntil: STALE_SINCE });
        const scope: LookupScope = { failure: UNAVAILABLE, fillStopped: false };
        await fixture.scopes.run(scope, () => staleAnswers(fixture, (args) => fixture.service.getSnapshot(args)));
    });

    it('does the same with withoutNbg outside any scope', async () => {
        const fixture = await setUp({ freshUntil: STALE_SINCE });
        await staleAnswers(fixture, (args) => fixture.service.getSnapshot({ ...args, withoutNbg: UNAVAILABLE }));
    });

    it("checks a history's range first, then answers a stale series and fails an uncovered one", async () => {
        const fixture = await setUp({ freshUntil: STALE_SINCE });
        const scope: LookupScope = { failure: UNAVAILABLE, fillStopped: false };
        await fixture.scopes.run(scope, async () => {
            const tooLong = await fixture.service.getHistory({
                currency: USD,
                from: date('2024-01-01'),
                to: date('2026-01-01'),
            });
            expect(tooLong.ok === false && tooLong.error.kind).toBe('range_too_long');
            const covered = { currency: USD, from: date('2026-10-01'), to: date('2026-10-07') };
            const series = await fixture.service.getHistory(covered);
            expect(series.ok).toBe(true);
            expect(series).toEqual(await fixture.reference.getHistory(covered));
            const beforeRows = { currency: USD, from: date('2024-01-10'), to: date('2024-01-20') };
            expect(await fixture.service.getHistory(beforeRows)).toEqual(err(UNAVAILABLE));
        });
        expect(fixture.fake.requests).toEqual([]);
        expect(fixture.asked).toEqual([]);
    });
});

describe('createMirroredRatesService reader order (Review Focus 1)', () => {
    it('decides from the state it read first, so a commit between its reads cannot answer an older table', async () => {
        // 10:00 in Tbilisi on Saturday 2026-10-10: 2026-10-10 is today. The mirror is fresh but its span ends 10-09.
        const later = ['2026-10-08', '2026-10-09', '2026-10-10'].map((day, index) =>
            publication(syntheticTable(day, { USD: 2.61 + index / 100, EUR: 3.02 })),
        );
        const fixture = await setUp({
            now: new Date('2026-10-10T06:00:00Z'),
            freshUntil: Date.parse('2026-10-10T07:05:00Z'),
            nbg: [...NBG, ...later],
        });
        let operations = 0;
        fixture.onOperation(async () => {
            operations += 1;
            if (operations === 2) {
                // A catch-up commits the publications and extends the span after the request's first read.
                await seedMirror(fixture.store, {
                    publications: later,
                    state: { span: { start: SPAN.start, end: date('2026-10-11') } },
                });
                fixture.markSeeded();
            }
        });
        const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-10'));
        expect(answer.ok && answer.value.effectiveDate).toBe('2026-10-10');
        expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2026-10-10')));
        expect(fixture.fake.requests).toEqual(['day:en:2026-10-10']);
    });
});

describe('createMirroredRatesService over an unresolved date', () => {
    /** Tomorrow's table, which NBG's JSON shows while its CSV does not, so the window left 2026-10-09 unresolved. */
    const OCTOBER_9 = publication(syntheticTable('2026-10-09', { USD: 2.6013, EUR: 3.0222 }));

    it("asks NBG for tomorrow while it is unresolved, before reading a table, and answers NBG's new table", async () => {
        const fixture = await setUp({ unresolved: [date('2026-10-09')], nbg: [...NBG, OCTOBER_9] });
        const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-09'));
        expect(answer.ok && answer.value.effectiveDate).toBe('2026-10-09');
        expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2026-10-09')));
        expect(fixture.operations).toEqual(['readState', 'readRowsInForce']);
        expect(fixture.asked).toEqual(['live.getSnapshot']);
        expect(fixture.fake.requests).toEqual(['day:en:2026-10-09']);
    });

    it('asks NBG for a date whose publication in force is unresolved', async () => {
        const fixture = await setUp({ unresolved: [date('2026-10-07')] });
        const answer = await fixture.service.getSnapshot(snapshotArgs('2026-10-08'));
        expect(answer.ok && answer.value.effectiveDate).toBe('2026-10-07');
        expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2026-10-08')));
        expect(fixture.asked).toEqual(['live.getSnapshot']);
        expect(fixture.fake.requests).toEqual(['day:en:2026-10-08']);
    });

    it('writes no past table for a past date whose publication in force is unresolved', async () => {
        const fixture = await setUp({ unresolved: [date('2024-03-16')] });
        const answer = await fixture.service.getSnapshot(snapshotArgs('2024-03-18'));
        expect(answer.ok && answer.value.effectiveDate).toBe('2024-03-16');
        expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs('2024-03-18')));
        expect(fixture.fake.requests).toEqual(['day:en:2024-03-18']);
        expect(fills(fixture)).toBe(0);
    });

    it('answers from the mirror when no unresolved date lies from the publication in force to the date', async () => {
        const fixture = await setUp({ unresolved: [date('2026-10-06'), date('2026-10-09')] });
        for (const day of ['2026-10-07', '2026-10-08']) {
            const answer = await fixture.service.getSnapshot(snapshotArgs(day));
            expect(answer.ok).toBe(true);
            expect(answer).toEqual(await fixture.reference.getSnapshot(snapshotArgs(day)));
        }
        expect(fixture.asked).toEqual([]);
        expect(fixture.fake.requests).toEqual([]);
    });
});

describe('createMirroredRatesService behind createHttpHandler', () => {
    function handlerOver(fixture: Fixture): {
        readonly handler: (request: Request) => Promise<Response>;
        readonly lines: ReadonlyArray<RequestLogLine>;
    } {
        const lines: RequestLogLine[] = [];
        const handler = createHttpHandler({
            service: fixture.service,
            now: () => fixture.now,
            version: '0.0.0-test',
            allowedHosts: [],
            openAiChallenge: '',
            serverIcons: [],
            log: (line) => lines.push(line),
            lookupScopes: fixture.scopes,
        });
        return { handler, lines };
    }

    it('answers nbg_convert from a stale mirror while NBG fails, and logs the failure', async () => {
        const fixture = await setUp({ freshUntil: STALE_SINCE });
        fixture.fake.failWith(UNAVAILABLE);
        const { handler, lines } = handlerOver(fixture);
        const response = await handler(
            post(toolCall('nbg_convert', { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-07' })),
        );
        expect(await firstMessage(response)).toMatchObject({ result: { structuredContent: { resultRounded: 26.03 } } });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ tool: 'nbg_convert', outcome: 'ok', nbgError: 'upstream_unavailable' });
    });

    it('converts 100 items over 30 stale dates with one short attempt on a hanging NBG', async () => {
        const server = await startFixtureServer();
        try {
            server.setResponder(() => ({ status: 200, body: '[]', delayMs: 60_000 }));
            const thirty = consecutivePublications('2026-09-08', 30);
            const fixture = await setUp({
                freshUntil: STALE_SINCE,
                publications: thirty,
                archive: [],
                span: { start: date('2026-09-08'), end: date('2026-10-09') },
                shortClient: createNbgClient({
                    baseUrl: server.baseUrl,
                    userAgent: 'test',
                    timeoutMs: 3_000,
                    retry: false,
                }),
            });
            const { handler, lines } = handlerOver(fixture);
            const items = Array.from({ length: 100 }, (_, index) => ({
                amount: index + 1,
                from: 'USD',
                to: 'GEL',
                date: thirty[index % thirty.length]?.validFrom,
            }));
            const started = performance.now();
            const response = await handler(post(toolCall('nbg_convert_many', { items })));
            expect(await firstMessage(response)).toMatchObject({
                result: { structuredContent: { converted: 100, skipped: 0 } },
            });
            expect(performance.now() - started).toBeLessThan(10_000);
            expect(server.requests).toHaveLength(1);
            expect(fixture.fake.requests).toEqual([]);
            expect(lines[0]).toMatchObject({ tool: 'nbg_convert_many', nbgError: 'upstream_unavailable' });
        } finally {
            await server.close();
        }
    });

    it('converts 30 past dates without tables from NBG with one write attempt when every write hangs', async () => {
        const april = consecutivePublications('2024-04-01', 30);
        const fixture = await setUp({ archive: [MARCH_15, MARCH_16, ...april], nbg: [...NBG, ...april] });
        fixture.onOperation((operation) => (operation === 'fill' ? fixture.wait(60_000) : undefined));
        const { handler } = handlerOver(fixture);
        const items = april.map((subject) => ({ amount: 100, from: 'USD', to: 'GEL', date: subject.validFrom }));
        const started = performance.now();
        const response = await handler(post(toolCall('nbg_convert_many', { items })));
        expect(await firstMessage(response)).toMatchObject({
            result: { structuredContent: { converted: 30, skipped: 0 } },
        });
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(fixture.fake.requests).toHaveLength(30);
        expect(fills(fixture)).toBe(1);
    });

    it("answers 50 concurrent nbg_get_rates for today and tomorrow from a fresh mirror, before and after tomorrow's publication", async () => {
        const fixture = await setUp();
        const { handler } = handlerOver(fixture);
        const today = '2026-10-08';
        const tomorrow = '2026-10-09';
        /** Each call's day and first message, from 50 calls in flight at once. */
        function burst(): Promise<ReadonlyArray<readonly [string, Record<string, unknown>]>> {
            return Promise.all(
                Array.from({ length: 50 }, async (_, index) => {
                    const day = index % 2 === 0 ? today : tomorrow;
                    const response = await handler(post(toolCall('nbg_get_rates', { date: day, currencies: ['USD'] })));
                    return [day, await firstMessage(response)] as const;
                }),
            );
        }
        const carriedFrom = (effectiveDate: string) => ({ result: { structuredContent: { effectiveDate } } });

        for (const [day, message] of await burst()) {
            expect(message).toMatchObject(day === today ? carriedFrom('2026-10-07') : { result: { isError: true } });
        }

        await seedMirror(fixture.store, {
            publications: [publication(syntheticTable(tomorrow, { USD: 2.6111, EUR: 3.0222 }))],
        });
        fixture.markSeeded();
        for (const [day, message] of await burst()) {
            expect(message).toMatchObject(carriedFrom(day === today ? '2026-10-07' : tomorrow));
        }
        expect(fixture.fake.requests).toEqual([]);
    });
});
