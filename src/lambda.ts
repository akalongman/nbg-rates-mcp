import { createServiceFromEnvironment, readPackageVersion } from './shell/environment.js';
import { fromWebResponse, toWebRequest } from './shell/http-adapter.js';
import { createHttpHandler, parseAllowedHosts } from './shell/http.js';

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
