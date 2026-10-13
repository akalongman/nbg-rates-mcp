import { describe, expect, it, vi } from 'vitest';
import { code, date } from '../../test/helpers/values.js';
import { err, ok, type RatesSnapshot } from '../core/types.js';
import {
    createHttpHandler,
    parseAllowedHosts,
    parseOpenAiChallenge,
    type HttpDeps,
    type RequestLogLine,
} from './http.js';
import type { RatesService } from './rates-service.js';
import { FAVICON_ICO_BASE64 } from './site/assets.generated.js';
import { PAGE_CONTENT_SECURITY_POLICY } from './site/page.js';

const SNAPSHOT: RatesSnapshot = {
    requestedDate: date('2026-10-07'),
    effectiveDate: date('2026-10-07'),
    carriedOver: false,
    rates: [{ code: code('USD'), name: 'US Dollar', rate: 2.6025, diff: -0.0007, nbgQuantity: 1, nbgRate: 2.6025 }],
    unknownCodes: [],
};

const service: RatesService = {
    getSnapshot: () => Promise.resolve(ok(SNAPSHOT)),
    getHistory: () => Promise.resolve(err({ kind: 'upstream_unavailable', detail: 'stub' })),
};

const ACCEPT = 'application/json, text/event-stream';
const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.2.3' },
    },
};
const CONVERT = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'nbg_convert', arguments: { amount: 123456.78, from: 'USD', to: 'GEL', date: '2026-10-07' } },
};

function handlerWith(overrides: Partial<HttpDeps> = {}, mcpFetch?: (request: Request) => Promise<Response>) {
    const lines: RequestLogLine[] = [];
    const handler = createHttpHandler(
        {
            service,
            now: () => new Date('2026-10-08T06:00:00Z'),
            version: '0.0.0-test',
            allowedHosts: ['nbg-rates.env.ge'],
            openAiChallenge: '',
            log: (line) => lines.push(line),
            ...overrides,
        },
        mcpFetch,
    );
    return { handler, lines };
}

function post(body: unknown, options: { host?: string; path?: string; accept?: string | null } = {}): Request {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.accept !== null) {
        headers['accept'] = options.accept ?? ACCEPT;
    }
    return new Request(`https://${options.host ?? 'nbg-rates.env.ge'}${options.path ?? '/mcp'}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

function get(path: string, options: { host?: string; method?: string } = {}): Request {
    return new Request(`https://${options.host ?? 'nbg-rates.env.ge'}${path}`, { method: options.method ?? 'GET' });
}

/** The first JSON-RPC message of a JSON or SSE response body. */
async function firstMessage(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    const line =
        text.startsWith('data:') || text.includes('\ndata:')
            ? text.split('\n').find((l) => l.startsWith('data:'))
            : text;
    return JSON.parse((line ?? '').replace(/^data:\s*/, '')) as Record<string, unknown>;
}

describe('parseAllowedHosts', () => {
    it('splits on commas, trims, drops empties and lower-cases', () => {
        expect(parseAllowedHosts(' nbg-rates.env.ge, Localhost ,,')).toEqual(['nbg-rates.env.ge', 'localhost']);
        expect(parseAllowedHosts(undefined)).toEqual([]);
        expect(parseAllowedHosts('  ')).toEqual([]);
    });
});

describe('parseOpenAiChallenge', () => {
    it('trims a pasted token and reads unset as empty', () => {
        expect(parseOpenAiChallenge('  token-123\n')).toBe('token-123');
        expect(parseOpenAiChallenge(undefined)).toBe('');
        expect(parseOpenAiChallenge(' \n')).toBe('');
    });
});

describe('createHttpHandler', () => {
    it('answers GET / with the version and the endpoint path', async () => {
        const { handler, lines } = handlerWith({ allowedHosts: [] });
        const response = await handler(new Request('https://localhost/'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
        expect(await response.text()).toBe(
            'nbg-rates-mcp 0.0.0-test. MCP endpoint: POST /mcp (Streamable HTTP). Source: https://github.com/akalongman/nbg-rates-mcp',
        );
        expect(lines).toEqual([]);
    });

    it('refuses a host that is not allowed with 421 and no log line', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(INITIALIZE, { host: 'evil.example' }));
        expect(response.status).toBe(421);
        expect(await response.text()).toBe('This server answers only for nbg-rates.env.ge.');
        expect(lines).toEqual([]);
    });

    it('accepts the allowed host with a port', async () => {
        const { handler } = handlerWith();
        const response = await handler(post(INITIALIZE, { host: 'nbg-rates.env.ge:443' }));
        expect(response.status).toBe(200);
        // URL parsing drops the default :443, so only a non-default port reaches the Host check.
        const nonDefaultPort = await handler(post(INITIALIZE, { host: 'nbg-rates.env.ge:8443' }));
        expect(nonDefaultPort.status).toBe(200);
    });

    it('skips the host check when no host is allowed', async () => {
        const { handler } = handlerWith({ allowedHosts: [] });
        const response = await handler(post(INITIALIZE, { host: 'anything.example' }));
        expect(response.status).toBe(200);
    });

    it('answers 404 with a hint for any other path', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(INITIALIZE, { path: '/other' }));
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('Not found. The MCP endpoint is /mcp.');
        expect(lines).toEqual([]);
    });

    it('serves /mcp/ and /mcp with a query as /mcp', async () => {
        const { handler } = handlerWith();
        expect((await handler(post(INITIALIZE, { path: '/mcp/' }))).status).toBe(200);
        expect((await handler(post(INITIALIZE, { path: '/mcp?x=1' }))).status).toBe(200);
    });

    it('initializes and logs the client, the protocol version and the method', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(INITIALIZE));
        expect(response.status).toBe(200);
        const message = await firstMessage(response);
        expect(message).toMatchObject({
            id: 1,
            result: { serverInfo: { name: 'nbg-rates-mcp', version: '0.0.0-test' } },
        });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
            method: 'initialize',
            tool: null,
            client: { name: 'test-client', version: '1.2.3' },
            protocolVersion: '2025-06-18',
            status: 200,
            outcome: 'ok',
        });
        expect(lines[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(lines[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('logs a tool call with its name and nothing of its arguments', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(CONVERT));
        expect(response.status).toBe(200);
        const message = await firstMessage(response);
        expect(message).toMatchObject({ id: 2, result: { structuredContent: { resultRounded: 321296.27 } } });
        expect(lines[0]).toMatchObject({ method: 'tools/call', tool: 'nbg_convert', client: null, outcome: 'ok' });
        const serialized = JSON.stringify(lines[0]);
        expect(serialized).not.toContain('123456');
        expect(serialized).not.toContain('USD');
        expect(serialized).not.toContain('2026-10-07');
        expect(Object.keys(lines[0] ?? {}).sort()).toEqual(
            ['client', 'durationMs', 'method', 'outcome', 'protocolVersion', 'status', 'time', 'tool'].sort(),
        );
    });

    it('reads the client from _meta when a request carries it there', async () => {
        const { handler, lines } = handlerWith();
        const body = {
            ...CONVERT,
            params: {
                ...CONVERT.params,
                _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'meta-client', version: '9.9.9' } },
            },
        };
        await handler(post(body));
        expect(lines[0]?.client).toEqual({ name: 'meta-client', version: '9.9.9' });
    });

    it('counts a tool that fails inside its result as ok, and a JSON-RPC error as error', async () => {
        const { handler, lines } = handlerWith();
        const failing = {
            ...CONVERT,
            params: { name: 'nbg_convert', arguments: { amount: 1, from: 'dollar', to: 'GEL' } },
        };
        const failed = await handler(post(failing));
        expect(await firstMessage(failed)).toMatchObject({ result: { isError: true } });
        expect(lines[0]?.outcome).toBe('ok');

        const unknown = await handler(post({ jsonrpc: '2.0', id: 3, method: 'no/such' }));
        expect(await firstMessage(unknown)).toHaveProperty('error');
        expect(lines[1]).toMatchObject({ method: 'no/such', tool: null, outcome: 'error' });
    });

    it('answers 406 to a POST without the SSE Accept and logs it as error', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(INITIALIZE, { accept: 'application/json' }));
        expect(response.status).toBe(406);
        expect(lines[0]).toMatchObject({ method: 'initialize', status: 406, outcome: 'error' });
    });

    it.each(['GET', 'DELETE'])('answers %s /mcp with 405 and Allow: POST', async (method) => {
        const { handler, lines } = handlerWith();
        const response = await handler(new Request('https://nbg-rates.env.ge/mcp', { method }));
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST');
        expect(await firstMessage(response)).toMatchObject({ error: { message: 'Method not allowed.' } });
        expect(lines[0]).toMatchObject({ status: 405, outcome: 'error' });
    });

    it('logs null fields for a body that is not JSON', async () => {
        const { handler, lines } = handlerWith();
        const request = new Request('https://nbg-rates.env.ge/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: ACCEPT },
            body: 'not json',
        });
        const response = await handler(request);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(lines[0]).toMatchObject({
            method: null,
            tool: null,
            client: null,
            protocolVersion: null,
            outcome: 'error',
        });
    });

    it('answers 500 and logs only the error class when the MCP handler fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const { handler, lines } = handlerWith({}, () => Promise.reject(new RangeError('secret amount 123456.78')));
            const response = await handler(post(CONVERT));
            expect(response.status).toBe(500);
            expect(await response.text()).toBe('Internal error');
            expect(lines[0]).toMatchObject({
                method: 'tools/call',
                tool: 'nbg_convert',
                status: 500,
                outcome: 'error',
            });
            expect(consoleError).toHaveBeenCalledWith('RangeError http handler failed');
            expect(JSON.stringify(consoleError.mock.calls)).not.toContain('123456');
        } finally {
            consoleError.mockRestore();
        }
    });

    it('keeps the response when the log callback throws', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const { handler } = handlerWith({
                log: () => {
                    throw new Error('disk full 123456.78');
                },
            });
            const response = await handler(post(INITIALIZE));
            expect(response.status).toBe(200);
            expect(consoleError).toHaveBeenCalledWith('Error http handler failed');
        } finally {
            consoleError.mockRestore();
        }
    });
});

describe('site paths', () => {
    it.each([
        ['/', 'text/html; charset=utf-8', 'public, max-age=300'],
        ['/ka', 'text/html; charset=utf-8', 'public, max-age=300'],
        ['/ka/', 'text/html; charset=utf-8', 'public, max-age=300'],
        ['/favicon.ico', 'image/x-icon', 'public, max-age=86400'],
        ['/icon.png', 'image/png', 'public, max-age=86400'],
        ['/apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
        ['/og.png', 'image/png', 'public, max-age=86400'],
        ['/robots.txt', 'text/plain; charset=utf-8', 'public, max-age=86400'],
    ])('answers GET %s with %s, its cache header and no log line', async (path, contentType, cacheControl) => {
        const { handler, lines } = handlerWith();
        const response = await handler(get(path));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(contentType);
        expect(response.headers.get('cache-control')).toBe(cacheControl);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(lines).toEqual([]);
    });

    it('serves the English page at / and the Georgian one at /ka, with a port and a query', async () => {
        const { handler } = handlerWith();
        const english = await handler(get('/?ref=x', { host: 'nbg-rates.env.ge:8443' }));
        expect(english.headers.get('content-security-policy')).toBe(PAGE_CONTENT_SECURITY_POLICY);
        const englishHtml = await english.text();
        expect(englishHtml).toContain('<html lang="en">');
        expect(englishHtml).toContain('nbg-rates-mcp 0.0.0-test');
        expect(await (await handler(get('/ka/'))).text()).toContain('<html lang="ka">');
    });

    it('keeps the one-line text at / and a 404 at /ka on any other host, and serves the icons there', async () => {
        const { handler } = handlerWith({ allowedHosts: [] });
        const root = await handler(get('/', { host: 'localhost:3000' }));
        expect(root.headers.get('content-type')).toMatch(/^text\/plain/);
        expect(await root.text()).toContain('MCP endpoint: POST /mcp');
        expect((await handler(get('/ka', { host: 'localhost:3000' }))).status).toBe(404);
        expect((await handler(get('/favicon.ico', { host: 'localhost:3000' }))).status).toBe(200);
    });

    it('answers HEAD with the headers and no body', async () => {
        const { handler } = handlerWith();
        for (const path of ['/', '/favicon.ico']) {
            const response = await handler(get(path, { method: 'HEAD' }));
            expect(response.status).toBe(200);
            expect(response.headers.get('cache-control')).not.toBeNull();
            expect(await response.text()).toBe('');
        }
    });

    it.each(['POST', 'PUT', 'DELETE'])('answers %s on a site path with 405 and Allow: GET, HEAD', async (method) => {
        const { handler, lines } = handlerWith();
        for (const path of ['/', '/ka', '/favicon.ico', '/robots.txt']) {
            const response = await handler(get(path, { method }));
            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('GET, HEAD');
            expect(await response.text()).toBe('Method not allowed.');
        }
        expect(lines).toEqual([]);
    });

    it('serves the favicon bytes and a robots.txt that keeps crawlers off /mcp', async () => {
        const { handler } = handlerWith();
        const favicon = new Uint8Array(await (await handler(get('/favicon.ico'))).arrayBuffer());
        expect(Buffer.from(favicon).equals(Buffer.from(FAVICON_ICO_BASE64, 'base64'))).toBe(true);
        expect(await (await handler(get('/robots.txt'))).text()).toBe('User-agent: *\nDisallow: /mcp\n');
    });

    it('answers the OpenAI challenge with the token alone, uncached, once one is set', async () => {
        const { handler, lines } = handlerWith({ openAiChallenge: 'token-123' });
        const response = await handler(get('/.well-known/openai-apps-challenge'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe('token-123');
        expect(lines).toEqual([]);
    });

    it('answers the challenge path 404 while no token is set', async () => {
        const { handler } = handlerWith();
        expect((await handler(get('/.well-known/openai-apps-challenge'))).status).toBe(404);
    });

    it('checks the host before any site path', async () => {
        const { handler } = handlerWith();
        expect((await handler(get('/favicon.ico', { host: 'evil.example' }))).status).toBe(421);
    });
});
