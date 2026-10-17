import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { failingNbg } from '../test/helpers/failing-nbg.js';
import { startFixtureServer } from '../test/helpers/fixture-server.js';
import { toolCall } from '../test/helpers/mcp-http.js';
import { createMemoryMirrorStore, seedMirror } from '../test/helpers/memory-mirror-store.js';
import { publication, tableFixture } from '../test/helpers/publications.js';
import { date } from '../test/helpers/values.js';
import type {
    ApiGatewayV2Event,
    ApiGatewayV2Result,
    createLambdaHandler,
    LambdaContext,
    LambdaHandlerDeps,
} from './lambda.js';
import { FAVICON_ICO_BASE64 } from './shell/site/assets.generated.js';
import { HOSTED_SERVER_ICONS } from './shell/site/hosted.js';
import { SYNC_REQUEST_TIMEOUT_MS } from './shell/sync-publication.js';
import { notConfiguredLine, type SyncEvent, type SyncLogLine } from './shell/sync.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
/** What a browser sends when someone types the address. */
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function event(name: string): ApiGatewayV2Event {
    return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as ApiGatewayV2Event;
}

function firstMessage(body: string): Record<string, unknown> {
    const line = body.split('\n').find((l) => l.startsWith('data:')) ?? body;
    return JSON.parse(line.replace(/^data:\s*/, '')) as Record<string, unknown>;
}

/** An API Gateway event always has a result; only a sync event has none. */
function answered(result: ApiGatewayV2Result | undefined): ApiGatewayV2Result {
    if (result === undefined) {
        throw new Error('an API Gateway event got no result');
    }
    return result;
}

/** 10:00:02 in Tbilisi (UTC+4) on Thursday 2026-10-08, two seconds after the hourly run's scheduled time. */
const NOW = new Date('2026-10-08T06:00:02Z');
const SCHEDULED = '2026-10-08T06:00:00Z';
const CONTEXT: LambdaContext = { getRemainingTimeInMillis: () => 25_000 };

/** The fakes a handler is built over; `sync` is left out of `deps` when `withSync` is false. */
function fakes(withSync: boolean): {
    readonly deps: LambdaHandlerDeps;
    readonly http: Mock<LambdaHandlerDeps['http']>;
    readonly sync: Mock<NonNullable<LambdaHandlerDeps['sync']>>;
    readonly log: Mock<LambdaHandlerDeps['log']>;
    /** What remainingMs reported, read twice by each run. */
    readonly remaining: ReadonlyArray<number>;
} {
    const remaining: number[] = [];
    const http = vi.fn<LambdaHandlerDeps['http']>(() =>
        Promise.resolve(new Response('hello', { headers: { 'content-type': 'text/plain; charset=utf-8' } })),
    );
    const sync = vi.fn<NonNullable<LambdaHandlerDeps['sync']>>((event: SyncEvent, remainingMs: () => number) => {
        remaining.push(remainingMs(), remainingMs());
        const line: SyncLogLine = { ...notConfiguredLine(event, NOW), syncResult: 'ok', syncDetail: null };
        return Promise.resolve(line);
    });
    const log = vi.fn<LambdaHandlerDeps['log']>();
    const deps: LambdaHandlerDeps = { http, sync: withSync ? sync : undefined, log, now: () => NOW };
    return { deps, http, sync, log, remaining };
}

describe('lambda handler', () => {
    let handler: (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Result>;

    beforeAll(async () => {
        process.env['NBG_RATES_HTTP_HOSTS'] = 'nbg-rates.env.ge';
        process.env['NBG_RATES_BASE_URL'] = 'http://127.0.0.1:9';
        const lambda = await import('./lambda.js');
        handler = async (apiEvent) => answered(await lambda.handler(apiEvent));
    });

    it('answers an initialize carried as a plain body', async () => {
        const result = await handler(event('apigw-post-mcp'));
        expect(result.statusCode).toBe(200);
        expect(result.isBase64Encoded).toBe(false);
        expect(firstMessage(result.body)).toMatchObject({ id: 1, result: { serverInfo: { name: 'nbg-rates-mcp' } } });
        expect(firstMessage(result.body)).toMatchObject({ result: { serverInfo: { icons: HOSTED_SERVER_ICONS } } });
    });

    it('decodes a base64 body', async () => {
        const result = await handler(event('apigw-post-mcp-base64'));
        expect(result.statusCode).toBe(200);
        expect(firstMessage(result.body)).toMatchObject({ id: 1 });
    });

    it('answers GET / on the hosted host with the page', async () => {
        const result = await handler(event('apigw-get-root'));
        expect(result.statusCode).toBe(200);
        expect(result.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(result.body).toContain('<html lang="en">');
    });

    it('redirects a browser at /mcp through API Gateway', async () => {
        const browser = {
            ...event('apigw-get-root'),
            rawPath: '/mcp',
            headers: { host: 'nbg-rates.env.ge', accept: BROWSER_ACCEPT },
        };
        const result = await handler(browser);
        expect(result.statusCode).toBe(302);
        expect(result.headers['location']).toBe('/');
        expect(result.body).toBe('');
    });

    it('returns the favicon base64 encoded', async () => {
        const result = await handler({ ...event('apigw-get-root'), rawPath: '/favicon.ico' });
        expect(result.statusCode).toBe(200);
        expect(result.headers['content-type']).toBe('image/x-icon');
        expect(result.isBase64Encoded).toBe(true);
        expect(result.body).toBe(FAVICON_ICO_BASE64);
    });

    it('answers HEAD on a binary asset with its headers and an empty body', async () => {
        const head = { ...event('apigw-get-root'), rawPath: '/og.png', requestContext: { http: { method: 'HEAD' } } };
        const result = await handler(head);
        expect(result.statusCode).toBe(200);
        expect(result.headers['content-type']).toBe('image/png');
        expect(result.body).toBe('');
    });

    it('keeps text bodies as text', async () => {
        const robots = await handler({ ...event('apigw-get-root'), rawPath: '/robots.txt' });
        expect(robots.isBase64Encoded).toBe(false);
        expect(robots.body).toBe('User-agent: *\nDisallow: /mcp\n');
    });

    it('refuses a foreign host', async () => {
        const foreign = { ...event('apigw-get-root'), headers: { host: 'evil.example' } };
        const result = await handler(foreign);
        expect(result.statusCode).toBe(421);
    });

    // API Gateway answers TRACE and CONNECT itself; TRACK reaches the function in any case.
    it.each(['TRACK', 'track'])('answers 405 to %s, a method a web Request cannot carry', async (method) => {
        const forbidden = { ...event('apigw-get-root'), requestContext: { http: { method } } };
        const result = await handler(forbidden);
        expect(result.statusCode).toBe(405);
        expect(result.headers['allow']).toBe('GET, HEAD, POST');
        expect(result.body).toBe('Method not allowed.');
    });
});

describe('createLambdaHandler', () => {
    let makeHandler: typeof createLambdaHandler;

    beforeAll(async () => {
        ({ createLambdaHandler: makeHandler } = await import('./lambda.js'));
    });

    it.each([
        ['hourly', '2026-10-08T06:00:00Z', '2026-10-08T06:00:00.000Z'],
        ['window', '2026-10-08T17:01:00+04:00', '2026-10-08T13:01:00.000Z'],
    ] as const)('hands a %s sync event to the sync with its scheduled time as a Date', async (kind, sent, instant) => {
        const fake = fakes(true);
        const remaining = [25_000, 24_000];
        const context: LambdaContext = { getRemainingTimeInMillis: () => remaining.shift() ?? 0 };

        const result = await makeHandler(fake.deps)({ nbgRatesSync: kind, scheduledTime: sent }, context);

        expect(result).toBeUndefined();
        expect(fake.sync).toHaveBeenCalledTimes(1);
        const [event] = fake.sync.mock.calls[0] ?? [];
        expect(event?.kind).toBe(kind);
        expect(event?.scheduledTime).toBeInstanceOf(Date);
        expect(event?.scheduledTime.toISOString()).toBe(instant);
        // Asked of the context on each call, so the run sees its time shrink.
        expect(fake.remaining).toEqual([25_000, 24_000]);
        // The sync writes its own line; the handler adds none.
        expect(fake.log).not.toHaveBeenCalled();
        expect(fake.http).not.toHaveBeenCalled();
    });

    it('gives a sync run without a context no time left', async () => {
        const fake = fakes(true);

        await makeHandler(fake.deps)({ nbgRatesSync: 'hourly', scheduledTime: SCHEDULED });

        expect(fake.remaining).toEqual([0, 0]);
    });

    it('logs a mirror_not_configured line for a sync event when no table is configured', async () => {
        const fake = fakes(false);

        const result = await makeHandler(fake.deps)({ nbgRatesSync: 'hourly', scheduledTime: SCHEDULED }, CONTEXT);

        expect(result).toBeUndefined();
        expect(fake.log).toHaveBeenCalledTimes(1);
        expect(fake.log).toHaveBeenCalledWith(
            notConfiguredLine({ kind: 'hourly', scheduledTime: new Date(SCHEDULED) }, NOW),
        );
        expect(fake.log.mock.calls[0]?.[0]).toMatchObject({
            syncResult: 'failed',
            syncDetail: 'mirror_not_configured',
        });
        expect(fake.sync).not.toHaveBeenCalled();
    });

    it.each([
        ['a kind with no schedule', { nbgRatesSync: 'backfill' }],
        ['a kind with no schedule at a valid time', { nbgRatesSync: 'backfill', scheduledTime: SCHEDULED }],
        ['an unknown shape', { foo: 1 }],
        ['an invalid scheduled time', { nbgRatesSync: 'hourly', scheduledTime: 'not a time' }],
        ['a missing scheduled time', { nbgRatesSync: 'hourly' }],
        ['a request context without http', { nbgRatesSync: 'hourly', requestContext: {} }],
        ['null', null],
    ])('rejects %s as an unrecognized event', async (_case, event) => {
        for (const fake of [fakes(true), fakes(false)]) {
            await expect(makeHandler(fake.deps)(event, CONTEXT)).rejects.toThrow(/^unrecognized event$/);
            expect(fake.sync).not.toHaveBeenCalled();
            expect(fake.log).not.toHaveBeenCalled();
            expect(fake.http).not.toHaveBeenCalled();
        }
    });

    it('answers an API Gateway event through http', async () => {
        const fake = fakes(true);

        const result = await makeHandler(fake.deps)({ ...event('apigw-get-root'), rawQueryString: 'a=1' }, CONTEXT);

        expect(result).toEqual({
            statusCode: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
            body: 'hello',
            isBase64Encoded: false,
        });
        expect(fake.http).toHaveBeenCalledTimes(1);
        const [request] = fake.http.mock.calls[0] ?? [];
        expect(request?.method).toBe('GET');
        expect(request?.url).toBe('https://nbg-rates.env.ge/?a=1');
        expect(fake.sync).not.toHaveBeenCalled();
        expect(fake.log).not.toHaveBeenCalled();
    });
});

describe('lambda handler and NBG_RATES_MIRROR_TABLE', () => {
    afterEach(() => {
        vi.doUnmock('./shell/mirror-dynamodb.js');
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('runs a sync event over the named table, each NBG try bound to SYNC_REQUEST_TIMEOUT_MS', async () => {
        const store = createMemoryMirrorStore();
        const tableNames: string[] = [];
        vi.doMock('./shell/mirror-dynamodb.js', () => ({
            createDynamoMirrorStore(options: { readonly tableName: string }) {
                tableNames.push(options.tableName);
                return store;
            },
        }));
        vi.stubEnv('NBG_RATES_MIRROR_TABLE', ' nbg-rates-mirror ');
        const nbg = failingNbg();
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.resetModules();
        const { handler } = await import('./lambda.js');

        const result = await handler({ nbgRatesSync: 'hourly', scheduledTime: new Date().toISOString() }, CONTEXT);

        expect(result).toBeUndefined();
        expect(tableNames).toEqual(['nbg-rates-mirror']);
        // The run claimed itself in the store the module built.
        expect(store.writes).toEqual([{ operation: 'state', key: 'state/state' }]);
        // Two tries of the first NBG request: the client keeps its one retry, each try bound to 5,000 ms.
        expect(SYNC_REQUEST_TIMEOUT_MS).toBe(5_000);
        expect(nbg.timeouts).toEqual([5_000, 5_000]);
        // The sync's own line, once.
        expect(consoleLog).toHaveBeenCalledTimes(1);
        const line = JSON.parse(String(consoleLog.mock.calls[0]?.[0])) as unknown;
        expect(line).toMatchObject({
            syncRun: 'hourly',
            syncResult: 'failed',
            syncDetail: 'upstream_unavailable',
            nbgRequests: 1,
        });
    });

    it('shares its lookup scopes with the HTTP handler, so a request waits on one hanging past-table write', async () => {
        // Two past dates with their archive rows and no tables: each is asked of NBG and its table kept (rule 7).
        const pastDays = ['2026-10-02', '2026-10-03'];
        const store = createMemoryMirrorStore();
        await seedMirror(store, {
            archiveRows: pastDays.map((day) => {
                const { validFrom, rows, observedAt } = publication(tableFixture('en', day));
                return { validFrom, rows, observedAt };
            }),
            state: {
                span: { start: date('2026-10-06'), end: date('2026-10-09') },
                rowsStart: date('2026-10-01'),
                freshUntil: Date.now() + 3_600_000,
            },
        });
        const operations: string[] = [];
        // Every past-table write hangs until its own bound aborts it.
        store.before((operation) => {
            operations.push(operation);
            return operation === 'fill' ? new Promise<void>(() => undefined) : undefined;
        });
        vi.doMock('./shell/mirror-dynamodb.js', () => ({ createDynamoMirrorStore: () => store }));
        const server = await startFixtureServer();
        try {
            vi.stubEnv('NBG_RATES_MIRROR_TABLE', 'nbg-rates-mirror');
            vi.stubEnv('NBG_RATES_BASE_URL', server.baseUrl);
            vi.stubEnv('NBG_RATES_HTTP_HOSTS', 'nbg-rates.env.ge');
            vi.spyOn(console, 'log').mockImplementation(() => undefined);
            vi.resetModules();
            const { handler } = await import('./lambda.js');
            const items = pastDays.map((day) => ({ amount: 100, from: 'USD', to: 'GEL', date: day }));

            const result = answered(
                await handler(
                    { ...event('apigw-post-mcp'), body: JSON.stringify(toolCall('nbg_convert_many', { items })) },
                    CONTEXT,
                ),
            );

            expect(result.statusCode).toBe(200);
            expect(firstMessage(result.body)).toMatchObject({
                result: { structuredContent: { converted: 2, skipped: 0 } },
            });
            expect(
                server.requests.map((request) => new URL(request.url, server.baseUrl).searchParams.get('date')),
            ).toEqual(pastDays);
            // The first write's failure stops the request's writes: one per request, not one per date.
            expect(operations.filter((operation) => operation === 'fill')).toHaveLength(1);
        } finally {
            await server.close();
        }
    });

    it('loads no DynamoDB module for a blank variable and logs mirror_not_configured for a sync event', async () => {
        const loaded = vi.fn();
        vi.doMock('./shell/mirror-dynamodb.js', () => {
            loaded();
            return { createDynamoMirrorStore: () => createMemoryMirrorStore() };
        });
        vi.stubEnv('NBG_RATES_MIRROR_TABLE', '  ');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.resetModules();
        const { handler } = await import('./lambda.js');

        const result = await handler({ nbgRatesSync: 'window', scheduledTime: SCHEDULED }, CONTEXT);

        expect(result).toBeUndefined();
        expect(loaded).not.toHaveBeenCalled();
        expect(consoleLog).toHaveBeenCalledTimes(1);
        const line = JSON.parse(String(consoleLog.mock.calls[0]?.[0])) as unknown;
        expect(line).toMatchObject({ syncRun: 'window', syncResult: 'failed', syncDetail: 'mirror_not_configured' });
    });
});
