/**
 * Turns a transport's request shape into a web standard Request and a Response back. Shared by the node:http server
 * (http-node.ts) and the Lambda entry (lambda.ts), so the HTTP shell only ever sees web Requests. Bodies are buffered:
 * every response this server produces is a single JSON body, a short SSE stream, a page or a small image.
 */

export interface IncomingRequest {
    readonly method: string;
    /** Absolute, built by the transport from its Host header and the path plus query. */
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array | null;
}

export interface OutgoingResponse {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
}

const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

// The Fetch standard's forbidden methods: the Request constructor throws on them, whatever their case.
const FORBIDDEN_METHODS: ReadonlySet<string> = new Set(['CONNECT', 'TRACE', 'TRACK']);

// A 405 must list the allowed methods; this one answers before routing, so it lists every method any path serves.
const SERVED_METHODS = 'GET, HEAD, POST';

/**
 * One transport request through a web handler and back. A forbidden method cannot become a Request, so it is answered
 * 405 here and never reaches the handler.
 */
export async function handleIncoming(
    handler: (request: Request) => Promise<Response>,
    incoming: IncomingRequest,
): Promise<OutgoingResponse> {
    if (FORBIDDEN_METHODS.has(incoming.method.toUpperCase())) {
        return fromWebResponse(
            new Response('Method not allowed.', {
                status: 405,
                headers: { allow: SERVED_METHODS, 'content-type': 'text/plain; charset=utf-8' },
            }),
        );
    }
    return fromWebResponse(await handler(toWebRequest(incoming)));
}

export function toWebRequest(incoming: IncomingRequest): Request {
    const method = incoming.method.toUpperCase();
    const init: RequestInit = { method, headers: incoming.headers };
    if (incoming.body !== null && !BODYLESS_METHODS.has(method)) {
        // A fresh copy, so the Request never shares a buffer the transport may reuse.
        init.body = new Uint8Array(incoming.body);
    }
    return new Request(incoming.url, init);
}

export async function fromWebResponse(response: Response): Promise<OutgoingResponse> {
    const headers: Record<string, string> = {};
    // Headers iteration already joins repeated values with ", "; set-cookie is the one exception
    // and this server sets none.
    for (const [name, value] of response.headers) {
        headers[name] = value;
    }
    return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
}
