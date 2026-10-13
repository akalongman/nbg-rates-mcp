/**
 * Checks a hosted endpoint after a deploy: GET / names the version, initialize reports it, the five tools are listed
 * and a conversion returns a two decimal amount. The deploy step that runs it holds the AWS session, so it loads no
 * installed package: it speaks MCP's JSON-RPC over fetch and reads the answer as JSON or as an SSE stream, and it uses
 * only erasable TypeScript syntax, which Node runs as is. Usage: node scripts/smoke-http.ts <url> <version>. Exit 0 on
 * success, 1 with the first failing check on stderr, 2 on a usage error.
 */

const TOOLS = ['nbg_convert', 'nbg_convert_many', 'nbg_get_rates', 'nbg_list_currencies', 'nbg_rate_history'];
// The latest protocol version of the SDK in package-lock.json; the server answers with the one it speaks.
const PROTOCOL_VERSION = '2025-11-25';
// A two decimal amount times 100 lies within float error of an integer (20.01 * 100 is 2001.0000000000002); a third
// decimal puts it at least 0.1 away.
const CENTS_TOLERANCE = 1e-6;

type JsonObject = Readonly<Record<string, unknown>>;

interface Session {
    readonly endpoint: URL;
    readonly headers: Readonly<Record<string, string>>;
}

interface Answer {
    readonly result: JsonObject;
    readonly response: Response;
}

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

/** Sends a request and returns the result of the answer carrying its id; any other outcome fails the run. */
async function call(session: Session, id: number, method: string, params: JsonObject): Promise<Answer> {
    const response = await post(session, { jsonrpc: '2.0', id, method, params });
    const body = await response.text();
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

const { endpoint, version } = parseArguments();

const root = await fetch(new URL('/', endpoint));
const rootText = await root.text();
if (root.status !== 200 || !rootText.includes(`nbg-rates-mcp ${version}`)) {
    fail(`GET / answered ${root.status}: ${rootText.slice(0, 200)}`);
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

const converted = await call(session, 3, 'tools/call', {
    name: 'nbg_convert',
    arguments: { amount: 10, from: 'USD', to: 'GEL' },
});
const structured = converted.result['structuredContent'];
const resultRounded = isObject(structured) ? structured['resultRounded'] : undefined;
if (converted.result['isError'] === true || typeof resultRounded !== 'number') {
    fail(`nbg_convert answered ${JSON.stringify(converted.result).slice(0, 300)}`);
}
const cents = resultRounded * 100;
if (!Number.isFinite(resultRounded) || Math.abs(cents - Math.round(cents)) > CENTS_TOLERANCE) {
    fail(`resultRounded ${String(resultRounded)} is not a two decimal amount`);
}
console.log(`smoke test passed: ${endpoint.href} serves ${version}, 10 USD = ${String(resultRounded)} GEL`);
