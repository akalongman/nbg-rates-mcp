import { createServiceFromEnvironment, readPackageVersion } from './shell/environment.js';
import { handleIncoming } from './shell/http-adapter.js';
import { createHttpHandler, parseAllowedHosts, parseOpenAiChallenge } from './shell/http.js';

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

// The package's own package.json, zipped beside dist/.
const version = readPackageVersion(new URL('../package.json', import.meta.url));
const { service } = createServiceFromEnvironment(version, process.env);
const handle = createHttpHandler({
    service,
    now: () => new Date(),
    version,
    allowedHosts: parseAllowedHosts(process.env['NBG_RATES_HTTP_HOSTS']),
    openAiChallenge: parseOpenAiChallenge(process.env['NBG_RATES_OPENAI_CHALLENGE']),
    // Lambda forwards stdout to CloudWatch; one line per request, text format, fields discovered by Logs Insights.
    log: (line) => console.log(JSON.stringify(line)),
});

const TEXT_TYPE_PREFIXES: readonly string[] = ['text/', 'application/json', 'application/javascript'];

function isTextContentType(contentType: string | undefined): boolean {
    if (contentType === undefined) {
        return false;
    }
    const type = contentType.toLowerCase();
    return TEXT_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix)) || type.includes('charset=');
}

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
    const response = await handleIncoming(handle, {
        method: event.requestContext.http.method,
        url: `https://${host}${event.rawPath}${query}`,
        headers,
        body,
    });
    const text = isTextContentType(response.headers['content-type']);
    return {
        statusCode: response.status,
        headers: response.headers,
        // Text when the content type starts with text/, application/json or application/javascript or names a charset,
        // case-insensitive; any other body, one without a content type included, goes base64 encoded.
        body: text ? new TextDecoder().decode(response.body) : Buffer.from(response.body).toString('base64'),
        isBase64Encoded: !text,
    };
}
