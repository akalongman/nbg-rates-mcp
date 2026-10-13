import * as http from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

    it('answers 500 with the constructor-name line when the URL cannot be built', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            let called = false;
            const server = await serveHttp(
                () => {
                    called = true;
                    return Promise.resolve(new Response('unreachable'));
                },
                { port: 0, host: '127.0.0.1' },
            );
            close = () => server.close();
            // fetch drops a Host header it is given, so the malformed host goes out on a raw node:http request.
            const answer = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
                http.request(
                    { host: '127.0.0.1', port: server.port, path: '/mcp', headers: { host: 'a:b' } },
                    (response) => {
                        let body = '';
                        response.setEncoding('utf8');
                        response.on('data', (chunk: string) => (body += chunk));
                        response.on('end', () => resolve({ status: response.statusCode, body }));
                    },
                )
                    .on('error', reject)
                    .end();
            });
            expect(answer).toEqual({ status: 500, body: 'Internal error' });
            expect(called).toBe(false);
            expect(consoleError.mock.calls).toEqual([['TypeError http handler failed']]);
        } finally {
            consoleError.mockRestore();
        }
    });

    // Node's parser refuses TRACK and hands CONNECT to the 'connect' event, so TRACE is the one that arrives here.
    it('answers 405 to TRACE without calling the handler or printing a failure', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            let called = false;
            const server = await serveHttp(
                () => {
                    called = true;
                    return Promise.resolve(new Response('unreachable'));
                },
                { port: 0, host: '127.0.0.1' },
            );
            close = () => server.close();
            // fetch refuses TRACE itself, so the request goes out on a raw node:http request.
            const answer = await new Promise<{ status: number | undefined; allow: string | undefined; body: string }>(
                (resolve, reject) => {
                    http.request(
                        { host: '127.0.0.1', port: server.port, path: '/mcp', method: 'TRACE' },
                        (response) => {
                            let body = '';
                            response.setEncoding('utf8');
                            response.on('data', (chunk: string) => (body += chunk));
                            response.on('end', () =>
                                resolve({ status: response.statusCode, allow: response.headers.allow, body }),
                            );
                        },
                    )
                        .on('error', reject)
                        .end();
                },
            );
            expect(answer).toEqual({ status: 405, allow: 'GET, HEAD, POST', body: 'Method not allowed.' });
            expect(called).toBe(false);
            expect(consoleError).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('prints nothing for a client that hangs up mid-upload', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            let called = false;
            const server = await serveHttp(
                () => {
                    called = true;
                    return Promise.resolve(new Response('unreachable'));
                },
                { port: 0, host: '127.0.0.1' },
            );
            close = () => server.close();
            await new Promise<void>((resolve, reject) => {
                const socket = connect(server.port, '127.0.0.1', () => {
                    // Three of the hundred bytes promised, then gone.
                    socket.end('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\nabc', () =>
                        socket.destroy(),
                    );
                });
                socket.on('error', reject).on('close', () => resolve());
            });
            // The server sees the hang-up as its body read failing; give that failure time to reach the catch.
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(called).toBe(false);
            expect(consoleError).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });
});
