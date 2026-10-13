import { describe, expect, it } from 'vitest';
import { fromWebResponse, handleIncoming, toWebRequest } from './http-adapter.js';

const BYTES = new Uint8Array([0, 255, 10, 13, 128]);

describe('toWebRequest', () => {
    it('carries method, url, headers and a binary body', async () => {
        const request = toWebRequest({
            method: 'POST',
            url: 'https://nbg-rates.env.ge/mcp?x=1',
            headers: { 'content-type': 'application/octet-stream', accept: 'application/json, text/event-stream' },
            body: BYTES,
        });
        expect(request.method).toBe('POST');
        expect(request.url).toBe('https://nbg-rates.env.ge/mcp?x=1');
        expect(request.headers.get('accept')).toBe('application/json, text/event-stream');
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(BYTES);
    });

    it('builds a GET without a body even when the transport hands an empty one', () => {
        const request = toWebRequest({
            method: 'GET',
            url: 'https://nbg-rates.env.ge/',
            headers: {},
            body: new Uint8Array(0),
        });
        expect(request.method).toBe('GET');
        expect(request.body).toBeNull();
    });
});

describe('handleIncoming', () => {
    it('runs the request through the handler and buffers its response', async () => {
        const outgoing = await handleIncoming((request) => Promise.resolve(new Response(`saw ${request.method}`)), {
            method: 'post',
            url: 'https://nbg-rates.env.ge/mcp',
            headers: {},
            body: BYTES,
        });
        expect(outgoing.status).toBe(200);
        expect(new TextDecoder().decode(outgoing.body)).toBe('saw POST');
    });

    it.each(['CONNECT', 'TRACE', 'TRACK', 'track'])('answers 405 to %s without calling the handler', async (method) => {
        let called = false;
        const outgoing = await handleIncoming(
            () => {
                called = true;
                return Promise.resolve(new Response('unreachable'));
            },
            { method, url: 'https://nbg-rates.env.ge/mcp', headers: {}, body: null },
        );
        expect(outgoing.status).toBe(405);
        expect(outgoing.headers).toEqual({ allow: 'GET, HEAD, POST', 'content-type': 'text/plain; charset=utf-8' });
        expect(new TextDecoder().decode(outgoing.body)).toBe('Method not allowed.');
        expect(called).toBe(false);
    });
});

describe('fromWebResponse', () => {
    it('buffers the body and flattens the headers', async () => {
        const response = new Response('{"ok":true}', {
            status: 201,
            headers: { 'content-type': 'application/json', 'x-one': '1' },
        });
        const outgoing = await fromWebResponse(response);
        expect(outgoing.status).toBe(201);
        expect(outgoing.headers).toEqual({ 'content-type': 'application/json', 'x-one': '1' });
        expect(new TextDecoder().decode(outgoing.body)).toBe('{"ok":true}');
    });

    it('joins a repeated header with a comma and a space', async () => {
        const headers = new Headers();
        headers.append('x-many', 'a');
        headers.append('x-many', 'b');
        const outgoing = await fromWebResponse(new Response(null, { status: 204, headers }));
        expect(outgoing.headers['x-many']).toBe('a, b');
        expect(outgoing.body.byteLength).toBe(0);
    });
});
