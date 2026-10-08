import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env['NBG_RATES_BASE_URL'] ?? 'https://nbg.gov.ge';
const API = `${BASE_URL}/gw/api/ct/monetarypolicy/currencies`;
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const USER_AGENT = 'nbg-rates-mcp fixture recorder (+https://github.com/akalongman/nbg-rates-mcp)';

const TABLES: ReadonlyArray<{ language: 'en' | 'ka'; date: string }> = [
    { language: 'en', date: '2026-10-01' },
    { language: 'en', date: '2026-10-02' },
    { language: 'en', date: '2026-10-03' },
    { language: 'en', date: '2026-10-04' },
    { language: 'en', date: '2026-10-05' },
    { language: 'en', date: '2026-10-06' },
    { language: 'en', date: '2026-10-07' },
    { language: 'ka', date: '2026-10-07' },
    { language: 'en', date: '2021-09-05' },
    { language: 'en', date: '2005-03-15' },
    { language: 'en', date: '1995-01-01' },
];

const CSV_EXPORTS: ReadonlyArray<{ code: string; start: string; end: string }> = [
    { code: 'USD', start: '2026-08-01', end: '2026-10-07' },
    { code: 'AMD', start: '2026-08-01', end: '2026-10-07' },
];

async function fetchOk(url: string): Promise<Response> {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) {
        throw new Error(`${url} -> HTTP ${response.status}`);
    }
    return response;
}

async function recordTable({ language, date }: { language: 'en' | 'ka'; date: string }): Promise<void> {
    const response = await fetchOk(`${API}/${language}/json?date=${date}`);
    const body: unknown = JSON.parse(await response.text());
    const target = join(FIXTURE_DIR, `${language}-${date}.json`);
    await writeFile(target, `${JSON.stringify(body, null, 4)}\n`);
    console.error(`recorded ${target}`);
}

async function recordCsv({ code, start, end }: { code: string; start: string; end: string }): Promise<void> {
    // Stored byte for byte (byte-order mark and line endings included): the parser must handle the real thing.
    // Read as bytes, because Response.text() decodes as UTF-8 and silently drops a leading byte-order mark.
    const response = await fetchOk(`${API}/export/csv?currencies=${code}&start=${start}&end=${end}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const target = join(FIXTURE_DIR, `csv-${code}.csv`);
    await writeFile(target, bytes);
    console.error(`recorded ${target}`);
}

async function main(): Promise<void> {
    await mkdir(FIXTURE_DIR, { recursive: true });
    for (const table of TABLES) {
        await recordTable(table);
    }
    for (const csvExport of CSV_EXPORTS) {
        await recordCsv(csvExport);
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
