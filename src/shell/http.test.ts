import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fixturePath } from '../../test/helpers/fixtures.js';
import { code, date } from '../../test/helpers/values.js';
import { err, ok, type RatesError, type RatesSnapshot, type Result } from '../core/types.js';
import { createSnapshotCache } from './cache.js';
import {
    createHttpHandler,
    parseAllowedHosts,
    parseOpenAiChallenge,
    type HttpDeps,
    type RequestLogLine,
} from './http.js';
import { createNbgClient } from './nbg-client.js';
import { createRatesService, type RatesService } from './rates-service.js';
import { FAVICON_ICO_BASE64 } from './site/assets.generated.js';
import { HOSTED_SERVER_ICONS } from './site/hosted.js';
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
/** What a browser sends when someone types the address. */
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
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

/** A subscriptions/listen as the SDK client sends it after server/discover (Claude Code opens one too). */
const LISTEN = {
    jsonrpc: '2.0',
    id: 'listen:0',
    method: 'subscriptions/listen',
    params: {
        _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.2.3' },
            'io.modelcontextprotocol/clientCapabilities': {},
        },
        notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
    },
};
const LISTEN_HEADERS = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen' };

const UNAVAILABLE: RatesError = { kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' };
const SHAPE_CHANGED: RatesError = { kind: 'upstream_shape_changed', detail: 'missing header' };

function toolCall(name: string, args: Record<string, unknown>) {
    return { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name, arguments: args } };
}

/** The test service with getSnapshot answering the given result for every date. */
function snapshotAnswering(result: Result<RatesSnapshot, RatesError>): RatesService {
    return { ...service, getSnapshot: () => Promise.resolve(result) };
}

function handlerWith(overrides: Partial<HttpDeps> = {}, mcpFetch?: (request: Request) => Promise<Response>) {
    const lines: RequestLogLine[] = [];
    const handler = createHttpHandler(
        {
            service,
            now: () => new Date('2026-10-08T06:00:00Z'),
            version: '0.0.0-test',
            allowedHosts: ['nbg-rates.env.ge'],
            openAiChallenge: '',
            serverIcons: [],
            log: (line) => lines.push(line),
            ...overrides,
        },
        mcpFetch,
    );
    return { handler, lines };
}

function post(
    body: unknown,
    options: { host?: string; path?: string; accept?: string | null; headers?: Record<string, string> } = {},
): Request {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
    if (options.accept !== null) {
        headers['accept'] = options.accept ?? ACCEPT;
    }
    return new Request(`https://${options.host ?? 'nbg-rates.env.ge'}${options.path ?? '/mcp'}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

function get(path: string, options: { host?: string; method?: string; accept?: string } = {}): Request {
    return new Request(`https://${options.host ?? 'nbg-rates.env.ge'}${path}`, {
        method: options.method ?? 'GET',
        headers: options.accept === undefined ? {} : { accept: options.accept },
    });
}

/** The response, rejected when the handler has not answered within a second. */
async function answeredWithinASecond(pending: Promise<Response>): Promise<Response> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the handler held the request open for over a second')), 1000);
    });
    try {
        return await Promise.race([pending, late]);
    } finally {
        clearTimeout(timer);
    }
}

/** Every JSON-RPC message on the data: lines of an SSE response body, in order. */
async function allMessages(response: Response): Promise<Record<string, unknown>[]> {
    return (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.replace(/^data:\s*/, '')) as Record<string, unknown>);
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

    it('sends the server icons it is given in serverInfo, and no icons key without them', async () => {
        const hosted = handlerWith({ serverIcons: HOSTED_SERVER_ICONS });
        const hostedMessage = await firstMessage(await hosted.handler(post(INITIALIZE)));
        expect(hostedMessage).toHaveProperty(['result', 'serverInfo', 'icons'], HOSTED_SERVER_ICONS);

        const local = handlerWith();
        const localMessage = await firstMessage(await local.handler(post(INITIALIZE)));
        expect(localMessage).toHaveProperty(['result', 'serverInfo', 'name'], 'nbg-rates-mcp');
        expect(localMessage).not.toHaveProperty(['result', 'serverInfo', 'icons']);
    });

    it('logs a tool call with its name and nothing of its arguments', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(CONVERT));
        expect(response.status).toBe(200);
        const message = await firstMessage(response);
        expect(message).toMatchObject({ id: 2, result: { structuredContent: { resultRounded: 321296.27 } } });
        expect(lines[0]).toMatchObject({
            method: 'tools/call',
            tool: 'nbg_convert',
            client: null,
            outcome: 'ok',
            nbgError: null,
        });
        const serialized = JSON.stringify(lines[0]);
        expect(serialized).not.toContain('123456');
        expect(serialized).not.toContain('USD');
        expect(serialized).not.toContain('2026-10-07');
        expect(Object.keys(lines[0] ?? {}).sort()).toEqual(
            [
                'client',
                'durationMs',
                'method',
                'nbgError',
                'outcome',
                'protocolVersion',
                'status',
                'time',
                'tool',
            ].sort(),
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

    // The handler buffers every body, so a listen stream left open is never answered: on Lambda the process exits
    // with the request pending (Runtime.ExitError, a 500), and the local server holds the request forever.
    it('ends a subscriptions/listen stream at once, since no list ever changes', async () => {
        const { handler, lines } = handlerWith();
        const response = await answeredWithinASecond(handler(post(LISTEN, { headers: LISTEN_HEADERS })));
        expect(response.status).toBe(200);
        const [acknowledged, closed, ...rest] = await allMessages(response);
        expect(acknowledged).toMatchObject({ method: 'notifications/subscriptions/acknowledged' });
        expect(acknowledged).toHaveProperty('params.notifications', {});
        expect(closed).toMatchObject({ id: 'listen:0', result: { resultType: 'complete' } });
        expect(rest).toEqual([]);
        expect(lines[0]).toMatchObject({ method: 'subscriptions/listen', status: 200, outcome: 'ok' });
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
                nbgError: null,
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

describe('createHttpHandler nbgError', () => {
    it.each([
        ['nbg_convert', { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-07' }],
        ['nbg_get_rates', { date: '2026-10-07', currencies: ['USD'] }],
        ['nbg_list_currencies', {}],
    ])('logs the NBG failure a tool call met (%s)', async (tool, args) => {
        const { handler, lines } = handlerWith({ service: snapshotAnswering(err(UNAVAILABLE)) });
        const response = await handler(post(toolCall(tool, args)));
        expect(await firstMessage(response)).toMatchObject({ result: { isError: true } });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ tool, outcome: 'ok', nbgError: 'upstream_unavailable' });
    });

    it('logs a history that NBG answered in a changed shape', async () => {
        const { handler, lines } = handlerWith({
            service: { ...service, getHistory: () => Promise.resolve(err(SHAPE_CHANGED)) },
        });
        const response = await handler(
            post(toolCall('nbg_rate_history', { currency: 'USD', from: '2026-10-01', to: '2026-10-07' })),
        );
        expect(await firstMessage(response)).toMatchObject({ result: { isError: true } });
        expect(lines[0]).toMatchObject({ tool: 'nbg_rate_history', outcome: 'ok', nbgError: 'upstream_shape_changed' });
    });

    it('logs an outage that nbg_convert_many reports item by item', async () => {
        const { handler, lines } = handlerWith({ service: snapshotAnswering(err(UNAVAILABLE)) });
        const items = [
            { amount: 100, from: 'USD', to: 'GEL', date: '2026-10-06' },
            { amount: 200, from: 'USD', to: 'GEL', date: '2026-10-07' },
        ];
        const response = await handler(post(toolCall('nbg_convert_many', { items })));
        const message = await firstMessage(response);
        expect(message).toMatchObject({ result: { structuredContent: { converted: 0, skipped: 2 } } });
        expect(message).not.toHaveProperty(['result', 'isError'], true);
        expect(lines[0]).toMatchObject({ tool: 'nbg_convert_many', outcome: 'ok', nbgError: 'upstream_unavailable' });
    });

    it('logs an NBG failure behind the rates resource', async () => {
        const { handler, lines } = handlerWith({ service: snapshotAnswering(err(UNAVAILABLE)) });
        const response = await handler(
            post({ jsonrpc: '2.0', id: 11, method: 'resources/read', params: { uri: 'nbg://rates/2026-10-07' } }),
        );
        expect(await firstMessage(response)).toHaveProperty('error');
        expect(lines[0]).toMatchObject({
            method: 'resources/read',
            tool: null,
            outcome: 'error',
            nbgError: 'upstream_unavailable',
        });
    });

    it("leaves nbgError null for the user's own mistakes", async () => {
        const notPublished = handlerWith({
            service: snapshotAnswering(
                err({
                    kind: 'rate_not_published',
                    date: date('2026-10-09'),
                    latestEffectiveDate: date('2026-10-07'),
                    today: date('2026-10-08'),
                }),
            ),
        });
        const early = await notPublished.handler(
            post(toolCall('nbg_convert', { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-09' })),
        );
        expect(await firstMessage(early)).toMatchObject({ result: { isError: true } });

        const { handler, lines } = handlerWith();
        const unknown = await handler(
            post(toolCall('nbg_convert', { amount: 10, from: 'XYZ', to: 'GEL', date: '2026-10-07' })),
        );
        expect(JSON.stringify(await firstMessage(unknown))).toContain('NBG did not quote XYZ');
        const malformed = await handler(post(toolCall('nbg_convert', { amount: 1, from: 'dollar', to: 'GEL' })));
        expect(await firstMessage(malformed)).toMatchObject({ result: { isError: true } });

        expect([...notPublished.lines, ...lines].map((line) => line.nbgError)).toEqual([null, null, null]);
    });

    it('marks only the request whose lookup failed when two run at once', async () => {
        let releaseFailing: () => void = () => undefined;
        const otherStarted = new Promise<void>((resolve) => {
            releaseFailing = resolve;
        });
        const gated: RatesService = {
            ...service,
            async getSnapshot({ date: requested }) {
                if (requested === date('2026-10-06')) {
                    // Fails only once the other request is inside its own lookup, so the two overlap.
                    await otherStarted;
                    return err(UNAVAILABLE);
                }
                releaseFailing();
                return ok(SNAPSHOT);
            },
        };
        const { handler, lines } = handlerWith({ service: gated });
        await Promise.all([
            handler(post(toolCall('nbg_convert', { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-06' }))),
            handler(post(toolCall('nbg_get_rates', { date: '2026-10-07', currencies: ['USD'] }))),
        ]);
        expect(lines).toHaveLength(2);
        expect(lines.find((line) => line.tool === 'nbg_convert')).toMatchObject({ nbgError: 'upstream_unavailable' });
        expect(lines.find((line) => line.tool === 'nbg_get_rates')).toMatchObject({ nbgError: null });
    });

    it('does not count a lookup whose retry succeeded', async () => {
        const body = readFileSync(fixturePath('en-2026-10-07'), 'utf8');
        const fetchImpl = vi.fn<typeof fetch>();
        fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed'));
        fetchImpl.mockImplementation(() =>
            Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
        );
        const now = () => new Date('2026-10-08T06:00:00Z');
        const realService = createRatesService({
            client: createNbgClient({ baseUrl: 'https://nbg.example', userAgent: 'test', retryDelayMs: 0, fetchImpl }),
            cache: createSnapshotCache(),
            now,
        });
        const { handler, lines } = handlerWith({ service: realService, now });
        const response = await handler(
            post(toolCall('nbg_convert', { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-07' })),
        );
        expect(await firstMessage(response)).toMatchObject({ result: { structuredContent: { resultRounded: 26.03 } } });
        expect(lines[0]).toMatchObject({ tool: 'nbg_convert', outcome: 'ok', nbgError: null });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
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

    it.each(['/mcp', '/mcp/', '/mcp?ref=card'])('sends a browser that opens %s to the landing page', async (path) => {
        const { handler, lines } = handlerWith();
        const response = await handler(get(path, { accept: BROWSER_ACCEPT }));
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(await response.text()).toBe('');
        expect(lines).toEqual([]);
    });

    it('answers a browser HEAD /mcp with the same redirect and no body', async () => {
        const { handler } = handlerWith();
        const response = await handler(get('/mcp', { method: 'HEAD', accept: BROWSER_ACCEPT }));
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/');
        expect(await response.text()).toBe('');
    });

    it('reads the Accept header without regard to case', async () => {
        const { handler } = handlerWith();
        expect((await handler(get('/mcp', { accept: 'TEXT/HTML' }))).status).toBe(302);
    });

    it.each(['text/event-stream', 'text/html, text/event-stream', 'application/json, text/event-stream'])(
        'keeps MCP clients on 405 at /mcp',
        async (accept) => {
            const { handler, lines } = handlerWith();
            const response = await handler(get('/mcp', { accept }));
            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('POST');
            expect(lines).toHaveLength(1);
            expect(lines[0]).toMatchObject({ method: null, status: 405 });
        },
    );

    it('keeps the 405 on any other host', async () => {
        const { handler } = handlerWith({ allowedHosts: [] });
        const response = await handler(get('/mcp', { host: 'example.test', accept: BROWSER_ACCEPT }));
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST');
    });
});
