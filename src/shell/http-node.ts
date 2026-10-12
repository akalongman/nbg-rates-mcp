import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buffer } from 'node:stream/consumers';
import { fromWebResponse, toWebRequest } from './http-adapter.js';

export interface ServeOptions {
    /** 0 picks a free port. */
    readonly port: number;
    readonly host: string;
}

export interface RunningServer {
    readonly port: number;
    close(): Promise<void>;
}

/** Serves a web-standard handler on node:http. The only file in src/shell that imports node:http. */
export async function serveHttp(
    handler: (request: Request) => Promise<Response>,
    options: ServeOptions,
): Promise<RunningServer> {
    let port = options.port;

    async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined) {
                headers[name] = Array.isArray(value) ? value.join(', ') : value;
            }
        }
        const body = await buffer(request);
        const host = headers['host'] ?? `${options.host}:${port}`;
        const outgoing = await fromWebResponse(
            await handler(
                toWebRequest({
                    method: request.method ?? 'GET',
                    url: `http://${host}${request.url ?? '/'}`,
                    headers,
                    body: body.byteLength === 0 ? null : new Uint8Array(body),
                }),
            ),
        );
        response.writeHead(outgoing.status, outgoing.headers);
        response.end(Buffer.from(outgoing.body));
    }

    const server: Server = createServer((request, response) => {
        respond(request, response).catch(() => {
            if (!response.headersSent) {
                response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            }
            response.end('Internal error');
        });
    });
    await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error(`HTTP server is not listening on a TCP port: ${String(address)}`);
    }
    port = address.port;
    return {
        port,
        close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
}
