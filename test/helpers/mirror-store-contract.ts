import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_MIRROR_STATE } from '../../src/core/mirror.js';
import type { MirrorPublication } from '../../src/core/mirror-publication.js';
import type { NbgCsvRow } from '../../src/core/nbg-csv.js';
import { ok, type CalendarDate, type Result } from '../../src/core/types.js';
import type { MirrorStore, StoredRows, StoredTable, StoredTables, StoreError } from '../../src/shell/mirror-store.js';
import { publication, rowsFromTable, syntheticTable, tableFixture } from './publications.js';
import { date } from './values.js';

/** Never aborts: the cases that are not about cancellation pass it. */
const SIGNAL = new AbortController().signal;

/** 'ok', or the error's kind. */
function outcome(result: Result<unknown, StoreError>): string {
    return result.ok ? 'ok' : result.error.kind;
}

function unwrap<T>(result: Result<T, StoreError>): T {
    if (!result.ok) {
        throw new Error(`the store failed: ${result.error.detail}`);
    }
    return result.value;
}

interface StoredPublication {
    readonly rows: StoredRows | undefined;
    readonly en: StoredTable | undefined;
    readonly ka: StoredTable | undefined;
}

/** The three items a commit of `subject` stores. */
function itemsOf(subject: MirrorPublication): StoredPublication {
    const { validFrom, observedAt } = subject;
    return {
        rows: { validFrom, rows: subject.rows, observedAt },
        en: { validFrom, day: subject.en, observedAt },
        ka: { validFrom, day: subject.ka, observedAt },
    };
}

function tablesOf(subject: MirrorPublication): StoredTables {
    return { validFrom: subject.validFrom, en: subject.en, ka: subject.ka, observedAt: subject.observedAt };
}

const EN_2026_10_07 = tableFixture('en', '2026-10-07');
const KA_2026_10_07 = tableFixture('ka', '2026-10-07');
const AT_1000 = publication(EN_2026_10_07, { ka: KA_2026_10_07, observedAt: 1000 });
/** The same valid-from date with other rates, so a replacement is visible in every item. */
const OTHER_2026_10_07 = syntheticTable('2026-10-07', { USD: 2.7, EUR: 3.1 });
const OCTOBER = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07'].map((day) =>
    publication(tableFixture('en', day), { observedAt: 5000 }),
);
const MARCH_15 = syntheticTable('2024-03-15', { USD: 2.65, EUR: 2.88 });
const MARCH_15_REVISED = syntheticTable('2024-03-15', { USD: 2.66, EUR: 2.89 });

function archiveRows(validFrom: string, rows: ReadonlyArray<NbgCsvRow>, observedAt: number): StoredRows {
    return { validFrom: date(validFrom), rows, observedAt };
}

/**
 * The behaviour every MirrorStore shares, run against a fresh store per case. `open` gives an empty store and the
 * function that releases it.
 */
export function describeMirrorStoreContract(
    name: string,
    open: () => Promise<{ readonly store: MirrorStore; close(): Promise<void> }>,
): void {
    describe(`${name} mirror store contract`, () => {
        let opened: Awaited<ReturnType<typeof open>>;
        let store: MirrorStore;

        beforeEach(async () => {
            opened = await open();
            store = opened.store;
        });

        afterEach(async () => {
            await opened.close();
        });

        async function stored(validFrom: CalendarDate): Promise<StoredPublication> {
            const rows = unwrap(await store.readRowsBetween(validFrom, validFrom, SIGNAL));
            return {
                rows: rows[0],
                en: unwrap(await store.readTable(validFrom, 'en', SIGNAL)),
                ka: unwrap(await store.readTable(validFrom, 'ka', SIGNAL)),
            };
        }

        async function commit(subject: MirrorPublication): Promise<void> {
            expect(await store.commitPublication(subject, SIGNAL)).toEqual(ok('committed'));
        }

        describe('state', () => {
            it('reads the empty state from an empty store', async () => {
                expect(await store.readState(SIGNAL)).toEqual(ok(EMPTY_MIRROR_STATE));
            });

            it('writes revision 1, then 2, handing each change the stored state', async () => {
                const first = await store.updateState(
                    (state) => ({ next: { ...state, freshUntil: 1000 }, outcome: state.revision }),
                    SIGNAL,
                );
                const second = await store.updateState(
                    (state) => ({ next: { ...state, rowsStart: date('2024-01-01') }, outcome: state.revision }),
                    SIGNAL,
                );
                expect([first, second]).toEqual([ok(0), ok(1)]);
                expect(await store.readState(SIGNAL)).toEqual(
                    ok({ ...EMPTY_MIRROR_STATE, revision: 2, freshUntil: 1000, rowsStart: '2024-01-01' }),
                );
            });

            it('writes nothing when the change gives no next state', async () => {
                await store.updateState((state) => ({ next: { ...state, freshUntil: 1000 }, outcome: 'set' }), SIGNAL);
                expect(await store.updateState(() => ({ next: undefined, outcome: 'kept' }), SIGNAL)).toEqual(
                    ok('kept'),
                );
                expect(await store.readState(SIGNAL)).toEqual(
                    ok({ ...EMPTY_MIRROR_STATE, revision: 1, freshUntil: 1000 }),
                );
            });

            it('lands two racing updates: the one that loses the compare-and-set re-reads and re-applies', async () => {
                let calls = 0;
                let firstStarted: () => void = () => undefined;
                let releaseFirst: () => void = () => undefined;
                const started = new Promise<void>((resolve) => {
                    firstStarted = resolve;
                });
                const firstMayFinish = new Promise<void>((resolve) => {
                    releaseFirst = resolve;
                });
                const first = store.updateState(async (state) => {
                    calls += 1;
                    firstStarted();
                    await firstMayFinish;
                    return { next: { ...state, freshUntil: 5000 }, outcome: 'first' };
                }, SIGNAL);
                await started; // the first update has read revision 0 and waits inside its change
                const second = store.updateState((state) => {
                    calls += 1;
                    releaseFirst();
                    return { next: { ...state, rowsStart: date('2024-01-01') }, outcome: 'second' };
                }, SIGNAL);

                expect(await Promise.all([first, second])).toEqual([ok('first'), ok('second')]);
                expect(calls).toBe(3); // both read revision 0, so one of them applied its change twice
                expect(await store.readState(SIGNAL)).toEqual(
                    ok({ ...EMPTY_MIRROR_STATE, revision: 2, freshUntil: 5000, rowsStart: '2024-01-01' }),
                );
            });

            it('gives up with store_failed when the revision moves on each of 5 attempts', async () => {
                let calls = 0;
                const result = await store.updateState(async (state) => {
                    calls += 1;
                    // Another writer lands between this attempt's read and its compare-and-set.
                    const other = await store.updateState(
                        (current) => ({
                            next: { ...current, freshUntil: (current.freshUntil ?? 0) + 1 },
                            outcome: undefined,
                        }),
                        SIGNAL,
                    );
                    expect(other.ok).toBe(true);
                    return { next: { ...state, rowsStart: date('2024-01-01') }, outcome: undefined };
                }, SIGNAL);

                expect(outcome(result)).toBe('store_failed');
                expect(calls).toBe(5);
                expect(await store.readState(SIGNAL)).toEqual(
                    ok({ ...EMPTY_MIRROR_STATE, revision: 5, freshUntil: 5 }),
                );
            });
        });

        describe('commitPublication', () => {
            it('stores the rows item and both table items', async () => {
                await commit(AT_1000);
                expect(await stored(AT_1000.validFrom)).toEqual(itemsOf(AT_1000));
            });

            it('is superseded by an equal or newer stored observation and leaves those items intact', async () => {
                await commit(AT_1000);
                for (const observedAt of [999, 1000]) {
                    const older = publication(OTHER_2026_10_07, { observedAt });
                    expect(await store.commitPublication(older, SIGNAL)).toEqual(ok('superseded'));
                }
                expect(await stored(AT_1000.validFrom)).toEqual(itemsOf(AT_1000));
            });

            it('replaces all three items with a newer observation', async () => {
                await commit(AT_1000);
                const newer = publication(OTHER_2026_10_07, { observedAt: 1001 });
                await commit(newer);
                expect(await stored(AT_1000.validFrom)).toEqual(itemsOf(newer));
            });

            it('replaces a past table of the same date', async () => {
                expect(await store.fillPastTable(AT_1000.validFrom, 'en', OTHER_2026_10_07, SIGNAL)).toEqual(
                    ok('written'),
                );
                await commit(AT_1000);
                expect(await stored(AT_1000.validFrom)).toEqual(itemsOf(AT_1000));
            });

            it('is all or nothing: one newer item supersedes the whole commit', async () => {
                await commit(AT_1000);
                const olderRows = archiveRows('2026-10-07', rowsFromTable(OTHER_2026_10_07), 500);
                expect(await store.writeArchiveRows([olderRows], SIGNAL)).toEqual(ok(undefined));
                // The rows item is older than 800, both tables are newer.
                const between = publication(OTHER_2026_10_07, { observedAt: 800 });
                expect(await store.commitPublication(between, SIGNAL)).toEqual(ok('superseded'));
                expect(await stored(AT_1000.validFrom)).toEqual({ ...itemsOf(AT_1000), rows: olderRows });
            });
        });

        describe('readRowsInForce and readTable', () => {
            it('reads the rows item with the latest valid-from date on or before the date', async () => {
                const [october03, october06] = [OCTOBER[2], OCTOBER[3]];
                if (october03 === undefined || october06 === undefined) {
                    throw new Error('the October publications are missing');
                }
                await commit(october06);
                await commit(october03);
                const rows03 = itemsOf(october03).rows;
                const rows06 = itemsOf(october06).rows;
                expect(await store.readRowsInForce(date('2026-10-05'), SIGNAL)).toEqual(ok(rows03));
                expect(await store.readRowsInForce(date('2026-10-06'), SIGNAL)).toEqual(ok(rows06));
                expect(await store.readRowsInForce(date('2026-10-30'), SIGNAL)).toEqual(ok(rows06));
                expect(await store.readRowsInForce(date('2026-10-02'), SIGNAL)).toEqual(ok(undefined));
            });

            it("reads each language's table, and nothing for a date without one", async () => {
                await commit(AT_1000);
                const en = await store.readTable(AT_1000.validFrom, 'en', SIGNAL);
                const ka = await store.readTable(AT_1000.validFrom, 'ka', SIGNAL);
                expect([en, ka]).toEqual([ok(itemsOf(AT_1000).en), ok(itemsOf(AT_1000).ka)]);
                expect(await store.readTable(date('2026-10-06'), 'en', SIGNAL)).toEqual(ok(undefined));
            });
        });

        describe('fillPastTable', () => {
            it('adds a table that carries no observation', async () => {
                expect(await store.fillPastTable(date('2024-03-15'), 'en', MARCH_15, SIGNAL)).toEqual(ok('written'));
                expect(await store.readTable(date('2024-03-15'), 'en', SIGNAL)).toStrictEqual(
                    ok({ validFrom: '2024-03-15', day: MARCH_15 }),
                );
                expect(await store.readTable(date('2024-03-15'), 'ka', SIGNAL)).toEqual(ok(undefined));
            });

            it('never replaces a stored table, past or committed', async () => {
                await store.fillPastTable(date('2024-03-15'), 'en', MARCH_15, SIGNAL);
                expect(await store.fillPastTable(date('2024-03-15'), 'en', MARCH_15_REVISED, SIGNAL)).toEqual(
                    ok('present'),
                );
                expect(await store.readTable(date('2024-03-15'), 'en', SIGNAL)).toStrictEqual(
                    ok({ validFrom: '2024-03-15', day: MARCH_15 }),
                );

                await commit(AT_1000);
                expect(await store.fillPastTable(AT_1000.validFrom, 'ka', OTHER_2026_10_07, SIGNAL)).toEqual(
                    ok('present'),
                );
                expect(await stored(AT_1000.validFrom)).toEqual(itemsOf(AT_1000));
            });
        });

        describe('range reads', () => {
            beforeEach(async () => {
                for (const subject of [...OCTOBER].reverse()) {
                    await commit(subject);
                }
                // Past tables inside the range are not a publication's tables.
                const october04 = syntheticTable('2026-10-04', { USD: 2.6 });
                await store.fillPastTable(date('2026-10-04'), 'en', october04, SIGNAL);
                await store.fillPastTable(date('2026-10-04'), 'ka', october04, SIGNAL);
            });

            it('reads rows items inclusive at both ends, ascending', async () => {
                const rows = await store.readRowsBetween(date('2026-10-02'), date('2026-10-06'), SIGNAL);
                expect(rows).toEqual(ok(OCTOBER.slice(1, 4).map((subject) => itemsOf(subject).rows)));
                expect(await store.readRowsBetween(date('2026-10-04'), date('2026-10-05'), SIGNAL)).toEqual(ok([]));
            });

            it("reads publications' table pairs inclusive at both ends, ascending, without past tables", async () => {
                const tables = await store.readTablesBetween(date('2026-10-02'), date('2026-10-06'), SIGNAL);
                expect(tables).toEqual(ok(OCTOBER.slice(1, 4).map(tablesOf)));
                expect(await store.readTablesBetween(date('2026-10-04'), date('2026-10-05'), SIGNAL)).toEqual(ok([]));
            });
        });

        describe('removePublication', () => {
            it('is superseded by an equal or newer stored observation', async () => {
                await commit(AT_1000);
                expect(await store.removePublication(AT_1000.validFrom, 999, SIGNAL)).toEqual(ok('superseded'));
                expect(await store.removePublication(AT_1000.validFrom, 1000, SIGNAL)).toEqual(ok('superseded'));
                expect(await stored(AT_1000.validFrom)).toEqual(itemsOf(AT_1000));
            });

            it('removes all three items at a newer observation', async () => {
                await commit(AT_1000);
                expect(await store.removePublication(AT_1000.validFrom, 1001, SIGNAL)).toEqual(ok('removed'));
                expect(await stored(AT_1000.validFrom)).toEqual({ rows: undefined, en: undefined, ka: undefined });
            });
        });

        describe('writeArchiveRows', () => {
            it('writes each rows item whole, over any stored observation', async () => {
                await commit(AT_1000);
                const items = [
                    archiveRows('2024-03-15', rowsFromTable(MARCH_15), 500),
                    archiveRows('2026-10-07', rowsFromTable(OTHER_2026_10_07), 500),
                ];
                expect(await store.writeArchiveRows(items, SIGNAL)).toEqual(ok(undefined));
                expect(await store.readRowsBetween(date('2024-01-01'), date('2026-12-31'), SIGNAL)).toEqual(ok(items));
            });
        });

        describe('replaceArchivePublication', () => {
            const MARCH_15_DATE = date('2024-03-15');

            beforeEach(async () => {
                await store.writeArchiveRows([archiveRows('2024-03-15', rowsFromTable(MARCH_15), 1000)], SIGNAL);
                await store.fillPastTable(MARCH_15_DATE, 'en', MARCH_15, SIGNAL);
                await store.fillPastTable(MARCH_15_DATE, 'ka', MARCH_15, SIGNAL);
            });

            it('rewrites the rows item and deletes both past tables of that date', async () => {
                const revised = rowsFromTable(MARCH_15_REVISED);
                expect(await store.replaceArchivePublication(MARCH_15_DATE, revised, 2000, SIGNAL)).toEqual(
                    ok('replaced'),
                );
                expect(await stored(MARCH_15_DATE)).toEqual({
                    rows: archiveRows('2024-03-15', revised, 2000),
                    en: undefined,
                    ka: undefined,
                });
            });

            it('removes the rows item too when given no rows', async () => {
                expect(await store.replaceArchivePublication(MARCH_15_DATE, undefined, 2000, SIGNAL)).toEqual(
                    ok('replaced'),
                );
                expect(await stored(MARCH_15_DATE)).toEqual({ rows: undefined, en: undefined, ka: undefined });
            });

            it('is superseded by an equal or newer stored rows item and changes nothing', async () => {
                const revised = rowsFromTable(MARCH_15_REVISED);
                expect(await store.replaceArchivePublication(MARCH_15_DATE, revised, 1000, SIGNAL)).toEqual(
                    ok('superseded'),
                );
                expect(await stored(MARCH_15_DATE)).toEqual({
                    rows: archiveRows('2024-03-15', rowsFromTable(MARCH_15), 1000),
                    en: { validFrom: MARCH_15_DATE, day: MARCH_15 },
                    ka: { validFrom: MARCH_15_DATE, day: MARCH_15 },
                });
            });
        });

        it('fails every operation with store_failed on an aborted signal and writes nothing', async () => {
            const aborted = AbortSignal.abort();
            const day = AT_1000.validFrom;
            const results: ReadonlyArray<Result<unknown, StoreError>> = [
                await store.readState(aborted),
                await store.readRowsInForce(day, aborted),
                await store.readTable(day, 'en', aborted),
                await store.readRowsBetween(day, day, aborted),
                await store.readTablesBetween(day, day, aborted),
                await store.fillPastTable(day, 'en', EN_2026_10_07, aborted),
                await store.updateState((state) => ({ next: { ...state, freshUntil: 1 }, outcome: 'set' }), aborted),
                await store.commitPublication(AT_1000, aborted),
                await store.removePublication(day, 2000, aborted),
                await store.writeArchiveRows([archiveRows('2026-10-07', AT_1000.rows, 1000)], aborted),
                await store.replaceArchivePublication(day, AT_1000.rows, 2000, aborted),
            ];
            expect(results.map(outcome)).toEqual(results.map(() => 'store_failed'));
            expect(await store.readState(SIGNAL)).toEqual(ok(EMPTY_MIRROR_STATE));
            expect(await stored(day)).toEqual({ rows: undefined, en: undefined, ka: undefined });
        });
    });
}
