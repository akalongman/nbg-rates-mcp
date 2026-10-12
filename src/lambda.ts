import { readFileSync } from 'node:fs';
import { createSnapshotCache } from './shell/cache.js';
import { fromWebResponse, toWebRequest } from './shell/http-adapter.js';
import { createHttpHandler, parseAllowedHosts } from './shell/http.js';
import { createNbgClient } from './shell/nbg-client.js';
import { createRatesService } from './shell/rates-service.js';

/**
 * AWS Lambda entry behind an API Gateway HTTP API (payload format 2.0). The event and result interfaces name only the
 * fields read and written, so the package needs no AWS type package. Built as dist/lambda.js; the handler string is
 * dist/lambda.handler. The service and its cache live for the instance, so a warm instance answers a date once from
 * NBG and then from memory.
 */

export interface ApiGatewayV2Event {
    readonly rawPath: string;
    readonly rawQueryString: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly requestContext: { readonly http: { readonly method: string } };
    readonly body?: string;
    readonly isBase64Encoded: boolean;
}

export interface ApiGatewayV2Result {
    readonly statusCode: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly isBase64Encoded: boolean;
}

// JSON-parse boundary: the package's own package.json, zipped beside dist/.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
};

const baseUrl = (process.env['NBG_RATES_BASE_URL'] ?? 'https://nbg.gov.ge').replace(/\/+$/, '');
const debug = process.env['NBG_RATES_DEBUG'] === '1';
const client = createNbgClient({
    baseUrl,
    userAgent: `nbg-rates-mcp/${version} (+https://github.com/akalongman/nbg-rates-mcp)`,
    ...(debug ? { log: (message: string) => console.error(`[nbg-rates-mcp] ${message}`) } : {}),
});
const service = createRatesService({ client, cache: createSnapshotCache(), now: () => new Date() });
const handle = createHttpHandler({
    service,
    now: () => new Date(),
    version,
    allowedHosts: parseAllowedHosts(process.env['NBG_RATES_HTTP_HOSTS']),
    // Lambda forwards stdout to CloudWatch; one line per request, text format, fields discovered by Logs Insights.
    log: (line) => console.log(JSON.stringify(line)),
});

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Result> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(event.headers)) {
        if (value !== undefined) {
            headers[name.toLowerCase()] = value;
        }
    }
    const host = headers['host'] ?? 'localhost';
    const query = event.rawQueryString === '' ? '' : `?${event.rawQueryString}`;
    const body =
        event.body === undefined
            ? null
            : new Uint8Array(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
    const response = await fromWebResponse(
        await handle(
            toWebRequest({
                method: event.requestContext.http.method,
                url: `https://${host}${event.rawPath}${query}`,
                headers,
                body,
            }),
        ),
    );
    return {
        statusCode: response.status,
        headers: response.headers,
        // Every response this server produces is text.
        body: new TextDecoder().decode(response.body),
        isBase64Encoded: false,
    };
}
