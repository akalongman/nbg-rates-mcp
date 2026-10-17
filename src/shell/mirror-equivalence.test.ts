import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { publication, syntheticTable, tableFixture } from '../../test/helpers/publications.js';
import {
    at,
    expectedHeld,
    held,
    mirroredService,
    OCTOBER,
    setUp,
    tableFrom,
    tbilisi,
    type Harness,
} from '../../test/helpers/sync-harness.js';
import { code, date } from '../../test/helpers/values.js';
import { addDays, NBG_ARCHIVE_START } from '../core/dates.js';
import { isFresh, isPastDate } from '../core/mirror.js';
import type { MirrorPublication } from '../core/mirror-publication.js';
import { isWindowMinute } from '../core/sync-schedule.js';
import type { RatesError } from '../core/types.js';
import { createSnapshotCache } from './cache.js';
import { createRatesService, type RatesService } from './rates-service.js';
import { createServer, describeError } from './server.js';
import type { SyncLogLine } from './sync.js';
import { rateHistoryOutput } from './tool-schemas.js';

// The mirror is built by runSync alone, from an hourly bootstrap at 00:00 on Thursday 2026-10-08, over a fake NBG.
// Every case asks a server over the mirrored service and one over today's live path, on the same fake, the same calls.

/** The days from `first` to `last`, both included. */
function daysFrom(first: string, last: string): ReadonlyArray<string> {
    const days: string[] = [];
    for (let day = date(first); day <= last; day = addDays(day, 1)) {
        days.push(day);
    }
    return days;
}

/** NBG's table valid from `day` quoting `rates`, with its Georgian twin and its CSV rows. */
function nbgTable(day: string, rates: Readonly<Record<string, number>>, writtenAt?: string): MirrorPublication {
    return publication(syntheticTable(day, rates, writtenAt === undefined ? {} : { writtenAt }));
}

function rate(base: number, step: number): number {
    return Number((base + step / 1000).toFixed(4));
}

/** NBG's first tables, USD only; before September 2021 every calendar day has a table of its own. */
const FIRST_TABLES = daysFrom('1995-10-14', '1995-10-16').map((day, index) => nbgTable(day, { USD: rate(1.3, index) }));
/** AZN's tables around NBG's CSV filter gap: the JSON quotes AZN in 2006 and 2007, the export drops it there. */
const AZN_TABLES = [
    nbgTable('2006-06-01', { AZN: 1.9512, EUR: 2.3123, USD: 1.8101 }),
    nbgTable('2007-12-28', { AZN: 1.8765, EUR: 2.3456, USD: 1.5912 }),
    nbgTable('2008-01-02', { AZN: 1.8801, EUR: 2.3501, USD: 1.5925 }),
];
/** The September 2021 changeover: a table every day to Saturday 2021-09-11, then one each business day. */
const CHANGEOVER = [...daysFrom('2021-09-01', '2021-09-11'), ...daysFrom('2021-09-13', '2021-09-17')].map(
    (day, index) => nbgTable(day, { EUR: rate(3.6912, index), USD: rate(3.1101, index) }),
);
/** Friday 2024-03-15 and Saturday 2024-03-16, whose table Monday 2024-03-18 carries. */
const MARCH_2024 = [
    nbgTable('2024-03-15', { EUR: 2.8811, USD: 2.6512 }),
    nbgTable('2024-03-16', { EUR: 2.8842, USD: 2.6534 }),
];
/** BGN's last two tables, then the first after the New Year holidays, which no longer quotes it. */
const NEW_YEAR = [
    nbgTable('2025-12-30', { BGN: 1.6227, EUR: 3.1712, USD: 2.6951 }),
    nbgTable('2025-12-31', { BGN: 1.6227, EUR: 3.1735, USD: 2.6951 }),
    nbgTable('2026-01-03', { EUR: 3.1801, USD: 2.6963 }),
];
/** Friday 2026-09-25's table, and Saturday's, which NBG wrote on Monday 2026-09-28 at 17:01. */
const LATE_SATURDAY = [
    nbgTable('2026-09-25', { EUR: 3.0712, USD: 2.6218 }),
    nbgTable('2026-09-26', { EUR: 3.0655, USD: 2.608 }, '2026-09-28T17:01:00.000Z'),
];
const CASE_TABLES: ReadonlyArray<MirrorPublication> = [
    ...FIRST_TABLES,
    publication(tableFixture('en', '2005-03-15')),
    ...AZN_TABLES,
    ...CHANGEOVER,
    ...MARCH_2024,
    ...NEW_YEAR,
    ...LATE_SATURDAY,
    ...OCTOBER,
];
/**
 * A table on 1 June of each year the tables above leave empty. NBG has tables in every year, and the archive fill's
 * one CSV request per year fails the run when it lists no row (empty_export).
 */
const YEAR_FILLERS = Array.from({ length: 2026 - 1996 }, (_, index) => 1996 + index)
    .filter((year) => !CASE_TABLES.some((subject) => subject.validFrom.startsWith(`${year}-`)))
    .map((year) => nbgTable(`${year}-06-01`, { USD: rate(1.4, year - 1996) }));
const NBG: ReadonlyArray<MirrorPublication> = [...CASE_TABLES, ...YEAR_FILLERS];
/** The table valid from 2026-10-09: tomorrow on Thursday 2026-10-08. */
const TOMORROW = publication(tableFrom('2026-10-09', 2.6013));

const THURSDAY = '2026-10-08';

function minuteOf(clock: string): number {
    const [hours = 0, minutes = 0] = clock.split(':').map(Number);
    return hours * 60 + minutes;
}

function clockOf(minuteOfDay: number): string {
    return `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
}

/**
 * Runs each event scheduled on Thursday 2026-10-08 from `first` to `last` (HH:MM in Tbilisi, both included): the
 * hourly run on the hour, then the window run on a window minute. `before` runs first in each minute, for NBG's
 * writes. No run may fail.
 */
async function runScheduled(
    harness: Harness,
    first: string,
    last: string,
    before?: (clock: string) => void,
): Promise<ReadonlyArray<SyncLogLine>> {
    const lines: SyncLogLine[] = [];
    for (let minute = minuteOf(first); minute <= minuteOf(last); minute += 1) {
        const clock = clockOf(minute);
        before?.(clock);
        const wallClock = `${THURSDAY}T${clock}`;
        if (minute % 60 === 0) {
            lines.push(await harness.run(wallClock));
        }
        if (isWindowMinute(tbilisi(wallClock))) {
            lines.push(await harness.run(wallClock, { kind: 'window' }));
        }
    }
    expect(lines.filter((line) => line.syncResult === 'failed')).toEqual([]);
    return lines;
}

/** The bootstrap at 00:00, then the hourly runs to 16:00, which completes the archive rows' fill. */
async function builtMirror(): Promise<Harness> {
    const harness = await setUp({ nbg: NBG });
    await runScheduled(harness, '00:00', '16:00');
    const state = await harness.state();
    expect(state.span).toEqual({ start: '2026-10-01', end: '2026-10-09' });
    expect(state.rowsStart).toBe(NBG_ARCHIVE_START);
    expect(state.freshUntil).toBe(at(`${THURSDAY}T17:02`));
    return harness;
}

type Call =
    { readonly tool: string; readonly arguments: Readonly<Record<string, unknown>> } | { readonly resource: string };

/** Each call's result, labelled with the call. */
type Answers = ReadonlyArray<readonly [string, unknown]>;

/** What a server over `service` answers each call; a resource read that fails answers its error message. */
async function answers(service: RatesService, now: Date, calls: ReadonlyArray<Call>): Promise<Answers> {
    const server = createServer({ service, now: () => now, version: '0.0.0-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'equivalence', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
        const answered: Array<readonly [string, unknown]> = [];
        for (const call of calls) {
            if ('tool' in call) {
                const result = await client.callTool({ name: call.tool, arguments: { ...call.arguments } });
                answered.push([`${call.tool} ${JSON.stringify(call.arguments)}`, result]);
            } else {
                const result = await client
                    .readResource({ uri: call.resource })
                    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
                answered.push([call.resource, result]);
            }
        }
        return answered;
    } finally {
        await client.close();
    }
}

/** Today's live path over the same fake NBG, with an empty instance cache. */
function liveService(harness: Harness, now: Date): RatesService {
    return createRatesService({ client: harness.fake.client, cache: createSnapshotCache(), now: () => now });
}

/**
 * The same calls of a server over today's live path, of one over the mirrored service, and again of one over a new
 * mirrored service (an empty instance cache), which must answer from the mirror alone: no NBG request, no write.
 * Answers the live results.
 */
async function expectMirrorAnswersAsNbg(harness: Harness, now: Date, calls: ReadonlyArray<Call>): Promise<Answers> {
    const live = await answers(liveService(harness, now), now, calls);
    expect(await answers(mirroredService(harness, now).service, now, calls)).toEqual(live);
    const mark = harness.mark();
    const again = mirroredService(harness, now);
    expect(await answers(again.service, now, calls)).toEqual(live);
    expect(again.asked).toEqual([]);
    expect(harness.since(mark).requests).toEqual([]);
    expect(harness.since(mark).writes).toEqual([]);
    return live;
}

function failed(error: RatesError): unknown {
    return { content: [{ type: 'text', text: describeError(error) }], isError: true };
}

const historyResult = z.object({ structuredContent: rateHistoryOutput });

/** The series a successful nbg_rate_history call answered. */
function seriesOf(result: unknown): z.infer<typeof rateHistoryOutput> {
    return historyResult.parse(result).structuredContent;
}

/** Every tool and the resource that take a date, for `day`; the conversions and the history ask for `currency`. */
function dateCalls(day: string, currency: string): ReadonlyArray<Call> {
    return [
        { tool: 'nbg_get_rates', arguments: { date: day } },
        { tool: 'nbg_get_rates', arguments: { date: day, language: 'ka' } },
        { tool: 'nbg_get_rates', arguments: { date: day, currencies: [currency, 'EUR'] } },
        { tool: 'nbg_convert', arguments: { amount: 100, from: currency, to: 'GEL', date: day } },
        {
            tool: 'nbg_convert_many',
            arguments: {
                items: [
                    { amount: 100, from: currency, to: 'GEL', date: day },
                    { amount: 250.5, from: 'GEL', to: 'EUR', date: day },
                ],
            },
        },
        { tool: 'nbg_rate_history', arguments: { currency, from: day, to: day } },
        { resource: `nbg://rates/${day}` },
    ];
}

interface HistoryAsk {
    readonly currency: string;
    readonly from: string;
    readonly to: string;
}

function historyCall(ask: HistoryAsk): Call {
    return { tool: 'nbg_rate_history', arguments: { currency: ask.currency, from: ask.from, to: ask.to } };
}

/** Today's tools, which take no date. */
const TODAY_CALLS: ReadonlyArray<Call> = [
    { tool: 'nbg_list_currencies', arguments: {} },
    { tool: 'nbg_list_currencies', arguments: { language: 'ka' } },
    { resource: 'nbg://rates/today' },
];

interface DateCase {
    readonly name: string;
    readonly date: string;
    /** What the conversions and the history ask for; default USD. */
    readonly currency?: string;
    /** The effective date nbg_get_rates answers, or its error. */
    readonly answer: string | RatesError;
}

function dateCases(tomorrow: string | RatesError): ReadonlyArray<DateCase> {
    return [
        { name: 'a business day', date: '2026-10-07', answer: '2026-10-07' },
        { name: 'tomorrow', date: '2026-10-09', answer: tomorrow },
        { name: 'a Sunday carried over', date: '2026-10-04', answer: '2026-10-03' },
        { name: 'a Monday carried over', date: '2026-10-05', answer: '2026-10-03' },
        { name: 'the day after a holiday', date: '2026-01-02', answer: '2025-12-31' },
        { name: 'the late publication', date: '2026-09-28', answer: '2026-09-26' },
        { name: 'a pre-September-2021 daily row', date: '2021-09-05', answer: '2021-09-05' },
        { name: 'the archive start', date: '1995-10-14', answer: '1995-10-14' },
        { name: 'an unknown code', date: '2026-10-07', currency: 'XXX', answer: '2026-10-07' },
        { name: 'a past date', date: '2024-03-16', answer: '2024-03-16' },
        { name: 'a later date carried over from it', date: '2024-03-18', answer: '2024-03-16' },
    ];
}

/**
 * Every date tool through both paths. A past date's first ask takes the live path and keeps both of NBG's tables of the
 * publication in force; the second then reads them.
 */
async function expectSameDateAnswers(harness: Harness, now: Date, subject: DateCase): Promise<void> {
    const live = await expectMirrorAnswersAsNbg(harness, now, dateCalls(subject.date, subject.currency ?? 'USD'));
    const rates = live[0]?.[1];
    if (typeof subject.answer !== 'string') {
        expect(rates).toEqual(failed(subject.answer));
        return;
    }
    expect(rates).toMatchObject({ structuredContent: { effectiveDate: subject.answer } });
    if (isPastDate(await harness.state(), date(subject.date))) {
        expect(harness.store.rawItem('table#en', subject.answer)).toBeDefined();
        expect(harness.store.rawItem('table#ka', subject.answer)).toBeDefined();
    }
}

interface HistoryCase extends HistoryAsk {
    readonly name: string;
    /** The error nbg_rate_history answers, or undefined for a series. */
    readonly error?: RatesError;
    /** A series' carried-over days. */
    readonly carried?: ReadonlyArray<string>;
}

// BGN's last table is 2025-12-31. A range whose interval (its start minus 31 days to its end, start included) holds it
// is not unknown_currency: before the interval's first table, and from its first table without BGN, the rate in force
// is missing. A range whose interval starts after it is unknown_currency through both paths (spec rule 1).
const HISTORY_CASES: ReadonlyArray<HistoryCase> = [
    {
        name: 'across the 2021 changeover',
        currency: 'USD',
        from: '2021-09-01',
        to: '2021-09-17',
        carried: ['2021-09-12'],
    },
    {
        name: 'of BGN up to its last table',
        currency: 'BGN',
        from: '2025-12-01',
        to: '2025-12-31',
        error: { kind: 'no_data_for_date', date: date('2025-12-01'), currency: code('BGN') },
    },
    {
        name: 'of BGN after its last table',
        currency: 'BGN',
        from: '2026-01-01',
        to: '2026-01-10',
        error: { kind: 'no_data_for_date', date: date('2026-01-03'), currency: code('BGN') },
    },
    {
        name: 'of BGN in 2026 alone',
        currency: 'BGN',
        from: '2026-02-01',
        to: '2026-02-05',
        error: { kind: 'unknown_currency', code: 'BGN' },
    },
    {
        name: 'of BGN from the day its last table opens the interval',
        currency: 'BGN',
        from: '2026-01-31',
        to: '2026-02-05',
        error: { kind: 'no_data_for_date', date: date('2026-01-31'), currency: code('BGN') },
    },
];

async function expectSameHistory(harness: Harness, now: Date, subject: HistoryCase): Promise<void> {
    const history = (await expectMirrorAnswersAsNbg(harness, now, [historyCall(subject)]))[0]?.[1];
    if (subject.error !== undefined) {
        expect(history).toEqual(failed(subject.error));
        return;
    }
    const series = seriesOf(history);
    expect(series).toMatchObject({ currency: subject.currency, from: subject.from, to: subject.to });
    expect(series.days.filter((day) => day.carriedOver === true).map((day) => day.date)).toEqual(subject.carried);
}

describe('the mirror built by runSync answers as the live path does', () => {
    let harness: Harness;

    beforeAll(async () => {
        harness = await builtMirror();
    });

    describe('at 16:30, once the archive rows are filled', () => {
        const now = tbilisi(`${THURSDAY}T16:30`);
        const notPublished: RatesError = {
            kind: 'rate_not_published',
            date: date('2026-10-09'),
            latestEffectiveDate: date('2026-10-07'),
            today: date(THURSDAY),
        };

        it.each(dateCases(notPublished))('$name, $date', (subject) => expectSameDateAnswers(harness, now, subject));

        it.each(HISTORY_CASES)('a history $name', (subject) => expectSameHistory(harness, now, subject));

        it("lists today's currencies and reads today's table", async () => {
            const listed = (await expectMirrorAnswersAsNbg(harness, now, TODAY_CALLS))[0]?.[1];
            expect(listed).toMatchObject({ structuredContent: { effectiveDate: '2026-10-07' } });
        });

        it("answers AZN in NBG's CSV filter gap from its rows, the one accepted difference", async () => {
            const calls = [
                historyCall({ currency: 'AZN', from: '2006-06-01', to: '2006-06-10' }),
                historyCall({ currency: 'AZN', from: '2008-01-05', to: '2008-01-10' }),
            ];
            const live = await answers(liveService(harness, now), now, calls);
            const mirrored = mirroredService(harness, now);
            const [inGap, afterGap] = (await answers(mirrored.service, now, calls)).map(([, result]) => result);
            // Live: NBG's export answers nothing for a request naming AZN that reaches into 2006 or 2007.
            expect(live.map(([, result]) => result)).toEqual([
                failed({ kind: 'no_data_for_date', date: date('2006-06-01'), currency: code('AZN') }),
                failed({ kind: 'no_data_for_date', date: date('2008-01-05'), currency: code('AZN') }),
            ]);
            // The mirror: the fill asked without AZN for 2006 and 2007, so it holds USD rows there, and with it for 2008.
            expect(inGap).toEqual(failed({ kind: 'unknown_currency', code: 'AZN' }));
            expect(seriesOf(afterGap).days).toEqual(
                daysFrom('2008-01-05', '2008-01-10').map((day) => ({
                    date: day,
                    rate: 1.8801,
                    effectiveDate: '2008-01-02',
                    carriedOver: true,
                })),
            );
            expect(mirrored.asked).toEqual([]);
        });
    });

    describe('at 17:30, after a window run committed 2026-10-09', () => {
        const now = tbilisi(`${THURSDAY}T17:30`);

        beforeAll(async () => {
            // NBG writes the table at 17:00:05, after the 17:00 runs asked.
            const lines = await runScheduled(harness, '17:00', '17:30', (clock) => {
                if (clock === '17:01') {
                    harness.fake.publish(TOMORROW);
                }
            });
            expect(lines.filter((line) => line.committed > 0)).toEqual([
                expect.objectContaining({ syncRun: 'window', scheduledTime: '2026-10-08T13:01:00.000Z', committed: 1 }),
            ]);
            expect(await held(harness.store, '2026-10-09')).toEqual(expectedHeld(TOMORROW, at(`${THURSDAY}T17:01:02`)));
            const state = await harness.state();
            expect(state.window).toMatchObject({ committed: true, stopped: true });
            expect(state.freshUntil).toBe(at(`${THURSDAY}T18:05`));
        });

        it.each(dateCases('2026-10-09'))('$name, $date', (subject) => expectSameDateAnswers(harness, now, subject));

        it.each(HISTORY_CASES)('a history $name', (subject) => expectSameHistory(harness, now, subject));

        it("lists today's currencies and reads today's table", async () => {
            const listed = (await expectMirrorAnswersAsNbg(harness, now, TODAY_CALLS))[0]?.[1];
            expect(listed).toMatchObject({ structuredContent: { effectiveDate: '2026-10-07' } });
        });
    });
});

describe('a date the sources disagree on takes the live path, and answers as it does', () => {
    it('answers a history over 2026-10-09, which the CSV lists before the JSON, with its four points', async () => {
        const harness = await builtMirror();
        await runScheduled(harness, '17:00', '18:00', (clock) => {
            if (clock === '17:10') {
                harness.fake.publishCsv(TOMORROW);
            }
        });
        const now = tbilisi(`${THURSDAY}T18:30`);
        const state = await harness.state();
        expect(state.unresolved).toEqual(['2026-10-09']); // by the 18:00 hourly check
        expect(isFresh(state, now)).toBe(true);

        const calls = [
            historyCall({ currency: 'USD', from: '2026-10-06', to: '2026-10-09' }),
            ...dateCalls('2026-10-09', 'USD'),
        ];
        const live = await answers(liveService(harness, now), now, calls);
        const mirrored = mirroredService(harness, now);
        expect(await answers(mirrored.service, now, calls)).toEqual(live);
        const { days } = seriesOf(live[0]?.[1]);
        expect(days.map((day) => day.date)).toEqual(daysFrom('2026-10-06', '2026-10-09'));
        expect(days.at(-1)).toEqual({ date: '2026-10-09', rate: 2.6013 });
        expect(mirrored.asked[0]).toBe('live.getHistory');
    });

    it("answers 2026-10-09, which the JSON shows before the CSV, with NBG's new table", async () => {
        const harness = await builtMirror();
        await runScheduled(harness, '17:00', '17:02', (clock) => {
            if (clock === '17:02') {
                harness.fake.publishJson(TOMORROW);
            }
        });
        const now = tbilisi(`${THURSDAY}T17:02:30`);
        const state = await harness.state();
        expect(state.unresolved).toEqual(['2026-10-09']); // by the 17:02 window run
        expect(state.freshUntil).toBe(at(`${THURSDAY}T17:05`));

        const calls = dateCalls('2026-10-09', 'USD');
        const live = await answers(liveService(harness, now), now, calls);
        const mirrored = mirroredService(harness, now);
        expect(await answers(mirrored.service, now, calls)).toEqual(live);
        expect(live[0]?.[1]).toMatchObject({ structuredContent: { effectiveDate: '2026-10-09' } });
        expect(mirrored.asked[0]).toBe('live.getSnapshot');
    });
});

describe('a mirror whose archive rows start at 2025-01-01', () => {
    it('answers a history whose interval starts before the rows from NBG, as the live path does', async () => {
        const harness = await setUp({ nbg: NBG });
        await runScheduled(harness, '00:00', '01:00');
        expect((await harness.state()).rowsStart).toBe('2025-01-01');
        const now = tbilisi(`${THURSDAY}T01:30`);
        const calls = [historyCall({ currency: 'USD', from: '2025-01-10', to: '2025-01-31' })];
        const live = await answers(liveService(harness, now), now, calls);

        const mark = harness.mark();
        const mirrored = mirroredService(harness, now);
        const fromMirror = await answers(mirrored.service, now, calls);
        expect(fromMirror).toEqual(live);
        expect(mirrored.asked).toEqual(['live.getHistory']);
        expect(harness.since(mark).requests).toEqual(['range:USD:2024-12-10:2025-01-31']);
        // NBG holds no table from 2024-03-17 to 2025-12-29 here, so both answer that no rate is in force on 2025-01-10.
        expect(fromMirror.map(([, result]) => result)).toEqual([
            failed({ kind: 'no_data_for_date', date: date('2025-01-10'), currency: code('USD') }),
        ]);
    });
});
