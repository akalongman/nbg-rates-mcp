import { afterEach, describe, expect, it } from 'vitest';
import { serveHttp } from './http-node.js';

describe('serveHttp', () => {
    let close: (() => Promise<void>) | undefined;

    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('hands the handler a web Request built from the socket and writes its Response back', async () => {
        let seen: Request | undefined;
        const server = await serveHttp(
            async (request) => {
                seen = request;
                const body = new Uint8Array(await request.arrayBuffer());
                return new Response(`got ${body.byteLength} bytes`, {
                    status: 202,
                    headers: { 'content-type': 'text/plain', 'x-echo': request.headers.get('x-in') ?? '' },
                });
            },
            { port: 0, host: '127.0.0.1' },
        );
        // An arrow, not the method itself: @typescript-eslint/unbound-method rejects the bare reference.
        close = () => server.close();
        const response = await fetch(`http://127.0.0.1:${server.port}/mcp?x=1`, {
            method: 'POST',
            headers: { 'x-in': 'yes', 'content-type': 'application/octet-stream' },
            body: new Uint8Array([1, 2, 3]),
        });
        expect(response.status).toBe(202);
        expect(response.headers.get('x-echo')).toBe('yes');
        expect(await response.text()).toBe('got 3 bytes');
        expect(seen?.method).toBe('POST');
        expect(seen?.url).toBe(`http://127.0.0.1:${server.port}/mcp?x=1`);
    });

    it('serves a GET with no body', async () => {
        const server = await serveHttp(
            (request) => Promise.resolve(new Response(request.body === null ? 'no body' : 'body')),
            {
                port: 0,
                host: '127.0.0.1',
            },
        );
        close = () => server.close();
        expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe('no body');
    });
});
