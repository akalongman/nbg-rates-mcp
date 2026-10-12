import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ApiGatewayV2Event } from './lambda.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

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
    });

    it('decodes a base64 body', async () => {
        const result = await handler(event('apigw-post-mcp-base64'));
        expect(result.statusCode).toBe(200);
        expect(firstMessage(result.body)).toMatchObject({ id: 1 });
    });

    it('answers GET / with the text', async () => {
        const result = await handler(event('apigw-get-root'));
        expect(result.statusCode).toBe(200);
        expect(result.headers['content-type']).toMatch(/^text\/plain/);
        expect(result.body).toContain('MCP endpoint: POST /mcp');
    });

    it('refuses a foreign host', async () => {
        const foreign = { ...event('apigw-get-root'), headers: { host: 'evil.example' } };
        const result = await handler(foreign);
        expect(result.statusCode).toBe(421);
    });
});
