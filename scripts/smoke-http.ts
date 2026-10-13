/**
 * Checks a hosted endpoint after a deploy: GET / names the version, GET /favicon.ico answers 200 as image/x-icon,
 * initialize reports the version, the five tools are listed and a conversion returns a two decimal amount. The deploy
 * step that runs it holds the AWS session, so it loads no installed package: it speaks MCP's JSON-RPC over fetch and
 * reads the answer as JSON or as an SSE stream, and it uses only erasable TypeScript syntax, which Node runs as is.
 * Usage: node scripts/smoke-http.ts <url> <version>. Exit 0 on success, 1 with the first failing check on stderr, 2 on
 * a usage error.
 *
 * The conversion is the one check that reaches NBG, whose edge fails now and then, so it is tried up to three times,
 * five seconds apart, when its request fails, the endpoint answers 5xx or the tool answers an error; each retry prints
 * one line naming the attempt and the reason. A wrong amount and every other check fail at once.
 */

const TOOLS = ['nbg_convert', 'nbg_convert_many', 'nbg_get_rates', 'nbg_list_currencies', 'nbg_rate_history'];
// The latest protocol version of the SDK in package-lock.json; the server answers with the one it speaks.
const PROTOCOL_VERSION = '2025-11-25';
// A two decimal amount times 100 lies within float error of an integer (20.01 * 100 is 2001.0000000000002); a third
// decimal puts it at least 0.1 away.
const CENTS_TOLERANCE = 1e-6;
const CONVERT_ATTEMPTS = 3;
const CONVERT_RETRY_SECONDS = 5;

type JsonObject = Readonly<Record<string, unknown>>;

interface Session {
    readonly endpoint: URL;
    readonly headers: Readonly<Record<string, string>>;
}

interface Answer {
    readonly result: JsonObject;
    readonly response: Response;
}

type TransientReason = 'request error' | 'tool error' | `HTTP ${number}`;

/** One conversion attempt: its result, or a failure a retry may clear, with its reason and its line for the run. */
type ConvertAttempt =
    | { readonly kind: 'result'; readonly result: JsonObject }
    | { readonly kind: 'transient'; readonly reason: TransientReason; readonly failure: string };

function fail(message: string): never {
    console.error(`smoke test failed: ${message}`);
    process.exit(1);
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(): { readonly endpoint: URL; readonly version: string } {
    const [url, version] = process.argv.slice(2);
    if (url === undefined || version === undefined) {
        console.error('usage: node scripts/smoke-http.ts <url> <version>');
        process.exit(2);
    }
    return { endpoint: new URL(url), version };
}

/** The JSON-RPC messages in a POST answer: the body itself, or the data of each SSE event; undefined if not JSON. */
function messagesIn(contentType: string, body: string): ReadonlyArray<unknown> | undefined {
    try {
        if (!contentType.includes('text/event-stream')) {
            const message: unknown = JSON.parse(body);
            return [message];
        }
        return body
            .split(/\r?\n\r?\n/)
            .map((event) =>
                event
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice('data:'.length).replace(/^ /, ''))
                    .join('\n'),
            )
            .filter((data) => data !== '')
            .map((data): unknown => JSON.parse(data));
    } catch {
        return undefined;
    }
}

/** POSTs one JSON-RPC message with the headers the Streamable HTTP transport requires. */
async function post(session: Session, message: JsonObject): Promise<Response> {
    return fetch(session.endpoint, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...session.headers,
        },
        body: JSON.stringify(message),
    });
}

/** Returns the result of the answer carrying the id; a status other than 200 or no such result fails the run. */
function answerOf(method: string, id: number, response: Response, body: string): Answer {
    if (response.status !== 200) {
        fail(`${method} answered ${response.status}: ${body.slice(0, 200)}`);
    }
    const answer = messagesIn(response.headers.get('content-type') ?? '', body)?.find(
        (message) => isObject(message) && message['id'] === id,
    );
    const result = isObject(answer) ? answer['result'] : undefined;
    if (!isObject(result)) {
        fail(`${method} answered ${body.slice(0, 300)}`);
    }
    return { result, response };
}

/** Sends a request and returns the result of the answer carrying its id; any other outcome fails the run. */
async function call(session: Session, id: number, method: string, params: JsonObject): Promise<Answer> {
    const response = await post(session, { jsonrpc: '2.0', id, method, params });
    return answerOf(method, id, response, await response.text());
}

/** Converts 10 USD to GEL once. A request that throws, a 5xx status and a tool error come back as transient. */
async function convert(session: Session, id: number): Promise<ConvertAttempt> {
    const method = 'tools/call';
    let response: Response;
    let body: string;
    try {
        response = await post(session, {
            jsonrpc: '2.0',
            id,
            method,
            params: { name: 'nbg_convert', arguments: { amount: 10, from: 'USD', to: 'GEL' } },
        });
        body = await response.text();
    } catch (error: unknown) {
        return { kind: 'transient', reason: 'request error', failure: `${method} request failed: ${String(error)}` };
    }
    if (response.status >= 500) {
        return {
            kind: 'transient',
            reason: `HTTP ${response.status}`,
            failure: `${method} answered ${response.status}: ${body.slice(0, 200)}`,
        };
    }
    const { result } = answerOf(method, id, response, body);
    // An NBG upstream failure reaches the client as a tool error.
    if (result['isError'] === true) {
        return {
            kind: 'transient',
            reason: 'tool error',
            failure: `nbg_convert answered ${JSON.stringify(result).slice(0, 300)}`,
        };
    }
    return { kind: 'result', result };
}

/** Converts with up to CONVERT_ATTEMPTS attempts; the last transient failure fails the run. */
async function convertWithRetries(session: Session, firstId: number): Promise<JsonObject> {
    let attempt = 1;
    let outcome = await convert(session, firstId);
    while (outcome.kind === 'transient' && attempt < CONVERT_ATTEMPTS) {
        // The reason class only, never a response body; the failure line after the last attempt quotes the answer.
        console.error(
            `smoke test: nbg_convert attempt ${attempt} of ${CONVERT_ATTEMPTS} failed (${outcome.reason}), ` +
                `retrying in ${CONVERT_RETRY_SECONDS} s`,
        );
        await new Promise((resolve) => setTimeout(resolve, CONVERT_RETRY_SECONDS * 1000));
        // A fresh JSON-RPC id per attempt: an id is never reused within a session.
        outcome = await convert(session, firstId + attempt);
        attempt += 1;
    }
    if (outcome.kind === 'transient') {
        fail(outcome.failure);
    }
    return outcome.result;
}

const { endpoint, version } = parseArguments();

const root = await fetch(new URL('/', endpoint));
const rootText = await root.text();
if (root.status !== 200 || !rootText.includes(`nbg-rates-mcp ${version}`)) {
    fail(`GET / answered ${root.status}: ${rootText.slice(0, 200)}`);
}

const favicon = await fetch(new URL('/favicon.ico', endpoint));
await favicon.arrayBuffer();
const faviconType = favicon.headers.get('content-type') ?? '';
if (favicon.status !== 200 || faviconType !== 'image/x-icon') {
    fail(`GET /favicon.ico answered ${favicon.status} ${faviconType}`);
}

const initialize = await call({ endpoint, headers: {} }, 1, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'smoke-http', version: '0.0.0' },
});
const serverInfo = initialize.result['serverInfo'];
const reported = isObject(serverInfo) ? serverInfo['version'] : undefined;
if (reported !== version) {
    fail(`initialize reported version ${String(reported)}, expected ${version}`);
}
const negotiated = initialize.result['protocolVersion'];
if (typeof negotiated !== 'string') {
    fail(`initialize answered without a protocol version: ${JSON.stringify(initialize.result).slice(0, 300)}`);
}
const sessionId = initialize.response.headers.get('mcp-session-id');
const session: Session = {
    endpoint,
    headers: {
        'mcp-protocol-version': negotiated,
        ...(sessionId === null ? {} : { 'mcp-session-id': sessionId }),
    },
};

const initialized = await post(session, { jsonrpc: '2.0', method: 'notifications/initialized' });
await initialized.text();
if (initialized.status !== 202) {
    fail(`notifications/initialized answered ${initialized.status}`);
}

const listed = await call(session, 2, 'tools/list', {});
const tools = listed.result['tools'];
const names = Array.isArray(tools)
    ? tools.map((tool: unknown) => (isObject(tool) && typeof tool['name'] === 'string' ? tool['name'] : '?')).sort()
    : [];
if (JSON.stringify(names) !== JSON.stringify(TOOLS)) {
    fail(`tools/list returned ${names.join(', ')}`);
}

const converted = await convertWithRetries(session, 3);
const structured = converted['structuredContent'];
const resultRounded = isObject(structured) ? structured['resultRounded'] : undefined;
if (typeof resultRounded !== 'number') {
    fail(`nbg_convert answered ${JSON.stringify(converted).slice(0, 300)}`);
}
const cents = resultRounded * 100;
if (!Number.isFinite(resultRounded) || Math.abs(cents - Math.round(cents)) > CENTS_TOLERANCE) {
    fail(`resultRounded ${String(resultRounded)} is not a two decimal amount`);
}
console.log(`smoke test passed: ${endpoint.href} serves ${version}, 10 USD = ${String(resultRounded)} GEL`);
