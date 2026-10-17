import { describe, expect, it } from 'vitest';
import { publication, syntheticTable } from '../../test/helpers/publications.js';
import {
    at,
    clockOf,
    OCTOBER,
    rate,
    setUp,
    tableFrom,
    tbilisi,
    type Harness,
} from '../../test/helpers/sync-harness.js';
import { date } from '../../test/helpers/values.js';
import { addDays, NBG_ARCHIVE_START } from '../core/dates.js';
import type { MirrorPublication } from '../core/mirror-publication.js';
import type { NbgDay } from '../core/nbg-schema.js';
import { isWindowMinute } from '../core/sync-schedule.js';
import type { SyncLogLine } from './sync.js';

// The spec's steady-state budget: about 60 NBG requests on a typical weekday, 75 on a weekday holiday and 45 on a
// weekend day, and about 436 for the archive rows' fill, at most 28 in one hourly run.

const SPAN_START = '2026-09-01';

/** The first day of each month from October 1995 to September 2026, October 1995's being NBG_ARCHIVE_START. */
function monthStarts(): ReadonlyArray<string> {
    const starts: string[] = [NBG_ARCHIVE_START];
    for (let year = 1995; year <= 2026; year += 1) {
        for (let month = 1; month <= 12; month += 1) {
            const start = `${year}-${String(month).padStart(2, '0')}-01`;
            if (start > NBG_ARCHIVE_START && start <= '2026-09-01') {
                starts.push(start);
            }
        }
    }
    return starts;
}

/** NBG's archive, one table a month: the first on 1995-10-14, then one on the first of each month to 2026-09-01. */
const MONTHLY: ReadonlyArray<MirrorPublication> = monthStarts().map((validFrom, index) =>
    publication(syntheticTable(validFrom, { USD: rate(1.3, index) })),
);

/** The days from SPAN_START to 2026-10-17 that tables are valid from: Tuesday to Saturday. */
function tableDays(): ReadonlyArray<string> {
    const days: string[] = [];
    for (let day = date(SPAN_START); day <= '2026-10-17'; day = addDays(day, 1)) {
        if (new Date(`${day}T00:00:00Z`).getUTCDay() >= 2) {
            days.push(day);
        }
    }
    return days;
}

/** NBG's tables from 2026-09-01: one valid from each Tuesday to Saturday, written the business day before. */
const RECENT: ReadonlyArray<MirrorPublication> = tableDays().map((day, index) =>
    publication(tableFrom(day, rate(2.65, index))),
);

/** The publication as NBG writes it at `stamp` (Tbilisi wall-clock time, as NBG stamps it): every row's write stamp. */
function writtenAt(subject: MirrorPublication, stamp: string): MirrorPublication {
    const restamp = (table: NbgDay): NbgDay => ({
        ...table,
        currencies: table.currencies.map((row) => ({ ...row, date: stamp })),
    });
    return publication(restamp(subject.en), { ka: restamp(subject.ka) });
}

/**
 * The mirror after a complete fill, as it stands at midnight starting `day`: the span from SPAN_START to `day` (tomorrow
 * as of the last check) holding every publication NBG has in it, the archive rows of every month before it from
 * NBG_ARCHIVE_START, the daily refetch last done the day before, and a re-check cycle part way through, its last slice
 * at 20:00 the day before and its next year 2005, so slices are due at 01:00, 06:00, 11:00, 16:00 and 21:00.
 */
async function steadyMirror(day: string): Promise<Harness> {
    const span = RECENT.filter((subject) => subject.validFrom <= day);
    const archive = MONTHLY.filter((subject) => subject.validFrom < SPAN_START);
    const yesterday = addDays(date(day), -1);
    return setUp({
        nbg: [...archive, ...span],
        seed: {
            publications: span,
            archiveRows: archive.map(({ validFrom, rows, observedAt }) => ({ validFrom, rows, observedAt })),
            state: {
                span: { start: date(SPAN_START), end: date(day) },
                rowsStart: date(NBG_ARCHIVE_START),
                freshUntil: at(`${day}T00:05`),
                refetch: { day: yesterday },
                recheck: {
                    cycleStartedAt: at(`${addDays(yesterday, -1)}T00:00`),
                    lastSliceAt: at(`${yesterday}T20:00`),
                    nextYear: 2005,
                },
            },
        },
    });
}

/**
 * Runs every event scheduled on `day` (Tbilisi): the hourly run on each hour, then the window run on each window
 * minute (Monday to Friday, 17:00 to 17:30). `before` runs first in each minute, for NBG's writes. No run may fail.
 */
async function runDay(
    harness: Harness,
    day: string,
    before?: (clock: string) => void,
): Promise<ReadonlyArray<SyncLogLine>> {
    const lines: SyncLogLine[] = [];
    for (let minute = 0; minute < 24 * 60; minute += 1) {
        const clock = clockOf(minute);
        before?.(clock);
        const wallClock = `${day}T${clock}`;
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

/** The day's re-check slices ran (2005 to 2009) and its daily refetch is done. */
async function expectDailyStepsDone(harness: Harness, day: string): Promise<void> {
    const state = await harness.state();
    expect(state.recheck.nextYear).toBe(2010);
    expect(state.refetch).toEqual({ day });
}

describe('the NBG requests of a day of runs, with the archive rows filled', () => {
    it('asks 50 to 70 on a typical weekday, whose table for tomorrow NBG writes at 17:00:05 and again at 17:01:02', async () => {
        const thursday = '2026-10-08';
        const tomorrow = RECENT.find((subject) => subject.validFrom === addDays(date(thursday), 1));
        if (tomorrow === undefined) {
            throw new Error('RECENT holds no table valid from 2026-10-09');
        }
        const harness = await steadyMirror(thursday);
        const mark = harness.mark();
        // The 17:01 run asks before the second write lands, as in the spec's worked example.
        const lines = await runDay(harness, thursday, (clock) => {
            if (clock === '17:01') {
                harness.fake.publish(writtenAt(tomorrow, `${thursday}T17:00:05.000Z`));
            }
            if (clock === '17:02') {
                harness.fake.publish(writtenAt(tomorrow, `${thursday}T17:01:02.000Z`));
            }
        });
        expect(lines.filter((line) => line.committed > 0)).toEqual([
            expect.objectContaining({ syncRun: 'window', scheduledTime: '2026-10-08T13:01:00.000Z', committed: 1 }),
        ]);
        expect((await harness.state()).window).toMatchObject({ date: thursday, committed: true, stopped: true });
        await expectDailyStepsDone(harness, thursday);
        const requests = harness.since(mark).requests.length;
        expect(requests).toBeGreaterThanOrEqual(50);
        expect(requests).toBeLessThanOrEqual(70);
    });

    it('asks 65 to 85 on a weekday holiday, whose window runs to 17:30 without a table', async () => {
        // Wednesday 2026-10-14 is a public holiday: NBG publishes no table valid from 2026-10-15.
        const wednesday = '2026-10-14';
        const harness = await steadyMirror(wednesday);
        const mark = harness.mark();
        const lines = await runDay(harness, wednesday);
        const windowRuns = lines.filter((line) => line.syncRun === 'window');
        expect(windowRuns).toHaveLength(31);
        expect(windowRuns.filter((line) => line.syncResult !== 'ok' || line.nbgRequests !== 1)).toEqual([]);
        await expectDailyStepsDone(harness, wednesday);
        const requests = harness.since(mark).requests.length;
        expect(requests).toBeGreaterThanOrEqual(65);
        expect(requests).toBeLessThanOrEqual(85);
    });

    it('asks 35 to 55 on a weekend day, which has no window', async () => {
        const saturday = '2026-10-10';
        const harness = await steadyMirror(saturday);
        const mark = harness.mark();
        const lines = await runDay(harness, saturday);
        expect(lines.filter((line) => line.syncRun === 'window')).toEqual([]);
        await expectDailyStepsDone(harness, saturday);
        const requests = harness.since(mark).requests.length;
        expect(requests).toBeGreaterThanOrEqual(35);
        expect(requests).toBeLessThanOrEqual(55);
    });
});

/** A request of the archive rows' fill: a month table or a year's CSV, both before the span's start. */
function beforeSpan(request: string): boolean {
    return (request.split(':').at(-1) ?? '') < '2026-10-01';
}

describe("the NBG requests of the archive rows' fill", () => {
    it('fills from a span starting 2026-10-01 back to 1995-10-14 in 350 to 450, at most 28 in one hourly run', async () => {
        const harness = await setUp({ nbg: [...MONTHLY, ...OCTOBER] });
        const perRun: number[] = [];
        for (let hour = 0; hour < 24 && (await harness.state()).rowsStart !== NBG_ARCHIVE_START; hour += 1) {
            const mark = harness.mark();
            expect(await harness.run(`2026-10-08T${clockOf(hour * 60)}`)).toMatchObject({ syncResult: 'ok' });
            perRun.push(harness.since(mark).requests.filter(beforeSpan).length);
        }
        const state = await harness.state();
        expect(state.span?.start).toBe('2026-10-01');
        expect(state.rowsStart).toBe(NBG_ARCHIVE_START);
        const total = perRun.reduce((sum, count) => sum + count, 0);
        expect(total).toBeGreaterThanOrEqual(350);
        expect(total).toBeLessThanOrEqual(450);
        expect(Math.max(...perRun)).toBeLessThanOrEqual(28);
    });
});
