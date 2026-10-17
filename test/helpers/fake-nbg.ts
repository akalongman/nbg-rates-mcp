import { AZN_GAP_END, AZN_GAP_START, type MirrorPublication } from '../../src/core/mirror-publication.js';
import type { NbgCsvRow } from '../../src/core/nbg-csv.js';
import type { NbgDay } from '../../src/core/nbg-schema.js';
import { err, ok, type CalendarDate, type RatesError, type Result } from '../../src/core/types.js';
import type { NbgClient } from '../../src/shell/nbg-client.js';

export interface FakeNbg {
    readonly client: NbgClient;
    /**
     * 'day:en:2026-10-07' and 'range:AMD,USD:2026-10-01:2026-10-09' (the codes in the order asked), in order. A
     * request is listed when it is made, including one that fails through failWith or waits on hold().
     */
    readonly requests: ReadonlyArray<string>;
    /** Both views, added or replaced. */
    publish(publication: MirrorPublication): void;
    /** The JSON view only. */
    publishJson(publication: MirrorPublication): void;
    /** The CSV view only. */
    publishCsv(publication: MirrorPublication): void;
    /** Removes the publication from both views. */
    withdraw(validFrom: CalendarDate): void;
    /** Every request answers with this error until cleared. */
    failWith(error: RatesError | undefined): void;
    /** Requests wait for the returned release function, then answer from the data at release. */
    hold(): () => void;
}

const AZN = 'AZN';

/**
 * An NbgClient over publications held in memory, answering like NBG: a day is the table with the latest validFrom on
 * or before it (the latest table for a date after every table, no_data_for_date before the first), and the export is
 * the rows of the codes asked with validFrom in [start, end], newest first per code, in request order, and nothing at
 * all when AZN is asked over a range reaching into its filter gap.
 */
export function createFakeNbg(publications: ReadonlyArray<MirrorPublication>): FakeNbg {
    const tables = new Map<CalendarDate, { readonly en: NbgDay; readonly ka: NbgDay }>();
    const exports = new Map<CalendarDate, ReadonlyArray<NbgCsvRow>>();
    const requests: string[] = [];
    const holds = new Set<Promise<void>>();
    let failure: RatesError | undefined;

    function publishJson(publication: MirrorPublication): void {
        tables.set(publication.validFrom, structuredClone({ en: publication.en, ka: publication.ka }));
    }

    function publishCsv(publication: MirrorPublication): void {
        exports.set(publication.validFrom, structuredClone(publication.rows));
    }

    for (const publication of publications) {
        publishJson(publication);
        publishCsv(publication);
    }

    /** Lists the request at once; answers after every hold active now is released. */
    async function answer<T>(request: string, compute: () => Result<T, RatesError>): Promise<Result<T, RatesError>> {
        requests.push(request);
        await Promise.all([...holds]);
        return failure === undefined ? compute() : err(structuredClone(failure));
    }

    return {
        requests,
        client: {
            fetchDay(date, language) {
                return answer(`day:${language}:${date}`, () => {
                    const inForce = [...tables.keys()]
                        .filter((validFrom) => validFrom <= date)
                        .sort()
                        .at(-1);
                    const pair = inForce === undefined ? undefined : tables.get(inForce);
                    return pair === undefined
                        ? err({ kind: 'no_data_for_date', date, currency: undefined })
                        : ok(structuredClone(pair[language]));
                });
            },

            fetchRange(currencies, start, end) {
                return answer(`range:${currencies.join(',')}:${start}:${end}`, () => {
                    const reachesGap = start <= AZN_GAP_END && end >= AZN_GAP_START;
                    if (reachesGap && currencies.some((currency) => currency === AZN)) {
                        return ok([]);
                    }
                    // NBG filters on each row's ValidFromDate; the sort is stable, so a publication keeps its order.
                    const inRange = [...exports.values()]
                        .flat()
                        .filter((row) => row.validFrom >= start && row.validFrom <= end);
                    const rows = currencies.flatMap((currency) =>
                        inRange
                            .filter((row) => row.code === currency)
                            .sort((left, right) =>
                                left.validFrom < right.validFrom ? 1 : left.validFrom > right.validFrom ? -1 : 0,
                            ),
                    );
                    return ok(structuredClone(rows));
                });
            },
        },

        publish(publication) {
            publishJson(publication);
            publishCsv(publication);
        },

        publishJson,
        publishCsv,

        withdraw(validFrom) {
            tables.delete(validFrom);
            exports.delete(validFrom);
        },

        failWith(error) {
            failure = error;
        },

        hold() {
            let release = (): void => undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            holds.add(gate);
            return () => {
                holds.delete(gate);
                release();
            };
        },
    };
}
