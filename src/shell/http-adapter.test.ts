import { describe, expect, it } from 'vitest';
import { fromWebResponse, toWebRequest } from './http-adapter.js';

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
