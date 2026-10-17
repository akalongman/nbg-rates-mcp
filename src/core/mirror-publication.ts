import * as z from 'zod';
import { parseCurrencyCode } from './currency-code.js';
import { calendarDateFromTimestamp, parseCalendarDate } from './dates.js';
import { compareCsvRows } from './history.js';
import type { NbgCsvRow } from './nbg-csv.js';
import { hasAtMostFourDecimals, isNbgQuantity, type NbgDay } from './nbg-schema.js';
import { err, ok, type CalendarDate, type CurrencyCode, type Result } from './types.js';

/** One publication as fetched: NBG's English and Georgian tables and the CSV export's rows for its valid-from date. */
export interface MirrorPublication {
    readonly validFrom: CalendarDate;
    readonly en: NbgDay;
    readonly ka: NbgDay;
    /** In the order the export listed them. */
    readonly rows: ReadonlyArray<NbgCsvRow>;
    /** When the oldest of the three fetches began, epoch ms. */
    readonly observedAt: number;
}

/**
 * NBG's currency filter misses AZN in 2006 and 2007, although the day tables quote it then: a CSV request naming AZN
 * over those dates returns only the header for every currency in it.
 */
export const AZN_GAP_START = '2006-01-01';
export const AZN_GAP_END = '2007-12-31';
const AZN = 'AZN';

function inAznGap(day: CalendarDate): boolean {
    return day >= AZN_GAP_START && day <= AZN_GAP_END;
}

export function tableValidFrom(day: NbgDay): CalendarDate {
    // The schema guarantees at least one row and a validFromDate shared by all rows.
    return calendarDateFromTimestamp(day.currencies[0]?.validFromDate ?? day.date);
}

export function tableCodes(day: NbgDay): ReadonlyArray<CurrencyCode> {
    return day.currencies.map((row) => row.code as CurrencyCode); // the schema has already matched /^[A-Z]{3}$/
}

/** Throws on anything but an uppercase three-letter code: the codes come from validated tables or rows. */
function exactCurrencyCode(candidate: string): CurrencyCode {
    const parsed = parseCurrencyCode(candidate);
    if (!parsed.ok || parsed.value !== candidate) {
        throw new Error(`not a currency code: ${candidate}`);
    }
    return parsed.value;
}

/** The codes to request: AZN is left out when [start, end] reaches into the gap. */
export function csvRequestCodes(
    codes: ReadonlyArray<string>,
    start: CalendarDate,
    end: CalendarDate,
): ReadonlyArray<CurrencyCode> {
    const reachesGap = start <= AZN_GAP_END && end >= AZN_GAP_START;
    return codes.filter((candidate) => !(reachesGap && candidate === AZN)).map(exactCurrencyCode);
}

interface Quote {
    readonly quantity: number;
    readonly rate: number;
}

interface QuoteSource {
    readonly label: string;
    readonly quotes: ReadonlyMap<string, Quote>;
}

function tableQuotes(table: NbgDay): ReadonlyMap<string, Quote> {
    return new Map(table.currencies.map((row) => [row.code, row]));
}

/** The row assembleHistory applies for each code: the last of its rows after a stable sort with compareCsvRows. */
function appliedQuotes(rows: ReadonlyArray<NbgCsvRow>): ReadonlyMap<string, Quote> {
    return new Map([...rows].sort(compareCsvRows).map((row) => [row.code, row]));
}

/**
 * A rate in units of NBG's fourth decimal, on the basis of hasAtMostFourDecimals: the JSON can carry float noise
 * (4.9830000000000005) where the CSV holds the four decimals NBG set (4.983).
 */
function rateInTenThousandths(rate: number): number {
    return Math.round(rate * 10_000);
}

/**
 * The same codes, each with the same quantity and the same rate to four decimals; `excused` codes may be missing from
 * the right.
 */
function compareQuotes(
    left: QuoteSource,
    right: QuoteSource,
    excused: (code: string) => boolean,
): Result<void, string> {
    for (const [code, leftQuote] of left.quotes) {
        const rightQuote = right.quotes.get(code);
        if (rightQuote === undefined) {
            if (excused(code)) {
                continue;
            }
            return err(`${code} in ${left.label}, not in ${right.label}`);
        }
        if (leftQuote.quantity !== rightQuote.quantity) {
            return err(
                `${code} quantity ${leftQuote.quantity} in ${left.label}, ${rightQuote.quantity} in ${right.label}`,
            );
        }
        if (rateInTenThousandths(leftQuote.rate) !== rateInTenThousandths(rightQuote.rate)) {
            return err(`${code} rate ${leftQuote.rate} in ${left.label}, ${rightQuote.rate} in ${right.label}`);
        }
    }
    for (const code of right.quotes.keys()) {
        if (!left.quotes.has(code)) {
            return err(`${code} in ${right.label}, not in ${left.label}`);
        }
    }
    return ok(undefined);
}

/**
 * One table against its publication's rows: valid-from date, codes (AZN excused inside the gap), and each code's
 * quantity and rate.
 */
export function checkTableAgainstRows(
    validFrom: CalendarDate,
    table: NbgDay,
    rows: ReadonlyArray<NbgCsvRow>,
): Result<void, string> {
    const tableDate = tableValidFrom(table);
    if (tableDate !== validFrom) {
        return err(`table valid from ${tableDate}, not ${validFrom}`);
    }
    const stray = rows.find((row) => row.validFrom !== validFrom);
    if (stray !== undefined) {
        return err(`${stray.code} row valid from ${stray.validFrom}, not ${validFrom}`);
    }
    return compareQuotes(
        { label: 'the table', quotes: tableQuotes(table) },
        { label: 'the rows', quotes: appliedQuotes(rows) },
        (code) => code === AZN && inAznGap(validFrom),
    );
}

/** Both tables against the rows, and the two tables against each other. */
export function checkAgreement(
    validFrom: CalendarDate,
    en: NbgDay,
    ka: NbgDay,
    rows: ReadonlyArray<NbgCsvRow>,
): Result<void, string> {
    for (const [language, table] of [
        ['English', en],
        ['Georgian', ka],
    ] as const) {
        const checked = checkTableAgainstRows(validFrom, table, rows);
        if (!checked.ok) {
            return err(`${language} table: ${checked.error}`);
        }
    }
    // Inside the AZN gap the rows cannot vouch for AZN, so only this comparison covers it.
    const tables = compareQuotes(
        { label: 'English', quotes: tableQuotes(en) },
        { label: 'Georgian', quotes: tableQuotes(ka) },
        () => false,
    );
    return tables.ok ? tables : err(`English and Georgian tables: ${tables.error}`);
}

/** Equal rows in equal order on code, quantity, rate, diff, name and validFromDate; write stamps are ignored. */
export function sameTable(left: NbgDay, right: NbgDay): boolean {
    return (
        left.currencies.length === right.currencies.length &&
        left.currencies.every((row, index) => {
            const other = right.currencies[index];
            return (
                other !== undefined &&
                row.code === other.code &&
                row.quantity === other.quantity &&
                row.rate === other.rate &&
                row.diff === other.diff &&
                row.name === other.name &&
                row.validFromDate === other.validFromDate
            );
        })
    );
}

function rowKey(row: NbgCsvRow): string {
    return JSON.stringify([row.code, row.quantity, row.rate, row.publishedOn, row.validFrom]);
}

/** Equal as multisets of code, quantity, rate, publishedOn and validFrom. */
export function sameRows(left: ReadonlyArray<NbgCsvRow>, right: ReadonlyArray<NbgCsvRow>): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const leftKeys = left.map(rowKey).sort();
    const rightKeys = right.map(rowKey).sort();
    return leftKeys.every((key, index) => key === rightKeys[index]);
}

export function groupByValidFrom(rows: ReadonlyArray<NbgCsvRow>): ReadonlyMap<CalendarDate, ReadonlyArray<NbgCsvRow>> {
    const groups = new Map<CalendarDate, NbgCsvRow[]>();
    for (const row of rows) {
        const group = groups.get(row.validFrom);
        if (group === undefined) {
            groups.set(row.validFrom, [row]);
        } else {
            group.push(row);
        }
    }
    return groups;
}

/** Ascending dates that are new in `fetched`, differ, or are missing from it. */
export function changedPublications(
    fetched: ReadonlyMap<CalendarDate, ReadonlyArray<NbgCsvRow>>,
    stored: ReadonlyMap<CalendarDate, ReadonlyArray<NbgCsvRow>>,
): ReadonlyArray<CalendarDate> {
    const changed = new Set<CalendarDate>();
    for (const [validFrom, rows] of fetched) {
        const storedRows = stored.get(validFrom);
        if (storedRows === undefined || !sameRows(rows, storedRows)) {
            changed.add(validFrom);
        }
    }
    for (const validFrom of stored.keys()) {
        if (!fetched.has(validFrom)) {
            changed.add(validFrom);
        }
    }
    return [...changed].sort(); // YYYY-MM-DD sorts as text
}

/** What NBG's export returns for these currencies and dates, from stored rows: newest publication first. */
export function exportRows(
    stored: ReadonlyArray<{ readonly validFrom: CalendarDate; readonly rows: ReadonlyArray<NbgCsvRow> }>,
    currencies: ReadonlyArray<CurrencyCode>,
    start: CalendarDate,
    end: CalendarDate,
): ReadonlyArray<NbgCsvRow> {
    const wanted = new Set<string>(currencies);
    return stored
        .filter((entry) => entry.validFrom >= start && entry.validFrom <= end)
        .sort((left, right) => (left.validFrom < right.validFrom ? 1 : left.validFrom > right.validFrom ? -1 : 0))
        .flatMap((entry) => entry.rows.filter((row) => wanted.has(row.code)));
}

const calendarDate = z.string().transform((value, context) => {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        context.addIssue('not a real YYYY-MM-DD calendar date');
        return z.NEVER;
    }
    return parsed.value;
});

const storedRowsSchema = z.array(
    z.object({
        code: z.string().regex(/^[A-Z]{3}$/),
        quantity: z.number().refine(isNbgQuantity, 'quantity is not a power of ten up to 1e15'),
        rate: z.number().positive().refine(hasAtMostFourDecimals, 'more than four decimals'),
        publishedOn: calendarDate,
        validFrom: calendarDate,
    }),
);

export function parseStoredRows(json: unknown): Result<ReadonlyArray<NbgCsvRow>, string> {
    const parsed = storedRowsSchema.safeParse(json);
    if (!parsed.success) {
        return err(
            parsed.error.issues
                .slice(0, 3)
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('; '),
        );
    }
    return ok(parsed.data);
}
