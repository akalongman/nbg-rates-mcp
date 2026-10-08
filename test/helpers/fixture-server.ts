import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { csvExport, fixturePath } from './fixtures.js';

export type Responder = (
    url: URL,
) => { status: number; body: string; contentType?: string; delayMs?: number } | undefined;

export interface FixtureServer {
    readonly baseUrl: string;
    readonly requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }>;
    setResponder(responder: Responder | undefined): void;
    close(): Promise<void>;
}

const LATEST_FIXTURE_DATE = '2026-10-07';
const JSON_ROUTE = /^\/gw\/api\/ct\/monetarypolicy\/currencies\/(en|ka)\/json\/?$/;
const CSV_ROUTE = /^\/gw\/api\/ct\/monetarypolicy\/currencies\/export\/csv\/?$/;

/**
 * Mimics nbg.gov.ge: serves a recorded table per language and date (the latest table for any other date), and
 * the CSV export over the recorded csv-<CODE>.csv files with NBG's ValidFromDate filter.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
    const requests: FixtureServer['requests'] = [];
    let responder: Responder | undefined;

    const server: Server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        requests.push({ url: url.pathname + url.search, headers: request.headers });

        const custom = responder?.(url);
        if (custom !== undefined) {
            setTimeout(() => {
                response.writeHead(custom.status, { 'content-type': custom.contentType ?? 'application/json' });
                response.end(custom.body);
            }, custom.delayMs ?? 0);
            return;
        }

        const jsonMatch = JSON_ROUTE.exec(url.pathname);
        if (jsonMatch !== null) {
            const language = jsonMatch[1] ?? 'en';
            const date = url.searchParams.get('date') ?? LATEST_FIXTURE_DATE;
            const exact = fixturePath(`${language}-${date}`);
            const file = existsSync(exact) ? exact : fixturePath(`${language}-${LATEST_FIXTURE_DATE}`);
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(readFileSync(file));
            return;
        }

        if (CSV_ROUTE.test(url.pathname)) {
            const codes = url.searchParams.getAll('currencies');
            if (codes.length === 0) {
                response.writeHead(422, { 'content-type': 'application/json' });
                response.end('{"errors":[{"key":"currencies","value":["required"]}]}');
                return;
            }
            const start = url.searchParams.get('start') ?? '0000-00-00';
            const end = url.searchParams.get('end') ?? '9999-99-99';
            response.writeHead(200, { 'content-type': 'application/csv' });
            response.end(csvExport(codes, start, end));
            return;
        }

        response.writeHead(404).end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error(`fixture server is not listening on a TCP port: ${String(address)}`);
    }
    const { port } = address;

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        setResponder(next) {
            responder = next;
        },
        close() {
            return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
