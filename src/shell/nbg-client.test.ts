import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../test/helpers/fixture-server.js';
import { code, date } from '../../test/helpers/values.js';
import { createNbgClient } from './nbg-client.js';

const BLOCK_PAGE =
    '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>';

describe('createNbgClient', () => {
    let server: FixtureServer;

    beforeEach(async () => {
        server = await startFixtureServer();
    });

    afterEach(async () => {
        await server.close();
    });

    function client(overrides: { timeoutMs?: number; log?: (message: string) => void } = {}) {
        return createNbgClient({
            baseUrl: server.baseUrl,
            userAgent: 'nbg-rates-mcp/test',
            retryDelayMs: 5,
            ...overrides,
        });
    }

    describe('fetchDay', () => {
        it('fetches a day with the date in the query and the user agent header', async () => {
            const result = await client().fetchDay(date('2026-10-07'), 'en');
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.date).toBe('2026-10-07T00:00:00.000Z');
            }
            expect(server.requests).toHaveLength(1);
            expect(server.requests[0]?.url).toBe('/gw/api/ct/monetarypolicy/currencies/en/json?date=2026-10-07');
            expect(server.requests[0]?.headers['user-agent']).toBe('nbg-rates-mcp/test');
        });

        it('uses the ka path for Georgian', async () => {
            await client().fetchDay(date('2026-10-07'), 'ka');
            expect(server.requests[0]?.url).toContain('/currencies/ka/json');
        });

        it('maps an empty table to no_data_for_date', async () => {
            const result = await client().fetchDay(date('1995-01-01'), 'en');
            expect(result).toEqual({
                ok: false,
                error: { kind: 'no_data_for_date', date: '1995-01-01', currency: undefined },
            });
        });

        it('retries once after a 503 and succeeds', async () => {
            let calls = 0;
            server.setResponder(() => {
                calls += 1;
                return calls === 1 ? { status: 503, body: 'down', contentType: 'text/plain' } : undefined;
            });
            const result = await client().fetchDay(date('2026-10-07'), 'en');
            expect(result.ok).toBe(true);
            expect(server.requests).toHaveLength(2);
        });

        it('retries once after a 429 and succeeds', async () => {
            let calls = 0;
            server.setResponder(() => {
                calls += 1;
                return calls === 1 ? { status: 429, body: 'slow down', contentType: 'text/plain' } : undefined;
            });
            expect((await client().fetchDay(date('2026-10-07'), 'en')).ok).toBe(true);
            expect(server.requests).toHaveLength(2);
        });

        it('gives up after the second 503 with upstream_unavailable', async () => {
            server.setResponder(() => ({ status: 503, body: 'down', contentType: 'text/plain' }));
            const result = await client().fetchDay(date('2026-10-07'), 'en');
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe('upstream_unavailable');
                expect(result.error.kind === 'upstream_unavailable' && result.error.detail).toContain('503');
            }
            expect(server.requests).toHaveLength(2);
        });

        it('does not retry a 404', async () => {
            server.setResponder(() => ({ status: 404, body: 'gone', contentType: 'text/plain' }));
            const result = await client().fetchDay(date('2026-10-07'), 'en');
            expect(result.ok).toBe(false);
            expect(server.requests).toHaveLength(1);
        });

        it('times out and reports upstream_unavailable', async () => {
            server.setResponder(() => ({ status: 200, body: '[]', delayMs: 500 }));
            const result = await client({ timeoutMs: 50 }).fetchDay(date('2026-10-07'), 'en');
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe('upstream_unavailable');
            }
        });

        it('reports an HTML firewall block page as upstream_unavailable, without a retry', async () => {
            server.setResponder(() => ({ status: 200, body: BLOCK_PAGE, contentType: 'text/html; charset=utf-8' }));
            const result = await client().fetchDay(date('2026-10-07'), 'en');
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe('upstream_unavailable');
                expect(result.error.kind === 'upstream_unavailable' && result.error.detail).toContain('text/html');
            }
            expect(server.requests).toHaveLength(1);
        });

        it('reports a JSON content type with an unparseable body as upstream_unavailable', async () => {
            server.setResponder(() => ({ status: 200, body: '[{"date":' }));
            const result = await client().fetchDay(date('2026-10-07'), 'en');
            expect(result.ok === false && result.error.kind).toBe('upstream_unavailable');
        });

        it('reports parsed JSON that fails the schema as upstream_shape_changed', async () => {
            server.setResponder(() => ({ status: 200, body: '[{"date":"2026-10-07T00:00:00.000Z","items":[]}]' }));
            const result = await client().fetchDay(date('2026-10-07'), 'en');
            expect(result.ok === false && result.error.kind).toBe('upstream_shape_changed');
        });

        it('reports a connection failure as upstream_unavailable', async () => {
            const dead = createNbgClient({ baseUrl: 'http://127.0.0.1:1', userAgent: 'x', retryDelayMs: 1 });
            const result = await dead.fetchDay(date('2026-10-07'), 'en');
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe('upstream_unavailable');
            }
        });

        it('logs each request with status and duration when a logger is given', async () => {
            const lines: string[] = [];
            await client({ log: (line) => lines.push(line) }).fetchDay(date('2026-10-07'), 'en');
            expect(lines).toHaveLength(1);
            expect(lines[0]).toMatch(/GET .*date=2026-10-07 -> 200 in \d+ms/);
        });

        it('logs one line per attempt when the body fails after the status line', async () => {
            const lines: string[] = [];
            const brokenBody: typeof fetch = () =>
                Promise.resolve(
                    new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.error(new TypeError('terminated'));
                            },
                        }),
                        { status: 200, headers: { 'content-type': 'application/json' } },
                    ),
                );
            const result = await createNbgClient({
                baseUrl: server.baseUrl,
                userAgent: 'nbg-rates-mcp/test',
                retryDelayMs: 5,
                fetchImpl: brokenBody,
                log: (line) => lines.push(line),
            }).fetchDay(date('2026-10-07'), 'en');
            expect(result.ok).toBe(false);
            expect(lines).toHaveLength(2);
            for (const line of lines) {
                expect(line).toMatch(/GET .*date=2026-10-07 -> 200, then TypeError: terminated in \d+ms/);
            }
        });
    });

    describe('fetchRange', () => {
        it('asks the CSV export for a currency and a ValidFromDate range', async () => {
            const result = await client().fetchRange([code('USD')], date('2026-10-03'), date('2026-10-05'));
            expect(server.requests[0]?.url).toBe(
                '/gw/api/ct/monetarypolicy/currencies/export/csv?currencies=USD&start=2026-10-03&end=2026-10-05',
            );
            expect(result).toEqual({
                ok: true,
                value: [{ code: 'USD', quantity: 1, rate: 2.6039, publishedOn: '2026-10-02', validFrom: '2026-10-03' }],
            });
        });

        it('asks for several currencies in one export, one currencies parameter each', async () => {
            const result = await client().fetchRange(
                [code('AMD'), code('USD')],
                date('2026-10-03'),
                date('2026-10-03'),
            );
            expect(server.requests[0]?.url).toBe(
                '/gw/api/ct/monetarypolicy/currencies/export/csv?currencies=AMD&currencies=USD&start=2026-10-03&end=2026-10-03',
            );
            expect(result.ok && result.value.map((row) => row.code).sort()).toEqual(['AMD', 'USD']);
        });

        it('returns no rows for an unknown code', async () => {
            expect(await client().fetchRange([code('XXX')], date('2026-10-01'), date('2026-10-07'))).toEqual({
                ok: true,
                value: [],
            });
        });

        it('reports an HTML block page as upstream_unavailable, not as a changed CSV header', async () => {
            server.setResponder(() => ({ status: 200, body: BLOCK_PAGE, contentType: 'text/html' }));
            const result = await client().fetchRange([code('USD')], date('2026-10-01'), date('2026-10-07'));
            expect(result.ok === false && result.error.kind).toBe('upstream_unavailable');
        });

        it('reports a CSV with a changed header as upstream_shape_changed', async () => {
            server.setResponder(() => ({ status: 200, body: 'Code;Rate\n', contentType: 'application/csv' }));
            const result = await client().fetchRange([code('USD')], date('2026-10-01'), date('2026-10-07'));
            expect(result.ok === false && result.error.kind).toBe('upstream_shape_changed');
        });
    });
});
