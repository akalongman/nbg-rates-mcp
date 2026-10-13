import { CLIENT_INFO_META_KEY, createMcpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { RatesService } from './rates-service.js';
import { createServer } from './server.js';

/**
 * The HTTP face of the server: Host validation, path routing and one log line per MCP request around the SDK's
 * stateless Streamable HTTP handler. Host-neutral: http-node.ts serves it on a port, lambda.ts behind API Gateway.
 */

export interface RequestLogLine {
    /** ISO 8601, UTC. */
    readonly time: string;
    /** The JSON-RPC method, null when the body is not a request. */
    readonly method: string | null;
    /** params.name of a tools/call, else null. */
    readonly tool: string | null;
    readonly client: { readonly name: string; readonly version: string } | null;
    readonly protocolVersion: string | null;
    readonly status: number;
    readonly outcome: 'ok' | 'error';
    readonly durationMs: number;
}

export interface HttpDeps {
    readonly service: RatesService;
    readonly now: () => Date;
    readonly version: string;
    /** Host names the endpoint answers for; empty disables the check. */
    readonly allowedHosts: readonly string[];
    readonly log: (line: RequestLogLine) => void;
}

const SOURCE_URL = 'https://github.com/akalongman/nbg-rates-mcp';
const ENDPOINT_PATH = '/mcp';

/** Splits NBG_RATES_HTTP_HOSTS: comma separated, trimmed, lower-cased, empties dropped. */
export function parseAllowedHosts(value: string | undefined): readonly string[] {
    return (value ?? '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host !== '');
}

const clientInfo = z.object({ name: z.string(), version: z.string() });

/** The only parts of a request body the log line reads; everything else is never looked at. */
const requestSummary = z.object({
    method: z.string(),
    params: z
        .object({
            name: z.string().optional(),
            protocolVersion: z.string().optional(),
            clientInfo: clientInfo.optional(),
            _meta: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
});

type Summary = Pick<RequestLogLine, 'method' | 'tool' | 'client' | 'protocolVersion'>;

const EMPTY_SUMMARY: Summary = { method: null, tool: null, client: null, protocolVersion: null };

function summarize(body: string): Summary {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return EMPTY_SUMMARY;
    }
    const summary = requestSummary.safeParse(parsed);
    if (!summary.success) {
        return EMPTY_SUMMARY;
    }
    const { method, params } = summary.data;
    const metaClient = clientInfo.safeParse(params?._meta?.[CLIENT_INFO_META_KEY]);
    return {
        method,
        tool: method === 'tools/call' ? (params?.name ?? null) : null,
        client: params?.clientInfo ?? (metaClient.success ? metaClient.data : null),
        protocolVersion: params?.protocolVersion ?? null,
    };
}

function hasErrorMember(text: string): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return false;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some((message) => typeof message === 'object' && message !== null && 'error' in message);
}

/** A JSON body is one message; an SSE body (the SDK's default for 2025-era clients) carries them on data: lines. */
function carriesJsonRpcError(contentType: string | null, body: string): boolean {
    if (contentType?.includes('application/json') === true) {
        return hasErrorMember(body);
    }
    if (contentType?.includes('text/event-stream') === true) {
        return body
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .some((line) => hasErrorMember(line.slice('data:'.length)));
    }
    return false;
}

function text(status: number, body: string): Response {
    return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** The one stderr line for a failed request, shared with http-node.ts. */
export function reportFailure(error: unknown): void {
    const name = error instanceof Error ? error.constructor.name : 'Error';
    // Never the message: it can quote the request URL, headers, body or a user's arguments.
    console.error(`${name} http handler failed`);
}

function defaultMcpFetch(deps: HttpDeps): (request: Request) => Promise<Response> {
    const handler = createMcpHandler(
        () => createServer({ service: deps.service, now: deps.now, version: deps.version }),
        { legacy: 'stateless' },
    );
    return handler.fetch;
}

export function createHttpHandler(
    deps: HttpDeps,
    mcpFetch: (request: Request) => Promise<Response> = defaultMcpFetch(deps),
): (request: Request) => Promise<Response> {
    return async function handle(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (deps.allowedHosts.length > 0 && !deps.allowedHosts.includes(url.hostname.toLowerCase())) {
            return text(421, `This server answers only for ${deps.allowedHosts.join(', ')}.`);
        }
        const path = url.pathname === `${ENDPOINT_PATH}/` ? ENDPOINT_PATH : url.pathname;
        if (path === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
            return text(
                200,
                `nbg-rates-mcp ${deps.version}. MCP endpoint: POST ${ENDPOINT_PATH} (Streamable HTTP). Source: ${SOURCE_URL}`,
            );
        }
        if (path !== ENDPOINT_PATH) {
            return text(404, `Not found. The MCP endpoint is ${ENDPOINT_PATH}.`);
        }

        const started = performance.now();
        const time = new Date().toISOString();
        // A body stream reads once, so the bytes are read here and the SDK gets a fresh Request built from them
        // (also the one place the /mcp/ spelling is normalised for it).
        const requestBytes = new Uint8Array(await request.arrayBuffer());
        const summary = summarize(new TextDecoder().decode(requestBytes));
        const forwarded = new Request(new URL(ENDPOINT_PATH + url.search, url).href, {
            method: request.method,
            headers: request.headers,
            ...(requestBytes.byteLength === 0 ? {} : { body: requestBytes }),
        });
        let response: Response;
        let body: string;
        try {
            response = await mcpFetch(forwarded);
            body = await response.text();
        } catch (error: unknown) {
            reportFailure(error);
            response = text(500, 'Internal error');
            body = 'Internal error';
        }
        const outcome =
            response.status >= 400 || carriesJsonRpcError(response.headers.get('content-type'), body) ? 'error' : 'ok';
        const line: RequestLogLine = {
            time,
            ...summary,
            status: response.status,
            outcome,
            durationMs: Math.round(performance.now() - started),
        };
        try {
            deps.log(line);
        } catch (error: unknown) {
            reportFailure(error);
        }
        const headers = new Headers(response.headers);
        // The stateless SDK answers every method but POST with 405 and leaves out the Allow header a 405 must carry.
        if (response.status === 405 && !headers.has('allow')) {
            headers.set('allow', 'POST');
        }
        return new Response(body === '' ? null : body, { status: response.status, headers });
    };
}
