import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ApiGatewayV2Event } from './lambda.js';
import { FAVICON_ICO_BASE64 } from './shell/site/assets.generated.js';
import { HOSTED_SERVER_ICONS } from './shell/site/hosted.js';

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

describe('lambda handler', () => {
    let handler: (
        event: ApiGatewayV2Event,
    ) => Promise<{ statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded: boolean }>;

    beforeAll(async () => {
        process.env['NBG_RATES_HTTP_HOSTS'] = 'nbg-rates.env.ge';
        process.env['NBG_RATES_BASE_URL'] = 'http://127.0.0.1:9';
        ({ handler } = await import('./lambda.js'));
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
