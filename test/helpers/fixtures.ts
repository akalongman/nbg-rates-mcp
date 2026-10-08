import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const CSV_HEADER = 'Code,Quantity,Rate,Diff,Name,Date,ValidFromDate';

export function fixturePath(name: string): string {
    return join(FIXTURE_DIR, `${name}.json`);
}

export function loadFixture(name: string): unknown {
    return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as unknown;
}

function usDateToIso(value: string): string {
    const [month = '', day = '', year = ''] = value.split('/');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Emulates the NBG CSV export over the recorded csv-<CODE>.csv files: the header is always present, rows are
 * filtered on ValidFromDate (inclusive, as NBG does), and a code without a recording contributes no rows.
 */
export function csvExport(codes: ReadonlyArray<string>, start: string, end: string): string {
    const rows = codes.flatMap((code) => {
        const path = join(FIXTURE_DIR, `csv-${code.toUpperCase()}.csv`);
        if (!existsSync(path)) {
            return [];
        }
        const [, ...lines] = readFileSync(path, 'utf8')
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/);
        return lines.filter((line) => {
            const validFrom = line.split(',')[6];
            if (validFrom === undefined) {
                return false;
            }
            const isoDate = usDateToIso(validFrom);
            return isoDate >= start && isoDate <= end;
        });
    });
    return `\uFEFF${[CSV_HEADER, ...rows].join('\r\n')}\r\n`;
}
