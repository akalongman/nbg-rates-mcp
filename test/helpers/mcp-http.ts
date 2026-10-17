/** The Accept header a Streamable HTTP client sends with a POST. */
export const ACCEPT = 'application/json, text/event-stream';

/** A JSON-RPC tools/call request for the named tool. */
export function toolCall(
    name: string,
    args: Record<string, unknown>,
): { jsonrpc: string; id: number; method: string; params: { name: string; arguments: Record<string, unknown> } } {
    return { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name, arguments: args } };
}

/** A POST of the body as JSON to https://nbg-rates.env.ge/mcp, or to the host and path given; accept null sends none. */
export function post(
    body: unknown,
    options: { host?: string; path?: string; accept?: string | null; headers?: Record<string, string> } = {},
): Request {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
    if (options.accept !== null) {
        headers['accept'] = options.accept ?? ACCEPT;
    }
    return new Request(`https://${options.host ?? 'nbg-rates.env.ge'}${options.path ?? '/mcp'}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

/** The first JSON-RPC message of a JSON or SSE response body. */
export async function firstMessage(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    const line =
        text.startsWith('data:') || text.includes('\ndata:')
            ? text.split('\n').find((l) => l.startsWith('data:'))
            : text;
    return JSON.parse((line ?? '').replace(/^data:\s*/, '')) as Record<string, unknown>;
}
