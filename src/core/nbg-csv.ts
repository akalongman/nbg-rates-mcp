import { parseCalendarDate } from './dates.js';
import { isPowerOfTen } from './nbg-schema.js';
import { err, ok, type CalendarDate, type RatesError, type Result } from './types.js';

export const NBG_CSV_HEADER = 'Code,Quantity,Rate,Diff,Name,Date,ValidFromDate';

/** One publication from the CSV export. Name (Georgian only) and Diff (unsigned) are not kept. */
export interface NbgCsvRow {
    readonly code: string;
    readonly quantity: number;
    readonly rate: number;
    /** The CSV's Date column: the day NBG set the rate. */
    readonly publishedOn: CalendarDate;
    readonly validFrom: CalendarDate;
}

const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
/** At most four decimals, like every NBG rate since 1995: per-unit rounding relies on it. */
const RATE = /^\d+(\.\d{1,4})?$/;
const INTEGER = /^\d+$/;
const CODE = /^[A-Z]{3}$/;

function shapeChanged(detail: string): { readonly ok: false; readonly error: RatesError } {
    return err({ kind: 'upstream_shape_changed', detail });
}

function parseUsDate(value: string): CalendarDate | undefined {
    const match = US_DATE.exec(value);
    if (match === null) {
        return undefined;
    }
    const [, month = '', day = '', year = ''] = match;
    const parsed = parseCalendarDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    return parsed.ok ? parsed.value : undefined;
}

export function parseNbgCsv(text: string): Result<ReadonlyArray<NbgCsvRow>, RatesError> {
    const lines = text
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter((line) => line !== '');
    const [header, ...dataLines] = lines;
    if (header !== NBG_CSV_HEADER) {
        return shapeChanged(`unexpected CSV header: ${(header ?? '(empty)').slice(0, 80)}`);
    }
    const rows: NbgCsvRow[] = [];
    for (const [index, line] of dataLines.entries()) {
        const lineNumber = index + 2;
        if (line.includes('"')) {
            return shapeChanged(`CSV line ${lineNumber} has a quoted field`);
        }
        const fields = line.split(',');
        if (fields.length !== 7) {
            return shapeChanged(`CSV line ${lineNumber} has ${fields.length} fields, expected 7`);
        }
        const [code = '', quantityField = '', rateField = '', , , publishedField = '', validFromField = ''] = fields;
        const quantity = Number(quantityField);
        const publishedOn = parseUsDate(publishedField);
        const validFrom = parseUsDate(validFromField);
        if (
            !CODE.test(code) ||
            !INTEGER.test(quantityField) ||
            !isPowerOfTen(quantity) ||
            !RATE.test(rateField) ||
            Number(rateField) <= 0 ||
            publishedOn === undefined ||
            validFrom === undefined
        ) {
            return shapeChanged(`CSV line ${lineNumber} is malformed: ${line.slice(0, 80)}`);
        }
        rows.push({ code, quantity, rate: Number(rateField), publishedOn, validFrom });
    }
    return ok(rows);
}
