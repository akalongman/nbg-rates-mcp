import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import { dirname, join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { SERVER_INSTRUCTIONS } from '../../src/shell/server.js';
import { convertManyOutput, convertOutput, getRatesOutput, rateHistoryOutput } from '../../src/shell/tool-schemas.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'dist', 'bin.js');
const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')));
const READY = /serving HTTP on (http:\/\/[^ ]+\/mcp)/;

interface HttpChild {
    readonly process: ChildProcess;
    readonly url: string;
    readonly stdout: string[];
}

/** Starts dist/bin.js --http on a free port and waits for the ready line on stderr. */
async function startHttpChild(baseUrl: string): Promise<HttpChild> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
            env[key] = value;
        }
    }
    env['NBG_RATES_BASE_URL'] = `${baseUrl}/`;
    env['NBG_RATES_HTTP_HOSTS'] = '127.0.0.1,nbg-rates.env.ge';
    env['TZ'] = 'America/Los_Angeles';
    const child = spawn(process.execPath, [BIN, '--http', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) =>
        stdout.push(
            ...chunk
                .toString('utf8')
                .split('\n')
                .filter((l) => l !== ''),
        ),
    );
    const url = await new Promise<string>((resolve, reject) => {
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
            const match = READY.exec(stderr);
            if (match?.[1] !== undefined) {
                resolve(match[1]);
            }
        });
        child.on('exit', (code) =>
            reject(new Error(`server exited with ${String(code)} before it was ready: ${stderr}`)),
        );
    });
    return { process: child, url, stdout };
}

interface RawResponse {
    readonly status: number | undefined;
    readonly headers: http.IncomingHttpHeaders;
    readonly body: Buffer;
}

/** A GET with the given Host header. fetch drops a Host header it is given, so this goes out on raw node:http. */
function rawGet(origin: string, path: string, host: string): Promise<RawResponse> {
    const { hostname, port } = new URL(origin);
    return new Promise((resolve, reject) => {
        http.request({ host: hostname, port: Number(port), path, headers: { host } }, (response) => {
            buffer(response).then(
                (body) => resolve({ status: response.statusCode, headers: response.headers, body }),
                reject,
            );
        })
            .on('error', reject)
            .end();
    });
}

async function connect(url: string): Promise<Client> {
    const client = new Client({ name: 'e2e-http', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
}

describe('nbg-rates-mcp over Streamable HTTP', () => {
    let fixture: FixtureServer;
    let child: HttpChild;
    let client: Client;

    beforeAll(async () => {
        fixture = await startFixtureServer();
        child = await startHttpChild(fixture.baseUrl);
        client = await connect(child.url);
    });

    afterAll(async () => {
        await client.close();
        child.process.kill();
        await fixture.close();
    });

    it('lists the tools and sends the instructions', async () => {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'nbg_convert',
            'nbg_convert_many',
            'nbg_get_rates',
            'nbg_list_currencies',
            'nbg_rate_history',
        ]);
        expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
        expect(client.getServerVersion()).toMatchObject({ name: 'nbg-rates-mcp', version });
    });

    it('answers a Sunday with the carried-over Saturday rate', async () => {
        const result = await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-10-04', currencies: ['USD'] },
        });
        expect(getRatesOutput.parse(result.structuredContent)).toMatchObject({
            requestedDate: '2026-10-04',
            effectiveDate: '2026-10-03',
            carriedOver: true,
        });
    });

    it('converts with an exact rounded result', async () => {
        const result = await client.callTool({
            name: 'nbg_convert',
            arguments: { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-07' },
        });
        const output = convertOutput.parse(result.structuredContent);
        expect(output.rate).toBe(2.6025);
        expect(output.resultRounded).toBe(26.03);
    });

    it('converts a batch with a per-item error and a total', async () => {
        const result = await client.callTool({
            name: 'nbg_convert_many',
            arguments: {
                items: [
                    { amount: 100, from: 'USD', to: 'GEL', date: '2026-10-01' },
                    { amount: 1, from: 'USD', to: 'GEL', date: '2026-13-01' },
                ],
            },
        });
        const output = convertManyOutput.parse(result.structuredContent);
        expect(output).toMatchObject({ converted: 1, skipped: 1, total: { to: 'GEL' } });
        expect(output.items[1]).toHaveProperty('error');
    });

    it('returns a history with its summary', async () => {
        const result = await client.callTool({
            name: 'nbg_rate_history',
            arguments: { currency: 'USD', from: '2026-10-01', to: '2026-10-07' },
        });
        const output = rateHistoryOutput.parse(result.structuredContent);
        expect(output.days).toHaveLength(7);
        expect(output.summary.min).toBeLessThanOrEqual(output.summary.max);
    });

    it('explains a word that is not a currency code', async () => {
        const result = await client.callTool({
            name: 'nbg_convert',
            arguments: { amount: 1, from: 'dollar', to: 'GEL' },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('not a currency code');
    });

    it('serves a second client from the warm cache and logs one line per request', async () => {
        const before = fixture.requests.length;
        const second = await connect(child.url);
        try {
            await second.callTool({ name: 'nbg_get_rates', arguments: { date: '2026-10-07', currencies: ['USD'] } });
        } finally {
            await second.close();
        }
        // 2026-10-07 English was fetched by the conversion above, so the second client costs NBG nothing.
        expect(fixture.requests.length).toBe(before);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const lines = child.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines.filter((line) => line['method'] === 'initialize')).toHaveLength(2);
        expect(lines.some((line) => line['method'] === 'tools/call' && line['tool'] === 'nbg_get_rates')).toBe(true);
        expect(JSON.stringify(lines)).not.toContain('2026-10-07');
    });

    it("logs an NBG outage on the request's line", async () => {
        // A date the warm cache has not seen, so the call reaches NBG; the client retries once, after 500 ms.
        fixture.setResponder((url) =>
            url.pathname === '/gw/api/ct/monetarypolicy/currencies/en/json' &&
            url.searchParams.get('date') === '2026-09-30'
                ? { status: 503, body: 'Service Unavailable', contentType: 'text/plain' }
                : undefined,
        );
        const before = child.stdout.length;
        try {
            const result = await client.callTool({
                name: 'nbg_convert',
                arguments: { amount: 10, from: 'USD', to: 'GEL', date: '2026-09-30' },
            });
            expect(result.isError).toBe(true);
        } finally {
            fixture.setResponder(undefined);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const lines = child.stdout.slice(before).map((line) => JSON.parse(line) as Record<string, unknown>);
        const calls = lines.filter((line) => line['method'] === 'tools/call');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ tool: 'nbg_convert', outcome: 'ok', nbgError: 'upstream_unavailable' });
    });

    it('answers GET / with the version and refuses a foreign host', async () => {
        const origin = new URL(child.url).origin;
        const root = await fetch(`${origin}/`);
        expect(root.status).toBe(200);
        expect(await root.text()).toContain(`nbg-rates-mcp ${version}`);
        expect((await rawGet(origin, '/', 'evil.example')).status).toBe(421);
    });

    it('serves the page for the hosted host, the text for 127.0.0.1 and the favicon', async () => {
        const origin = new URL(child.url).origin;
        const page = await rawGet(origin, '/', 'nbg-rates.env.ge');
        expect(page.status).toBe(200);
        expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(page.body.toString('utf8')).toContain(`nbg-rates-mcp ${version}`);
        expect(await (await fetch(`${origin}/`)).text()).toContain('MCP endpoint: POST /mcp');
        const favicon = await fetch(`${origin}/favicon.ico`);
        expect(favicon.headers.get('content-type')).toBe('image/x-icon');
        expect(
            Buffer.from(await favicon.arrayBuffer())
                .subarray(0, 4)
                .toString('hex'),
        ).toBe('00000100');
    });
});
