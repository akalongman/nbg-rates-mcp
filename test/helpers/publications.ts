import { addDays, calendarDateFromTimestamp } from '../../src/core/dates.js';
import { tableValidFrom, type MirrorPublication } from '../../src/core/mirror-publication.js';
import type { NbgCsvRow } from '../../src/core/nbg-csv.js';
import { parseNbgResponse, type NbgDay } from '../../src/core/nbg-schema.js';
import type { Language } from '../../src/core/types.js';
import { loadFixture } from './fixtures.js';
import { date as calendarDate } from './values.js';

/** Validates a one-table NBG response; a malformed fixture or synthetic table throws here. */
function onlyTable(json: unknown, source: string): NbgDay {
    const parsed = parseNbgResponse(json);
    if (!parsed.ok) {
        throw new Error(`${source} is not an NBG table: ${JSON.stringify(parsed.error)}`);
    }
    const [table, ...rest] = parsed.value;
    if (table === undefined || rest.length > 0) {
        throw new Error(`${source} holds ${parsed.value.length} tables, expected one`);
    }
    return table;
}

/** The recorded table in test/fixtures/<language>-<date>.json. */
export function tableFixture(language: Language, date: string): NbgDay {
    const name = `${language}-${date}`;
    return onlyTable(loadFixture(name), name);
}

/** The rows the CSV export lists for a table: publishedOn is the date part of each row's write stamp. */
export function rowsFromTable(table: NbgDay): ReadonlyArray<NbgCsvRow> {
    return table.currencies.map((row) => ({
        code: row.code,
        quantity: row.quantity,
        rate: row.rate,
        publishedOn: calendarDateFromTimestamp(row.date),
        validFrom: calendarDateFromTimestamp(row.validFromDate),
    }));
}

/** A Georgian stand-in where none is recorded: the same rows with names prefixed "ka:". */
export function georgianTwin(table: NbgDay): NbgDay {
    return { ...table, currencies: table.currencies.map((row) => ({ ...row, name: `ka:${row.name}` })) };
}

/**
 * A table valid from `validFrom` quoting `rates` in the order given, each per one unit unless `quantities` names
 * another, with a zero diff and the code as its name. Every row carries the write stamp `writtenAt`, an NBG
 * timestamp; by default 17:01 on the day before `validFrom`, when NBG writes a business day's table.
 */
export function syntheticTable(
    validFrom: string,
    rates: Readonly<Record<string, number>>,
    options: { readonly quantities?: Readonly<Record<string, number>>; readonly writtenAt?: string } = {},
): NbgDay {
    const midnight = `${validFrom}T00:00:00.000Z`;
    const writtenAt = options.writtenAt ?? `${addDays(calendarDate(validFrom), -1)}T17:01:00.000Z`;
    const currencies = Object.entries(rates).map(([code, rate]) => ({
        code,
        quantity: options.quantities?.[code] ?? 1,
        rate,
        diff: 0,
        name: code,
        date: writtenAt,
        validFromDate: midnight,
    }));
    return onlyTable([{ date: midnight, currencies }], `the synthetic table for ${validFrom}`);
}

/**
 * A publication of `en`. By default the Georgian table is its twin, the rows are the ones the export lists for it,
 * and it was observed at midnight UTC starting its valid-from day.
 */
export function publication(
    en: NbgDay,
    options: { readonly ka?: NbgDay; readonly rows?: ReadonlyArray<NbgCsvRow>; readonly observedAt?: number } = {},
): MirrorPublication {
    const validFrom = tableValidFrom(en);
    return {
        validFrom,
        en,
        ka: options.ka ?? georgianTwin(en),
        rows: options.rows ?? rowsFromTable(en),
        observedAt: options.observedAt ?? Date.parse(`${validFrom}T00:00:00.000Z`),
    };
}
