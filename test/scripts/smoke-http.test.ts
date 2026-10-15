import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'smoke-http.ts');
const VERSION = '0.6.1';
const PREVIOUS = '0.6.0';
const TOOLS = ['nbg_convert', 'nbg_convert_many', 'nbg_get_rates', 'nbg_list_currencies', 'nbg_rate_history'];

interface Run {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/**
 * Stands in for the hosted endpoint. The nth GET / answers rootStatus with a page naming rootVersions[n], or the last
 * entry once the list runs out, the way the public URL names the version an alias still routes to for a moment after
 * it moves. Everything else answers as the new version does, so a run that gets past GET / passes.
 */
function fakeEndpoint(
    rootVersions: ReadonlyArray<string>,
    rootStatus = 200,
): {
    readonly server: Server;
    readonly rootRequests: () => number;
} {
    let rootRequests = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        if (request.method === 'GET' && request.url === '/') {
            const version = rootVersions[Math.min(rootRequests, rootVersions.length - 1)] ?? '';
            rootRequests += 1;
            response.writeHead(rootStatus, { 'content-type': 'text/html; charset=utf-8' });
            response.end(`<!doctype html>\n<p class="footer-meta">nbg-rates-mcp ${version}</p>\n`);
            return;
        }
        if (request.method === 'GET' && request.url === '/favicon.ico') {
            response.writeHead(200, { 'content-type': 'image/x-icon' });
            response.end(Buffer.from([0, 0, 1, 0, 1, 0]));
            return;
        }
        let body = '';
        request.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
        });
        request.on('end', () => {
            const message = JSON.parse(body) as { readonly id?: number; readonly method: string };
            if (message.method === 'notifications/initialized') {
                response.writeHead(202).end();
                return;
            }
            const results: Readonly<Record<string, unknown>> = {
                initialize: { protocolVersion: '2025-11-25', serverInfo: { name: 'nbg-rates', version: VERSION } },
                'tools/list': { tools: TOOLS.map((name) => ({ name })) },
                'tools/call': { content: [], structuredContent: { resultRounded: 25.99 } },
            };
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: results[message.method] }));
        });
    });
    return { server, rootRequests: () => rootRequests };
}

/** Runs the smoke test as the deploy step does, asynchronously, so this process keeps answering its requests. */
function runSmoke(server: Server, extra: ReadonlyArray<string> = []): Promise<Run> {
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, `http://127.0.0.1:${port}/mcp`, VERSION, ...extra]);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

describe('smoke-http.ts', () => {
    let server: Server | undefined;

    afterEach(() => {
        server?.close();
        server = undefined;
    });

    async function listening(endpoint: ReturnType<typeof fakeEndpoint>): Promise<Server> {
        server = endpoint.server;
        await new Promise<void>((resolve) => endpoint.server.listen(0, '127.0.0.1', resolve));
        return endpoint.server;
    }

    it('waits until GET / names the version three times in a row, then runs the checks', async () => {
        // The v0.6.1 deploy: the first GET / after the alias moved ran on the version it replaced.
        const endpoint = fakeEndpoint([PREVIOUS, VERSION, PREVIOUS, VERSION]);
        const { status, stdout, stderr } = await runSmoke(await listening(endpoint));
        expect(stderr).toBe('');
        expect(status).toBe(0);
        expect(stdout).toContain(`serves ${VERSION}, 10 USD = 25.99 GEL`);
        expect(endpoint.rootRequests()).toBe(6);
    });

    it('fails naming the version GET / serves when it does not name the new one in time', async () => {
        const endpoint = fakeEndpoint([PREVIOUS]);
        const { status, stderr } = await runSmoke(await listening(endpoint), ['2']);
        expect(status).toBe(1);
        expect(stderr).toBe(
            `smoke test failed: GET / did not name nbg-rates-mcp ${VERSION} 3 times in a row within 2 s; ` +
                `the last answer named nbg-rates-mcp ${PREVIOUS}\n`,
        );
        expect(endpoint.rootRequests()).toBeGreaterThanOrEqual(2);
    });

    it('fails at once when GET / answers a status other than 200', async () => {
        const endpoint = fakeEndpoint([VERSION], 502);
        const { status, stderr } = await runSmoke(await listening(endpoint));
        expect(status).toBe(1);
        expect(stderr).toContain('smoke test failed: GET / answered 502');
        expect(endpoint.rootRequests()).toBe(1);
    });

    it('refuses a wait that is not a number of seconds', async () => {
        const { status, stderr } = await runSmoke(await listening(fakeEndpoint([VERSION])), ['soon']);
        expect(status).toBe(2);
        expect(stderr).toContain('usage: node scripts/smoke-http.ts <url> <version> [wait-seconds]');
    });
});
