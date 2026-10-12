# Hosted Endpoint (0.5.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the same MCP server over Streamable HTTP, locally with `nbg-rates-mcp --http` and on AWS Lambda behind API Gateway at `https://nbg-rates.env.ge/mcp`, deployed by the release workflow with an alias-based rollback, and release it as 0.5.0.

**Architecture:** A host-neutral HTTP shell (`src/shell/http.ts`) wraps the SDK's `createMcpHandler` in stateless mode behind Host validation, path routing and one JSON log line per request that never contains arguments. One small adapter (`src/shell/http-adapter.ts`) turns a transport's request shape into a web `Request` and back; `src/shell/http-node.ts` uses it for `node:http`, `src/lambda.ts` for API Gateway v2 events. The release workflow gains a `deploy` job that uploads the tag's build, publishes a Lambda version, moves the alias `live`, smoke tests the public URL and rolls back on failure. The infrastructure is built by the plan `2026-10-12-nbg-rates-mcp-endpoint.md` in the maintainer's `personal/iac` repository.

**Tech Stack:** TypeScript 5, Node 22 and 24, `@modelcontextprotocol/server` 2.3 (`createMcpHandler`, `CLIENT_INFO_META_KEY`), `@modelcontextprotocol/client` (`StreamableHTTPClientTransport`), Zod 4, Vitest, bash, GitHub Actions, AWS CLI v2.

**Spec:** `docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md`

## Global Constraints

- ESM with `.js` import extensions, strict TypeScript, 4-space indentation, 120 columns, single quotes, no `any`, no non-null `!`, `function` keyword for named functions, `readonly` by default. `src/core` imports no Node built-ins; the new files live in `src/shell` and `src/` and may.
- No new runtime dependency and no new dev dependency: the adapter is written here, the Lambda event is typed by a local interface.
- URL `https://nbg-rates.env.ge/mcp`; the public host is `nbg-rates.env.ge`; the endpoint path is `/mcp`, with `/mcp/` served as `/mcp`.
- Environment variable `NBG_RATES_HTTP_HOSTS`: comma separated, trimmed, empty entries dropped, unset or empty disables the Host check.
- The log line type is `RequestLogLine` with exactly the fields `time`, `method`, `tool`, `client`, `protocolVersion`, `status`, `outcome`, `durationMs`; nothing from a request's `params` other than `name`, `clientInfo`, `protocolVersion` and the client info under `_meta` is ever read.
- `console.error` in the HTTP shell writes only an exception's constructor name and the fixed text `http handler failed`, never a message.
- Every unit test `POST` to `/mcp` sends `Accept: application/json, text/event-stream`; the SDK answers 406 otherwise.
- The deploy job runs only when the repository variable `AWS_ROLE_ARN` is set, assumes the role with `aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0` in `us-east-1`, and pins every other action to the SHAs already in `release.yml`.
- Release 0.5.0: `package.json`, `package-lock.json`, `manifest.json`, `server.json` (its `packages[0]` too), `CHANGELOG.md` heading `## 0.5.0 - <date of the release commit>`.
- No em or en dashes anywhere (code, comments, README, CHANGELOG, commit messages); prose in the repository is agent-neutral.
- Gates before every commit: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`. Final: `bash scripts/build-bundle.sh && npx tsx scripts/check-release.ts 0.5.0` (with Node 24's npm on PATH if the check complains about npm's version).
- Commits on `main`, path-limited (`git add <paths> && git commit -m "<title>" -- <paths>`), signed as configured, titles under 72 characters, no attribution trailers. Never push, never tag.

## Review Focus

- A client that sends `Accept: application/json` alone gets 406 from the SDK; the handler must pass it through unchanged and log it as `error` (Task 2 test "answers 406 to a POST without the SSE Accept").
- A pasted URL with a trailing slash (`/mcp/`) or a query string (`/mcp?x=1`) must still reach the MCP handler (Task 2 test "serves /mcp/ and /mcp with a query as /mcp").
- A `Host` header carrying a port (`nbg-rates.env.ge:443`) must pass the Host check (Task 2 test "accepts the allowed host with a port").
- API Gateway may deliver the body base64 encoded (Task 4 test "decodes a base64 body").
- The deploy step must refuse to run when the alias points at `$LATEST`, since a rollback to `$LATEST` would serve the broken upload (Task 5 test "refuses an alias on $LATEST before uploading").

---

### Task 1: The request and response adapter

**Files:**

- Create: `src/shell/http-adapter.ts`
- Test: `src/shell/http-adapter.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `interface IncomingRequest { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array | null }`
  - `interface OutgoingResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }`
  - `function toWebRequest(incoming: IncomingRequest): Request`
  - `async function fromWebResponse(response: Response): Promise<OutgoingResponse>`

- [ ] **Step 1: Write the failing tests**

`src/shell/http-adapter.test.ts`:

```ts
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
        const request = toWebRequest({ method: 'GET', url: 'https://nbg-rates.env.ge/', headers: {}, body: null });
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project unit src/shell/http-adapter.test.ts`
Expected: FAIL, `Cannot find module './http-adapter.js'`.

- [ ] **Step 3: Write the adapter**

`src/shell/http-adapter.ts`:

```ts
/**
 * Turns a transport's request shape into a web standard Request and a Response back. Shared by the node:http server
 * (http-node.ts) and the Lambda entry (lambda.ts), so the HTTP shell only ever sees web Requests. Bodies are buffered:
 * every response this server produces is a single JSON body or a short SSE stream that ends with the result.
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

export function toWebRequest(incoming: IncomingRequest): Request {
    const method = incoming.method.toUpperCase();
    const init: RequestInit = { method, headers: incoming.headers };
    if (incoming.body !== null && !BODYLESS_METHODS.has(method)) {
        // A fresh copy: the Request constructor keeps the view, and a transport may reuse its buffer.
        init.body = new Uint8Array(incoming.body);
    }
    return new Request(incoming.url, init);
}

export async function fromWebResponse(response: Response): Promise<OutgoingResponse> {
    const headers: Record<string, string> = {};
    // Headers iteration already joins repeated values with ", "; set-cookie is the one exception and this server sets none.
    for (const [name, value] of response.headers) {
        headers[name] = value;
    }
    return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
}
```

- [ ] **Step 4: Run the tests and the gates**

Run: `npx vitest run --project unit src/shell/http-adapter.test.ts`
Expected: 4 passed.

Run: `npm run format:check && npm run lint && npm run typecheck && npm test`
Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/shell/http-adapter.ts src/shell/http-adapter.test.ts && git commit -m "Add the web Request adapter for the HTTP shell" -- src/shell/http-adapter.ts src/shell/http-adapter.test.ts
```

---

### Task 2: The HTTP shell

**Files:**

- Create: `src/shell/http.ts`
- Test: `src/shell/http.test.ts`

**Interfaces:**

- Consumes: `createServer(deps: ServerDeps): McpServer` and `ServerDeps { service, now, version }` from `src/shell/server.ts`; `RatesService` from `src/shell/rates-service.ts`; `createMcpHandler` and `CLIENT_INFO_META_KEY` from `@modelcontextprotocol/server`.
- Produces:
  - `interface HttpDeps { readonly service: RatesService; readonly now: () => Date; readonly version: string; readonly allowedHosts: readonly string[]; readonly log: (line: RequestLogLine) => void }`
  - `interface RequestLogLine { readonly time: string; readonly method: string | null; readonly tool: string | null; readonly client: { readonly name: string; readonly version: string } | null; readonly protocolVersion: string | null; readonly status: number; readonly outcome: 'ok' | 'error'; readonly durationMs: number }`
  - `function createHttpHandler(deps: HttpDeps, mcpFetch?: (request: Request) => Promise<Response>): (request: Request) => Promise<Response>`
  - `function parseAllowedHosts(value: string | undefined): readonly string[]`

- [ ] **Step 1: Write the failing tests**

`src/shell/http.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { code, date } from '../../test/helpers/values.js';
import { err, ok, type RatesSnapshot } from '../core/types.js';
import { createHttpHandler, parseAllowedHosts, type HttpDeps, type RequestLogLine } from './http.js';
import type { RatesService } from './rates-service.js';

const SNAPSHOT: RatesSnapshot = {
    requestedDate: date('2026-10-07'),
    effectiveDate: date('2026-10-07'),
    carriedOver: false,
    rates: [{ code: code('USD'), name: 'US Dollar', rate: 2.6025, diff: -0.0007, nbgQuantity: 1, nbgRate: 2.6025 }],
    unknownCodes: [],
};

const service: RatesService = {
    getSnapshot: () => Promise.resolve(ok(SNAPSHOT)),
    getHistory: () => Promise.resolve(err({ kind: 'upstream_unavailable', detail: 'stub' })),
};

const ACCEPT = 'application/json, text/event-stream';
const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.2.3' },
    },
};
const CONVERT = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'nbg_convert', arguments: { amount: 123456.78, from: 'USD', to: 'GEL', date: '2026-10-07' } },
};

function handlerWith(overrides: Partial<HttpDeps> = {}, mcpFetch?: (request: Request) => Promise<Response>) {
    const lines: RequestLogLine[] = [];
    const handler = createHttpHandler(
        {
            service,
            now: () => new Date('2026-10-08T06:00:00Z'),
            version: '0.0.0-test',
            allowedHosts: ['nbg-rates.env.ge'],
            log: (line) => lines.push(line),
            ...overrides,
        },
        mcpFetch,
    );
    return { handler, lines };
}

function post(body: unknown, options: { host?: string; path?: string; accept?: string | null } = {}): Request {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
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
async function firstMessage(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    const line = text.startsWith('data:') || text.includes('\ndata:') ? text.split('\n').find((l) => l.startsWith('data:')) : text;
    return JSON.parse((line ?? '').replace(/^data:\s*/, '')) as Record<string, unknown>;
}

describe('parseAllowedHosts', () => {
    it('splits on commas, trims, drops empties and lower-cases', () => {
        expect(parseAllowedHosts(' nbg-rates.env.ge, Localhost ,,')).toEqual(['nbg-rates.env.ge', 'localhost']);
        expect(parseAllowedHosts(undefined)).toEqual([]);
        expect(parseAllowedHosts('  ')).toEqual([]);
    });
});

describe('createHttpHandler', () => {
    it('answers GET / with the version and the endpoint path', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(new Request('https://nbg-rates.env.ge/'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
        expect(await response.text()).toBe(
            'nbg-rates-mcp 0.0.0-test. MCP endpoint: POST /mcp (Streamable HTTP). Source: https://github.com/akalongman/nbg-rates-mcp',
        );
        expect(lines).toEqual([]);
    });

    it('refuses a host that is not allowed with 421 and no log line', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(INITIALIZE, { host: 'evil.example' }));
        expect(response.status).toBe(421);
        expect(await response.text()).toBe('This server answers only for nbg-rates.env.ge.');
        expect(lines).toEqual([]);
    });

    it('accepts the allowed host with a port', async () => {
        const { handler } = handlerWith();
        const response = await handler(post(INITIALIZE, { host: 'nbg-rates.env.ge:443' }));
        expect(response.status).toBe(200);
    });

    it('skips the host check when no host is allowed', async () => {
        const { handler } = handlerWith({ allowedHosts: [] });
        const response = await handler(post(INITIALIZE, { host: 'anything.example' }));
        expect(response.status).toBe(200);
    });

    it('answers 404 with a hint for any other path', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(INITIALIZE, { path: '/other' }));
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('Not found. The MCP endpoint is /mcp.');
        expect(lines).toEqual([]);
    });

    it('serves /mcp/ and /mcp with a query as /mcp', async () => {
        const { handler } = handlerWith();
        expect((await handler(post(INITIALIZE, { path: '/mcp/' }))).status).toBe(200);
        expect((await handler(post(INITIALIZE, { path: '/mcp?x=1' }))).status).toBe(200);
    });

    it('initializes and logs the client, the protocol version and the method', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(INITIALIZE));
        expect(response.status).toBe(200);
        const message = await firstMessage(response);
        expect(message).toMatchObject({ id: 1, result: { serverInfo: { name: 'nbg-rates-mcp', version: '0.0.0-test' } } });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
            method: 'initialize',
            tool: null,
            client: { name: 'test-client', version: '1.2.3' },
            protocolVersion: '2025-06-18',
            status: 200,
            outcome: 'ok',
        });
        expect(lines[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(lines[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('logs a tool call with its name and nothing of its arguments', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(CONVERT));
        expect(response.status).toBe(200);
        const message = await firstMessage(response);
        expect(message).toMatchObject({ id: 2, result: { structuredContent: { resultRounded: 321296.27 } } });
        expect(lines[0]).toMatchObject({ method: 'tools/call', tool: 'nbg_convert', client: null, outcome: 'ok' });
        const serialized = JSON.stringify(lines[0]);
        expect(serialized).not.toContain('123456');
        expect(serialized).not.toContain('USD');
        expect(serialized).not.toContain('2026-10-07');
        expect(Object.keys(lines[0] ?? {}).sort()).toEqual(
            ['client', 'durationMs', 'method', 'outcome', 'protocolVersion', 'status', 'time', 'tool'].sort(),
        );
    });

    it('reads the client from _meta when a request carries it there', async () => {
        const { handler, lines } = handlerWith();
        const body = {
            ...CONVERT,
            params: {
                ...CONVERT.params,
                _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'meta-client', version: '9.9.9' } },
            },
        };
        await handler(post(body));
        expect(lines[0]?.client).toEqual({ name: 'meta-client', version: '9.9.9' });
    });

    it('counts a tool that fails inside its result as ok, and a JSON-RPC error as error', async () => {
        const { handler, lines } = handlerWith();
        const failing = { ...CONVERT, params: { name: 'nbg_convert', arguments: { amount: 1, from: 'dollar', to: 'GEL' } } };
        const failed = await handler(post(failing));
        expect(await firstMessage(failed)).toMatchObject({ result: { isError: true } });
        expect(lines[0]?.outcome).toBe('ok');

        const unknown = await handler(post({ jsonrpc: '2.0', id: 3, method: 'no/such' }));
        expect(await firstMessage(unknown)).toHaveProperty('error');
        expect(lines[1]).toMatchObject({ method: 'no/such', tool: null, outcome: 'error' });
    });

    it('answers 406 to a POST without the SSE Accept and logs it as error', async () => {
        const { handler, lines } = handlerWith();
        const response = await handler(post(INITIALIZE, { accept: 'application/json' }));
        expect(response.status).toBe(406);
        expect(lines[0]).toMatchObject({ method: 'initialize', status: 406, outcome: 'error' });
    });

    it('logs null fields for a body that is not JSON', async () => {
        const { handler, lines } = handlerWith();
        const request = new Request('https://nbg-rates.env.ge/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: ACCEPT },
            body: 'not json',
        });
        const response = await handler(request);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(lines[0]).toMatchObject({ method: null, tool: null, client: null, protocolVersion: null, outcome: 'error' });
    });

    it('answers 500 and logs only the error class when the MCP handler fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const { handler, lines } = handlerWith({}, () => Promise.reject(new RangeError('secret amount 123456.78')));
            const response = await handler(post(CONVERT));
            expect(response.status).toBe(500);
            expect(await response.text()).toBe('Internal error');
            expect(lines[0]).toMatchObject({ method: 'tools/call', tool: 'nbg_convert', status: 500, outcome: 'error' });
            expect(consoleError).toHaveBeenCalledWith('RangeError http handler failed');
            expect(JSON.stringify(consoleError.mock.calls)).not.toContain('123456');
        } finally {
            consoleError.mockRestore();
        }
    });

    it('keeps the response when the log callback throws', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const { handler } = handlerWith({
                log: () => {
                    throw new Error('disk full 123456.78');
                },
            });
            const response = await handler(post(INITIALIZE));
            expect(response.status).toBe(200);
            expect(consoleError).toHaveBeenCalledWith('Error http handler failed');
        } finally {
            consoleError.mockRestore();
        }
    });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run --project unit src/shell/http.test.ts`
Expected: FAIL, `Cannot find module './http.js'`.

- [ ] **Step 3: Write the HTTP shell**

`src/shell/http.ts`:

```ts
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

function reportFailure(error: unknown): void {
    const name = error instanceof Error ? error.constructor.name : 'Error';
    // Never the message: it can quote the request body or a user's arguments.
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
        return new Response(body === '' ? null : body, { status: response.status, headers: response.headers });
    };
}
```

- [ ] **Step 4: Run the tests and the gates**

Run: `npx vitest run --project unit src/shell/http.test.ts`
Expected: 15 passed. If `firstMessage` fails to parse because the SDK answered JSON rather than SSE for a request, that is fine: the helper handles both.

Run: `npm run format:check && npm run lint && npm run typecheck && npm test`
Expected: all exit 0. If `lint` flags `performance` as undefined, import it: `import { performance } from 'node:perf_hooks';`.

- [ ] **Step 5: Commit**

```bash
git add src/shell/http.ts src/shell/http.test.ts && git commit -m "Add the HTTP shell: host check, routing and one log line per request" -- src/shell/http.ts src/shell/http.test.ts
```

---

### Task 3: Local HTTP serving and the end-to-end test

**Files:**

- Create: `src/shell/http-node.ts`
- Modify: `src/bin.ts`
- Test: `src/shell/http-node.test.ts`
- Test: `test/e2e/http.test.ts`

**Interfaces:**

- Consumes: `toWebRequest`, `fromWebResponse` (Task 1); `createHttpHandler`, `parseAllowedHosts`, `RequestLogLine` (Task 2); `createNbgClient`, `createRatesService`, `createSnapshotCache` as `bin.ts` already uses them.
- Produces: `function serveHttp(handler: (request: Request) => Promise<Response>, options: { readonly port: number; readonly host: string }): Promise<{ readonly port: number; close(): Promise<void> }>`; the stderr line `nbg-rates-mcp <version> serving HTTP on http://<host>:<port>/mcp (upstream <baseUrl>)`; the flags `--http`, `--port <n>` (default 3000), `--host <address>` (default `127.0.0.1`).

- [ ] **Step 1: Write the failing unit test for the Node server**

`src/shell/http-node.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { serveHttp } from './http-node.js';

describe('serveHttp', () => {
    let close: (() => Promise<void>) | undefined;

    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('hands the handler a web Request built from the socket and writes its Response back', async () => {
        let seen: Request | undefined;
        const server = await serveHttp(
            async (request) => {
                seen = request;
                const body = new Uint8Array(await request.arrayBuffer());
                return new Response(`got ${body.byteLength} bytes`, {
                    status: 202,
                    headers: { 'content-type': 'text/plain', 'x-echo': request.headers.get('x-in') ?? '' },
                });
            },
            { port: 0, host: '127.0.0.1' },
        );
        close = server.close;
        const response = await fetch(`http://127.0.0.1:${server.port}/mcp?x=1`, {
            method: 'POST',
            headers: { 'x-in': 'yes', 'content-type': 'application/octet-stream' },
            body: new Uint8Array([1, 2, 3]),
        });
        expect(response.status).toBe(202);
        expect(response.headers.get('x-echo')).toBe('yes');
        expect(await response.text()).toBe('got 3 bytes');
        expect(seen?.method).toBe('POST');
        expect(seen?.url).toBe(`http://127.0.0.1:${server.port}/mcp?x=1`);
    });

    it('serves a GET with no body', async () => {
        const server = await serveHttp((request) => Promise.resolve(new Response(request.body === null ? 'no body' : 'body')), {
            port: 0,
            host: '127.0.0.1',
        });
        close = server.close;
        expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe('no body');
    });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project unit src/shell/http-node.test.ts`
Expected: FAIL, `Cannot find module './http-node.js'`.

- [ ] **Step 3: Write the Node server**

`src/shell/http-node.ts`:

```ts
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
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run --project unit src/shell/http-node.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Add the flags to bin.ts**

Replace the whole of `src/bin.ts` with:

```ts
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createSnapshotCache } from './shell/cache.js';
import { createHttpHandler, parseAllowedHosts } from './shell/http.js';
import { serveHttp } from './shell/http-node.js';
import { createNbgClient } from './shell/nbg-client.js';
import { createRatesService } from './shell/rates-service.js';
import { createServer } from './shell/server.js';

// JSON-parse boundary: the package's own package.json, shipped beside dist/ and always carrying a version.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
};

const HELP = `nbg-rates-mcp ${version}
MCP server for official National Bank of Georgia exchange rates.

Usage: nbg-rates-mcp [--http [--port <n>] [--host <address>]] [--version] [--help]

  (no flags)        Serve MCP over stdio, for Claude Desktop, Claude Code and other local clients.
  --http            Serve MCP over Streamable HTTP at /mcp instead of stdio.
  --port <n>        Port for --http (default 3000; 0 picks a free one).
  --host <address>  Address for --http (default 127.0.0.1).

Environment:
  NBG_RATES_BASE_URL    Override the NBG host (default https://nbg.gov.ge)
  NBG_RATES_DEBUG=1     Log every upstream request to stderr
  NBG_RATES_HTTP_HOSTS  Host names the HTTP endpoint answers for, comma separated (unset: any)
`;

interface Options {
    readonly http: boolean;
    readonly port: number;
    readonly host: string;
}

function parseOptions(args: ReadonlyArray<string>): Options | string {
    let http = false;
    let port = 3000;
    let host = '127.0.0.1';
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--http') {
            http = true;
        } else if (arg === '--port' || arg === '--host') {
            const value = args[index + 1];
            if (value === undefined) {
                return `${arg} needs a value`;
            }
            if (arg === '--port') {
                port = Number(value);
                if (!Number.isInteger(port) || port < 0 || port > 65535) {
                    return `--port must be a whole number from 0 to 65535, not ${value}`;
                }
            } else {
                host = value;
            }
            index += 1;
        } else {
            return `unknown option ${String(arg)}`;
        }
    }
    return { http, port, host };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('--version') || args.includes('-v')) {
        process.stdout.write(`${version}\n`);
        return;
    }
    if (args.includes('--help') || args.includes('-h')) {
        process.stdout.write(HELP);
        return;
    }
    const options = parseOptions(args);
    if (typeof options === 'string') {
        process.stderr.write(`nbg-rates-mcp: ${options}\n${HELP}`);
        process.exitCode = 2;
        return;
    }

    const baseUrl = (process.env['NBG_RATES_BASE_URL'] ?? 'https://nbg.gov.ge').replace(/\/+$/, '');
    const debug = process.env['NBG_RATES_DEBUG'] === '1';
    const client = createNbgClient({
        baseUrl,
        userAgent: `nbg-rates-mcp/${version} (+https://github.com/akalongman/nbg-rates-mcp)`,
        ...(debug ? { log: (message: string) => console.error(`[nbg-rates-mcp] ${message}`) } : {}),
    });
    const service = createRatesService({ client, cache: createSnapshotCache(), now: () => new Date() });

    if (options.http) {
        const handler = createHttpHandler({
            service,
            now: () => new Date(),
            version,
            allowedHosts: parseAllowedHosts(process.env['NBG_RATES_HTTP_HOSTS']),
            log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
        });
        const running = await serveHttp(handler, { port: options.port, host: options.host });
        // The end-to-end test reads the port from this line; its format is part of the contract.
        console.error(
            `nbg-rates-mcp ${version} serving HTTP on http://${options.host}:${running.port}/mcp (upstream ${baseUrl})`,
        );
        return;
    }

    serveStdio(() => createServer({ service, now: () => new Date(), version }));
    console.error(`nbg-rates-mcp ${version} serving on stdio (upstream ${baseUrl})`);
}

await main();
```

- [ ] **Step 6: Write the failing end-to-end test**

`test/e2e/http.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { SERVER_INSTRUCTIONS } from '../../src/shell/server.js';
import { convertManyOutput, convertOutput, getRatesOutput, rateHistoryOutput } from '../../src/shell/tool-schemas.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'dist', 'bin.js');
const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')));
const READY = /serving HTTP on (http:\/\/[^ ]+\/mcp)/;

interface HttpChild {
    readonly process: ChildProcess;
    readonly url: string;
    readonly stdout: string[];
}

/** Starts dist/bin.js --http on a free port and waits for the ready line on stderr. */
async function startHttpChild(baseUrl: string): Promise<HttpChild> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
            env[key] = value;
        }
    }
    env['NBG_RATES_BASE_URL'] = `${baseUrl}/`;
    env['NBG_RATES_HTTP_HOSTS'] = '127.0.0.1';
    env['TZ'] = 'America/Los_Angeles';
    const child = spawn(process.execPath, [BIN, '--http', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(...chunk.toString('utf8').split('\n').filter((l) => l !== '')));
    const url = await new Promise<string>((resolve, reject) => {
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
            const match = READY.exec(stderr);
            if (match?.[1] !== undefined) {
                resolve(match[1]);
            }
        });
        child.on('exit', (code) => reject(new Error(`server exited with ${String(code)} before it was ready: ${stderr}`)));
    });
    return { process: child, url, stdout };
}

async function connect(url: string): Promise<Client> {
    const client = new Client({ name: 'e2e-http', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
}

describe('nbg-rates-mcp over Streamable HTTP', () => {
    let fixture: FixtureServer;
    let child: HttpChild;
    let client: Client;

    beforeAll(async () => {
        fixture = await startFixtureServer();
        child = await startHttpChild(fixture.baseUrl);
        client = await connect(child.url);
    });

    afterAll(async () => {
        await client.close();
        child.process.kill();
        await fixture.close();
    });

    it('lists the tools and sends the instructions', async () => {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'nbg_convert',
            'nbg_convert_many',
            'nbg_get_rates',
            'nbg_list_currencies',
            'nbg_rate_history',
        ]);
        expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
        expect(client.getServerVersion()).toMatchObject({ name: 'nbg-rates-mcp', version });
    });

    it('answers a Sunday with the carried-over Saturday rate', async () => {
        const result = await client.callTool({ name: 'nbg_get_rates', arguments: { date: '2026-10-04', currencies: ['USD'] } });
        expect(getRatesOutput.parse(result.structuredContent)).toMatchObject({
            requestedDate: '2026-10-04',
            effectiveDate: '2026-10-03',
            carriedOver: true,
        });
    });

    it('converts with an exact rounded result', async () => {
        const result = await client.callTool({
            name: 'nbg_convert',
            arguments: { amount: 10, from: 'USD', to: 'GEL', date: '2026-10-07' },
        });
        const output = convertOutput.parse(result.structuredContent);
        expect(output.rate).toBe(2.6025);
        expect(output.resultRounded).toBe(26.03);
    });

    it('converts a batch with a per-item error and a total', async () => {
        const result = await client.callTool({
            name: 'nbg_convert_many',
            arguments: {
                items: [
                    { amount: 100, from: 'USD', to: 'GEL', date: '2026-10-01' },
                    { amount: 1, from: 'USD', to: 'GEL', date: '2026-13-01' },
                ],
            },
        });
        const output = convertManyOutput.parse(result.structuredContent);
        expect(output).toMatchObject({ converted: 1, skipped: 1, total: { to: 'GEL' } });
        expect(output.items[1]).toHaveProperty('error');
    });

    it('returns a history with its summary', async () => {
        const result = await client.callTool({
            name: 'nbg_rate_history',
            arguments: { currency: 'USD', from: '2026-10-01', to: '2026-10-07' },
        });
        const output = rateHistoryOutput.parse(result.structuredContent);
        expect(output.days).toHaveLength(7);
        expect(output.summary.min).toBeLessThanOrEqual(output.summary.max);
    });

    it('explains a word that is not a currency code', async () => {
        const result = await client.callTool({ name: 'nbg_convert', arguments: { amount: 1, from: 'dollar', to: 'GEL' } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('not a currency code');
    });

    it('serves a second client from the warm cache and logs one line per request', async () => {
        const before = fixture.requests.length;
        const second = await connect(child.url);
        try {
            await second.callTool({ name: 'nbg_get_rates', arguments: { date: '2026-10-07', currencies: ['USD'] } });
        } finally {
            await second.close();
        }
        // 2026-10-07 English was fetched by the conversion above, so the second client costs NBG nothing.
        expect(fixture.requests.length).toBe(before);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const lines = child.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines.filter((line) => line['method'] === 'initialize')).toHaveLength(2);
        expect(lines.some((line) => line['method'] === 'tools/call' && line['tool'] === 'nbg_get_rates')).toBe(true);
        expect(JSON.stringify(lines)).not.toContain('2026-10-07');
    });

    it('answers GET / with the version and refuses a foreign host', async () => {
        const origin = new URL(child.url).origin;
        const root = await fetch(`${origin}/`);
        expect(root.status).toBe(200);
        expect(await root.text()).toContain(`nbg-rates-mcp ${version}`);
        const foreign = await fetch(`${origin}/`, { headers: { host: 'evil.example' } });
        expect(foreign.status).toBe(421);
    });
});
```

- [ ] **Step 7: Run the end-to-end test**

Run: `npm run test:e2e`
Expected: the stdio file and the new file both pass (the stdio file 14, the http file 8). If the foreign host check fails because `fetch` refuses to override `host`, replace that assertion with a raw `node:http` request carrying `Host: evil.example`, using `http.request({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } })`.

- [ ] **Step 8: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: all exit 0.

```bash
git add src/shell/http-node.ts src/shell/http-node.test.ts src/bin.ts test/e2e/http.test.ts
git commit -m "Serve MCP over Streamable HTTP with nbg-rates-mcp --http" -- src/shell/http-node.ts src/shell/http-node.test.ts src/bin.ts test/e2e/http.test.ts
```

---

### Task 4: The Lambda entry

**Files:**

- Create: `src/lambda.ts`
- Create: `test/fixtures/apigw-post-mcp.json`, `test/fixtures/apigw-post-mcp-base64.json`, `test/fixtures/apigw-get-root.json`
- Test: `src/lambda.test.ts`

**Interfaces:**

- Consumes: `toWebRequest`, `fromWebResponse` (Task 1); `createHttpHandler`, `parseAllowedHosts` (Task 2).
- Produces: `interface ApiGatewayV2Event`, `interface ApiGatewayV2Result`, `async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Result>`, built as `dist/lambda.js`, Lambda handler string `dist/lambda.handler`.

- [ ] **Step 1: Write the fixtures**

`test/fixtures/apigw-post-mcp.json` (the shape API Gateway HTTP API sends with payload format 2.0; fields the handler does not read are kept so the fixture is a real event):

```json
{
    "version": "2.0",
    "routeKey": "$default",
    "rawPath": "/mcp",
    "rawQueryString": "",
    "headers": {
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
        "host": "nbg-rates.env.ge",
        "user-agent": "fixture",
        "x-forwarded-for": "203.0.113.5",
        "x-forwarded-proto": "https"
    },
    "requestContext": {
        "domainName": "nbg-rates.env.ge",
        "http": { "method": "POST", "path": "/mcp", "protocol": "HTTP/1.1", "sourceIp": "203.0.113.5", "userAgent": "fixture" },
        "requestId": "fixture-1",
        "stage": "$default"
    },
    "body": "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"fixture-client\",\"version\":\"1.0.0\"}}}",
    "isBase64Encoded": false
}
```

`test/fixtures/apigw-post-mcp-base64.json`: the same object with `"isBase64Encoded": true` and `body` replaced by the base64 of the same JSON string. Produce it with:

```bash
node -e 'const e=require("./test/fixtures/apigw-post-mcp.json");e.body=Buffer.from(e.body).toString("base64");e.isBase64Encoded=true;require("fs").writeFileSync("test/fixtures/apigw-post-mcp-base64.json",JSON.stringify(e,null,4)+"\n")'
```

`test/fixtures/apigw-get-root.json`: the same shape with `"rawPath": "/"`, `requestContext.http.method` `GET`, `requestContext.http.path` `/`, no `body` key, `"isBase64Encoded": false`, and headers `accept: text/plain`, `host: nbg-rates.env.ge`.

- [ ] **Step 2: Write the failing test**

`src/lambda.test.ts`:

```ts
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
    let handler: (event: ApiGatewayV2Event) => Promise<{ statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded: boolean }>;

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
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run --project unit src/lambda.test.ts`
Expected: FAIL, `Cannot find module './lambda.js'`.

- [ ] **Step 4: Write the Lambda entry**

`src/lambda.ts`:

```ts
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
```

- [ ] **Step 5: Run the test, the build and the gates**

Run: `npx vitest run --project unit src/lambda.test.ts`
Expected: 4 passed.

Run: `npm run build && ls dist/lambda.js && node -e 'import("./dist/lambda.js").then((m) => console.log(typeof m.handler))'`
Expected: `dist/lambda.js` listed and `function` printed.

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lambda.ts src/lambda.test.ts test/fixtures/apigw-post-mcp.json test/fixtures/apigw-post-mcp-base64.json test/fixtures/apigw-get-root.json
git commit -m "Add the Lambda entry for API Gateway" -- src/lambda.ts src/lambda.test.ts test/fixtures/apigw-post-mcp.json test/fixtures/apigw-post-mcp-base64.json test/fixtures/apigw-get-root.json
```

---

### Task 5: Build, smoke test, deploy step and the release workflow

**Files:**

- Create: `scripts/build-lambda.sh`
- Create: `scripts/smoke-http.ts`
- Modify: `scripts/publish-release.sh` (usage line, a `publish_lambda` function, the `case`)
- Modify: `.github/workflows/release.yml` (concurrency, the `deploy` job)
- Test: `test/scripts/publish-release.test.ts` (a `lambda` describe block)
- Test: `test/scripts/build-lambda.test.ts`

**Interfaces:**

- Consumes: the `release` artifact (`nbg-rates-mcp-<version>.tgz`), the repository variables `AWS_ROLE_ARN`, `FUNCTION_NAME`, `FUNCTION_ALIAS`, `MCP_URL` (set by the iac plan), the AWS CLI on the runner.
- Produces: `nbg-rates-mcp-<version>-lambda.zip`; `scripts/publish-release.sh lambda <version>` reading `FUNCTION_NAME`, `FUNCTION_ALIAS` and `MCP_URL` from the environment; `scripts/smoke-http.ts <url> <version>` exiting 0 or 1.

- [ ] **Step 1: Write the failing test for the build script**

`test/scripts/build-lambda.test.ts`:

```ts
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'build-lambda.sh');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };

describe('build-lambda.sh', () => {
    let workDir: string | undefined;

    afterEach(() => {
        if (workDir !== undefined) {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    it('zips dist, node_modules and package.json from the tarball with the lock beside it', () => {
        workDir = mkdtempSync(join(tmpdir(), 'build-lambda-'));
        // The tarball the build job packs; npm pack writes it into the working directory.
        execFileSync('npm', ['pack', '--pack-destination', workDir], { cwd: ROOT, stdio: 'ignore' });
        const result = spawnSync('bash', [SCRIPT, version], {
            cwd: workDir,
            encoding: 'utf8',
            env: { ...process.env, PACKAGE_LOCK: join(ROOT, 'package-lock.json') },
        });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const zip = join(workDir, `nbg-rates-mcp-${version}-lambda.zip`);
        expect(existsSync(zip)).toBe(true);
        const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n');
        expect(listing).toContain('dist/lambda.js');
        expect(listing).toContain('dist/bin.js');
        expect(listing).toContain('package.json');
        expect(listing.some((entry) => entry.startsWith('node_modules/@modelcontextprotocol/server/'))).toBe(true);
        expect(listing.some((entry) => entry.startsWith('node_modules/zod/'))).toBe(true);
        expect(listing.some((entry) => entry.startsWith('node_modules/vitest/'))).toBe(false);
        expect(listing.some((entry) => entry.startsWith('package/'))).toBe(false);
    }, 120_000);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run --project unit test/scripts/build-lambda.test.ts`
Expected: FAIL (the script does not exist, status is not 0).

- [ ] **Step 3: Write the build script**

`scripts/build-lambda.sh` (mode 755):

```bash
#!/usr/bin/env bash
# Builds the Lambda zip from the npm tarball the build job packed: the
# package exactly as npm serves it, plus its production dependencies.
# Usage: scripts/build-lambda.sh <version>
# PACKAGE_LOCK may point at the lock file to use; default: the checkout's.
set -euo pipefail

version=${1:?usage: scripts/build-lambda.sh <version>}
package=nbg-rates-mcp
tarball="$package-$version.tgz"
target="$PWD/$package-$version-lambda.zip"
lock=${PACKAGE_LOCK:-"$(cd "$(dirname "$0")/.." && pwd)/package-lock.json"}

[ -f "$tarball" ] || { echo "$tarball is not here; download the release artifact first" >&2; exit 1; }

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lambda-build.XXXXXX")
trap 'rm -rf "$work"' EXIT

tar -xzf "$tarball" -C "$work"
# npm's tarball root is package/. The tarball carries no lock file; the one
# at the tag is what the package was built from.
cp "$lock" "$work/package/package-lock.json"
(
    cd "$work/package"
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund > /dev/null
    rm -f "$target"
    zip -X -r -q "$target" dist node_modules package.json
)
echo "built $(basename "$target")"
```

Run: `chmod 755 scripts/build-lambda.sh && shellcheck scripts/build-lambda.sh && npx vitest run --project unit test/scripts/build-lambda.test.ts`
Expected: no shellcheck output; 1 passed.

- [ ] **Step 4: Write the smoke test script**

`scripts/smoke-http.ts`:

```ts
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';

/**
 * Checks a hosted endpoint after a deploy: GET / names the version, initialize reports it, the five tools are listed
 * and a conversion returns a rounded amount. Usage: tsx scripts/smoke-http.ts <url> <version>. Exit 0 on success, 1
 * with the first failing check on stderr.
 */

const TOOLS = ['nbg_convert', 'nbg_convert_many', 'nbg_get_rates', 'nbg_list_currencies', 'nbg_rate_history'];

function fail(message: string): never {
    console.error(`smoke test failed: ${message}`);
    process.exit(1);
}

const [url, version] = process.argv.slice(2);
if (url === undefined || version === undefined) {
    console.error('usage: tsx scripts/smoke-http.ts <url> <version>');
    process.exit(2);
}

const root = await fetch(new URL('/', url));
const rootText = await root.text();
if (root.status !== 200 || !rootText.includes(`nbg-rates-mcp ${version}`)) {
    fail(`GET / answered ${root.status}: ${rootText.slice(0, 200)}`);
}

const client = new Client({ name: 'smoke-http', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
try {
    const reported = client.getServerVersion()?.version;
    if (reported !== version) {
        fail(`initialize reported version ${String(reported)}, expected ${version}`);
    }
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(TOOLS)) {
        fail(`tools/list returned ${names.join(', ')}`);
    }
    const result = await client.callTool({ name: 'nbg_convert', arguments: { amount: 10, from: 'USD', to: 'GEL' } });
    const output = z.object({ resultRounded: z.number() }).safeParse(result.structuredContent);
    if (result.isError === true || !output.success) {
        fail(`nbg_convert answered ${JSON.stringify(result.content).slice(0, 300)}`);
    }
    const { resultRounded } = output.data;
    if (!Number.isFinite(resultRounded) || Math.round(resultRounded * 100) !== resultRounded * 100) {
        fail(`resultRounded ${String(resultRounded)} is not a two decimal amount`);
    }
    console.log(`smoke test passed: ${url} serves ${version}, 10 USD = ${String(resultRounded)} GEL`);
} finally {
    await client.close();
}
```

Run: `npx tsc --noEmit -p tsconfig.json` (the file is under `scripts/`, covered by the typecheck like `check-release.ts`)
Expected: no errors. Then a manual run against the local server: `node dist/bin.js --http --port 3999 &` then `npx tsx scripts/smoke-http.ts http://127.0.0.1:3999/mcp "$(node -p 'require("./package.json").version')"`, then kill the server.
Expected: `smoke test passed: ... 10 USD = <amount> GEL` (live NBG, needs network; skip if offline and say so in the report).

- [ ] **Step 5: Write the failing tests for the lambda step**

Append to `test/scripts/publish-release.test.ts`, inside the top-level `describe('publish-release.sh', ...)` after the `github` block:

```ts
    describe('lambda', () => {
        // Stands in for the AWS CLI: logs each call, answers the reads from the environment (AWS_ALIAS_VERSION,
        // AWS_LIVE_DESCRIPTION), publishes version 7. And for npx, which runs the smoke test: exits per SMOKE_EXIT.
        const AWS_STUB = `#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
case "$1 $2" in
    "lambda get-alias") printf '%s' "$AWS_ALIAS_VERSION" ;;
    "lambda get-function-configuration") printf '%s' "$AWS_LIVE_DESCRIPTION" ;;
    "lambda publish-version") printf 7 ;;
    "lambda update-function-code") printf 'arn:aws:lambda:us-east-1:1:function:nbg-rates-mcp' ;;
    "lambda update-alias") printf 7 ;;
    *) ;;
esac
`;
        const NPX_STUB = `#!/usr/bin/env bash
echo "npx $*" >> "$STUB_LOG"
exit "$SMOKE_EXIT"
`;
        const ZIP = join(ROOT, 'nbg-rates-mcp-0.2.0-lambda.zip');

        function runLambda(options: { aliasVersion: string; liveDescription: string; smokeExit: number }) {
            writeFileSync(join(stubDir, 'aws'), AWS_STUB);
            chmodSync(join(stubDir, 'aws'), 0o755);
            writeFileSync(join(stubDir, 'npx'), NPX_STUB);
            chmodSync(join(stubDir, 'npx'), 0o755);
            writeFileSync(ZIP, 'zip bytes');
            const log = join(stubDir, 'calls.log');
            writeFileSync(log, '');
            const env = {
                ...process.env,
                PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
                STUB_LOG: log,
                AWS_ALIAS_VERSION: options.aliasVersion,
                AWS_LIVE_DESCRIPTION: options.liveDescription,
                SMOKE_EXIT: String(options.smokeExit),
                FUNCTION_NAME: 'nbg-rates-mcp',
                FUNCTION_ALIAS: 'live',
                MCP_URL: 'https://nbg-rates.env.ge/mcp',
            };
            const result = spawnSync('bash', [SCRIPT, 'lambda', '0.2.0'], { cwd: ROOT, encoding: 'utf8', env });
            return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: readFileSync(log, 'utf8').trim().split('\n') };
        }

        afterEach(() => {
            rmSync(ZIP, { force: true });
        });

        const READ_ALIAS = 'aws lambda get-alias --function-name nbg-rates-mcp --name live --query FunctionVersion --output text';
        const READ_DESCRIPTION =
            'aws lambda get-function-configuration --function-name nbg-rates-mcp --qualifier 3 --query Description --output text';
        const UPLOAD = [
            'aws lambda update-function-code --function-name nbg-rates-mcp --zip-file fileb://nbg-rates-mcp-0.2.0-lambda.zip --query FunctionArn --output text',
            'aws lambda wait function-updated-v2 --function-name nbg-rates-mcp',
            'aws lambda publish-version --function-name nbg-rates-mcp --description v0.2.0 --query Version --output text',
            'aws lambda update-alias --function-name nbg-rates-mcp --name live --function-version 7 --query FunctionVersion --output text',
            'npx tsx scripts/smoke-http.ts https://nbg-rates.env.ge/mcp 0.2.0',
        ];

        it('uploads, publishes, moves the alias and smoke tests', () => {
            const { status, calls } = runLambda({ aliasVersion: '3', liveDescription: 'v0.1.9', smokeExit: 0 });
            expect(status).toBe(0);
            expect(calls).toEqual([READ_ALIAS, READ_DESCRIPTION, ...UPLOAD]);
        });

        it('rolls the alias back and fails when the smoke test fails', () => {
            const { status, stdout, calls } = runLambda({ aliasVersion: '3', liveDescription: 'v0.1.9', smokeExit: 1 });
            expect(status).toBe(1);
            expect(calls).toEqual([
                READ_ALIAS,
                READ_DESCRIPTION,
                ...UPLOAD,
                'aws lambda update-alias --function-name nbg-rates-mcp --name live --function-version 3',
            ]);
            expect(stdout).toContain('rolled back live to version 3');
        });

        it('leaves a function that already serves the version alone', () => {
            const { status, stdout, calls } = runLambda({ aliasVersion: '3', liveDescription: 'v0.2.0', smokeExit: 0 });
            expect(status).toBe(0);
            expect(calls).toEqual([READ_ALIAS, READ_DESCRIPTION]);
            expect(stdout).toContain('nbg-rates-mcp live is already v0.2.0');
        });

        it('refuses an alias on $LATEST before uploading', () => {
            const { status, stderr, calls } = runLambda({ aliasVersion: '$LATEST', liveDescription: '', smokeExit: 0 });
            expect(status).toBe(1);
            expect(stderr).toContain('live points at $LATEST; publish a version first');
            expect(calls).toEqual([READ_ALIAS]);
        });
    });
```

The `ROOT` constant already exists in that file. Run: `npx vitest run --project unit test/scripts/publish-release.test.ts`
Expected: the four new tests FAIL (the script prints its usage and exits 2 for the unknown step).

- [ ] **Step 6: Add the lambda step to the release script**

In `scripts/publish-release.sh`:

Change the usage line to `usage='usage: scripts/publish-release.sh <npm|github|registry|lambda> <version>'` and the comment above `Usage:` to mention `lambda`.

Add before the `case "$step" in` block:

```bash
# Ships the tag's build to the hosted endpoint: upload, publish an immutable
# version described with the tag, move the alias, smoke test the public URL,
# and move the alias back if the smoke test fails. FUNCTION_NAME,
# FUNCTION_ALIAS and MCP_URL come from the repository variables that the
# infrastructure's Terraform output sets. Every read uses --query and
# --output text so a variable never holds JSON.
publish_lambda() {
    local zip="$package-$version-lambda.zip" previous current new
    : "${FUNCTION_NAME:?FUNCTION_NAME is not set}" "${FUNCTION_ALIAS:?FUNCTION_ALIAS is not set}" "${MCP_URL:?MCP_URL is not set}"
    previous=$(aws lambda get-alias --function-name "$FUNCTION_NAME" --name "$FUNCTION_ALIAS" \
        --query FunctionVersion --output text)
    if [ "$previous" = '$LATEST' ]; then
        echo "$FUNCTION_ALIAS points at \$LATEST; publish a version first, a rollback target must be immutable" >&2
        exit 1
    fi
    current=$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --qualifier "$previous" \
        --query Description --output text)
    if [ "$current" = "v$version" ]; then
        echo "$FUNCTION_NAME $FUNCTION_ALIAS is already v$version"
        return
    fi
    [ -f "$zip" ] || { echo "$zip is not here; run scripts/build-lambda.sh $version first" >&2; exit 1; }
    aws lambda update-function-code --function-name "$FUNCTION_NAME" --zip-file "fileb://$zip" \
        --query FunctionArn --output text
    aws lambda wait function-updated-v2 --function-name "$FUNCTION_NAME"
    new=$(aws lambda publish-version --function-name "$FUNCTION_NAME" --description "v$version" \
        --query Version --output text)
    aws lambda update-alias --function-name "$FUNCTION_NAME" --name "$FUNCTION_ALIAS" --function-version "$new" \
        --query FunctionVersion --output text
    if ! npx tsx scripts/smoke-http.ts "$MCP_URL" "$version"; then
        aws lambda update-alias --function-name "$FUNCTION_NAME" --name "$FUNCTION_ALIAS" --function-version "$previous"
        echo "rolled back $FUNCTION_ALIAS to version $previous"
        exit 1
    fi
    echo "$FUNCTION_ALIAS is version $new (v$version)"
}
```

and the case arm `lambda) publish_lambda ;;` after `registry) publish_registry ;;`.

Run: `shellcheck scripts/publish-release.sh && npx vitest run --project unit test/scripts/publish-release.test.ts`
Expected: no shellcheck output; every test in the file passes, the four new ones included. Note the test's expected rollback call has no `--query`; keep the script and the test consistent (the rollback line above has none).

- [ ] **Step 7: Extend the release workflow**

In `.github/workflows/release.yml`, after the `on:` block and before `permissions: {}`, add:

```yaml
# A tag push once started two runs in the same second (2026-10-12); the loser failed with a 409 from npm. A queued
# duplicate finds every step already done, because the publish script is idempotent.
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
```

Append the job:

```yaml
  # Ships the build to the hosted endpoint. Skipped where the infrastructure's variables are absent (a fork).
  deploy:
    needs: publish
    if: vars.AWS_ROLE_ARN != ''
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          package-manager-cache: false
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: release
      - name: Build the Lambda zip from the published tarball
        run: ./scripts/build-lambda.sh "${GITHUB_REF_NAME#v}"
      - name: Install the smoke test's client
        run: npm ci --ignore-scripts
      - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: us-east-1
      - name: Upload, publish, move the alias and smoke test
        env:
          FUNCTION_NAME: ${{ vars.FUNCTION_NAME }}
          FUNCTION_ALIAS: ${{ vars.FUNCTION_ALIAS }}
          MCP_URL: ${{ vars.MCP_URL }}
        run: ./scripts/publish-release.sh lambda "${GITHUB_REF_NAME#v}"
```

Run: `npx prettier --check .github/workflows/release.yml` and, if `actionlint` is installed, `actionlint .github/workflows/release.yml`.
Expected: clean.

- [ ] **Step 8: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: all exit 0.

```bash
git add scripts/build-lambda.sh scripts/smoke-http.ts scripts/publish-release.sh .github/workflows/release.yml test/scripts/publish-release.test.ts test/scripts/build-lambda.test.ts
git commit -m "Deploy each release to the hosted endpoint with an alias rollback" -- scripts/build-lambda.sh scripts/smoke-http.ts scripts/publish-release.sh .github/workflows/release.yml test/scripts/publish-release.test.ts test/scripts/build-lambda.test.ts
```

---

### Task 6: Documents and the 0.5.0 release

**Files:**

- Modify: `README.md` (Install: new first subsection; Node.js: a "Self-hosting" paragraph; Environment variables: one row)
- Modify: `CHANGELOG.md`
- Modify: `package.json`, `package-lock.json`, `manifest.json`, `server.json` (version 0.5.0)

**Interfaces:**

- Consumes: the flags and variable of Task 3, the handler string of Task 4, the URL `https://nbg-rates.env.ge/mcp`.
- Produces: the release commit for `v0.5.0` (tagging is the maintainer's).

- [ ] **Step 1: README**

Under `## Install`, before `### Claude Desktop (macOS, Windows)`, insert (the inner fence is part of the README text):

````markdown
### claude.ai, Claude mobile and ChatGPT (nothing to install)

Paste this URL as a custom connector:

```text
https://nbg-rates.env.ge/mcp
```

On claude.ai open Settings, then Connectors, then "Add custom connector", paste the URL and save; the connector then also appears in the Claude mobile apps and in Claude Desktop under the same account. In ChatGPT, custom connectors need developer mode and may require a paid plan.

This hosted copy is the latest release of this server, run by the maintainer on AWS. It needs no account, keeps no data about you, and its only record is a 30 day log of which tool was called from which client, never the amounts, dates or currencies asked.
````

Under `### Node.js`, after the line "The rest of this document is for developers and for people writing instructions for a model.", insert:

```markdown
### Self-hosting

The same server speaks Streamable HTTP: `nbg-rates-mcp --http --port 3000` serves `http://127.0.0.1:3000/mcp` (add `--host 0.0.0.0` to listen on every interface). On AWS Lambda behind an API Gateway HTTP API, the handler is `dist/lambda.handler` of the npm package with its production dependencies zipped beside it. Set `NBG_RATES_HTTP_HOSTS` to the public host name in either case, so the endpoint answers only for it.
```

In the environment variables table, add the row:

```markdown
| `NBG_RATES_HTTP_HOSTS` | Host names the HTTP endpoint (`--http`, Lambda) answers for, comma separated. Unset: any host. |
```

Run: `npx prettier --write README.md` (the table columns realign).

- [ ] **Step 2: CHANGELOG and versions**

At the top of `CHANGELOG.md`, after the intro paragraph and before `## 0.4.0 - 2026-10-12`, add (with the date of the day the release commit is made):

```markdown
## 0.5.0 - YYYY-MM-DD

Added: a hosted endpoint at `https://nbg-rates.env.ge/mcp` for claude.ai, Claude mobile and ChatGPT, with nothing to install; `nbg-rates-mcp --http` (`--port`, `--host`) to serve the same Streamable HTTP endpoint locally; a Lambda entry `dist/lambda.handler` for API Gateway; the `NBG_RATES_HTTP_HOSTS` variable. The release workflow deploys each release to the hosted endpoint and rolls back when its smoke test fails.
```

Run:

```bash
npm version 0.5.0 --no-git-tag-version
sed -i 's/"version": "0.4.0"/"version": "0.5.0"/' manifest.json server.json
grep -rn '0\.4\.0' package.json manifest.json server.json
```

Expected: `npm version` prints `v0.5.0`; the grep prints nothing (every version field, `server.json`'s package entry included, now says 0.5.0; `check-release.ts` in the next step is the authority).

- [ ] **Step 3: Gates and release checks**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: all exit 0.

Run: `bash scripts/build-bundle.sh && npx tsx scripts/check-release.ts 0.5.0`
Expected: the bundle builds and the check prints nothing, exit 0 (if it complains only about npm's version, rerun with `PATH=/home/longman/.nvm/versions/node/v24.21.0/bin:$PATH`).

Run: `grep -nP '[\x{2013}\x{2014}]' README.md CHANGELOG.md src/shell/http.ts src/shell/http-node.ts src/shell/http-adapter.ts src/lambda.ts src/bin.ts scripts/build-lambda.sh scripts/smoke-http.ts scripts/publish-release.sh .github/workflows/release.yml`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md package.json package-lock.json manifest.json server.json
git commit -m "Release 0.5.0" -- README.md CHANGELOG.md package.json package-lock.json manifest.json server.json
```

Tagging `v0.5.0` and pushing are the maintainer's, after the iac plan has applied and set the repository variables.
