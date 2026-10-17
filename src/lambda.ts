import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod';
import {
    createNbgClientFromEnvironment,
    createServiceFromEnvironment,
    mirrorTableFromEnvironment,
    readPackageVersion,
} from './shell/environment.js';
import { handleIncoming } from './shell/http-adapter.js';
import { createHttpHandler, parseAllowedHosts, parseOpenAiChallenge, type RequestLogLine } from './shell/http.js';
import { createLookupScopes, type LookupScopes } from './shell/lookup-scope.js';
import type { MirrorStore } from './shell/mirror-store.js';
import { HOSTED_SERVER_ICONS } from './shell/site/hosted.js';
import { SYNC_REQUEST_TIMEOUT_MS } from './shell/sync-publication.js';
import { notConfiguredLine, runSync, type SyncDeps, type SyncEvent, type SyncLogLine } from './shell/sync.js';

/**
 * AWS Lambda entry with two ways in: requests behind an API Gateway HTTP API (payload format 2.0), and the scheduled
 * sync events EventBridge Scheduler sends, `{ "nbgRatesSync": "hourly" | "window", "scheduledTime": "<ISO 8601>" }`.
 * Any other event throws, which Lambda counts as a function error. The event and result interfaces name only the
 * fields read and written, so the package needs no AWS type package. Built as dist/lambda.js; the handler string is
 * dist/lambda.handler. The service and its cache live for the instance, so a warm instance answers a date once from
 * NBG and then from memory.
 *
 * The mirror is used only when NBG_RATES_MIRROR_TABLE names a DynamoDB table: requests then read it, and sync events
 * fill it. The DynamoDB client comes from the Lambda runtime, so the module that imports it is loaded only then.
 * Unset or blank, requests are answered exactly as before, and a sync event only logs that no mirror is configured.
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

export interface LambdaContext {
    getRemainingTimeInMillis(): number;
}

export interface LambdaHandlerDeps {
    readonly http: (request: Request) => Promise<Response>;
    /** Undefined when no table is configured. */
    readonly sync: ((event: SyncEvent, remainingMs: () => number) => Promise<SyncLogLine>) | undefined;
    readonly log: (line: SyncLogLine) => void;
    readonly now: () => Date;
}

/** A scheduled sync event: the kind of run and Scheduler's <aws.scheduler.scheduled-time>, an offset allowed. */
const SYNC_EVENT = z.object({
    nbgRatesSync: z.enum(['hourly', 'window']),
    scheduledTime: z.iso
        .datetime({ offset: true })
        .transform((text) => new Date(text))
        // A non-finite time must never reach the run's claim, which would store it as null.
        .refine((instant) => Number.isFinite(instant.getTime())),
});

/** The one field that tells an API Gateway event apart; the rest of its shape is API Gateway's, read as before. */
function isApiGatewayEvent(event: unknown): event is ApiGatewayV2Event {
    return (
        typeof event === 'object' &&
        event !== null &&
        'requestContext' in event &&
        typeof event.requestContext === 'object' &&
        event.requestContext !== null &&
        'http' in event.requestContext &&
        typeof event.requestContext.http === 'object' &&
        event.requestContext.http !== null
    );
}

const TEXT_TYPE_PREFIXES: readonly string[] = ['text/', 'application/json', 'application/javascript'];

function isTextContentType(contentType: string | undefined): boolean {
    if (contentType === undefined) {
        return false;
    }
    const type = contentType.toLowerCase();
    return TEXT_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix)) || type.includes('charset=');
}

async function answerRequest(
    http: (request: Request) => Promise<Response>,
    event: ApiGatewayV2Event,
): Promise<ApiGatewayV2Result> {
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
    const response = await handleIncoming(http, {
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

/**
 * An API Gateway event (one whose requestContext.http is an object) is answered through `http`. Any other event must
 * be a sync event, or the handler throws 'unrecognized event' before anything runs. A sync event goes to `sync`, which
 * writes its own line, or without a table is logged as mirror_not_configured; either way the result is undefined.
 * The run's remaining time is asked of the context on each call; without a context (only tests call it so) it is 0,
 * so such a run starts no NBG work.
 */
export function createLambdaHandler(
    deps: LambdaHandlerDeps,
): (event: unknown, context?: LambdaContext) => Promise<ApiGatewayV2Result | undefined> {
    return async function handle(event, context) {
        if (isApiGatewayEvent(event)) {
            return answerRequest(deps.http, event);
        }
        const parsed = SYNC_EVENT.safeParse(event);
        if (!parsed.success) {
            throw new Error('unrecognized event');
        }
        const syncEvent: SyncEvent = { kind: parsed.data.nbgRatesSync, scheduledTime: parsed.data.scheduledTime };
        if (deps.sync === undefined) {
            deps.log(notConfiguredLine(syncEvent, deps.now()));
            return undefined;
        }
        await deps.sync(syncEvent, () => context?.getRemainingTimeInMillis() ?? 0);
        return undefined;
    };
}

/** The mirror's store and the lookup scopes the mirrored service and the HTTP handler share. */
interface Mirror {
    readonly store: MirrorStore;
    readonly scopes: LookupScopes;
}

// The package's own package.json, zipped beside dist/.
const version = readPackageVersion(new URL('../package.json', import.meta.url));
const now = (): Date => new Date();

/**
 * Lambda forwards stdout to CloudWatch; one line per request and one per sync run, text format, fields discovered by
 * Logs Insights.
 */
function writeLine(line: RequestLogLine | SyncLogLine): void {
    console.log(JSON.stringify(line));
}

const table = mirrorTableFromEnvironment(process.env);
const mirror: Mirror | undefined =
    table === undefined
        ? undefined
        : {
              store: (await import('./shell/mirror-dynamodb.js')).createDynamoMirrorStore({ tableName: table }),
              scopes: createLookupScopes(),
          };
// The service gets the store as a MirrorRequestStore: a request can read and add a past table, nothing more.
const { service } = createServiceFromEnvironment(version, process.env, mirror);
const http = createHttpHandler({
    service,
    now,
    version,
    allowedHosts: parseAllowedHosts(process.env['NBG_RATES_HTTP_HOSTS']),
    openAiChallenge: parseOpenAiChallenge(process.env['NBG_RATES_OPENAI_CHALLENGE']),
    serverIcons: HOSTED_SERVER_ICONS,
    log: writeLine,
    ...(mirror === undefined ? {} : { lookupScopes: mirror.scopes }),
});

/**
 * The sync over the full store. Its NBG client keeps the one retry and holds each try to SYNC_REQUEST_TIMEOUT_MS,
 * which every deadline of the run assumes (SYNC_REQUEST_WORST_MS).
 */
function createSync(store: MirrorStore): NonNullable<LambdaHandlerDeps['sync']> {
    const { client } = createNbgClientFromEnvironment(version, process.env, { timeoutMs: SYNC_REQUEST_TIMEOUT_MS });
    const deps: SyncDeps = { store, client, now, sleep: (ms) => delay(ms), log: writeLine };
    return (event, remainingMs) => runSync(event, remainingMs, deps);
}

export const handler: ReturnType<typeof createLambdaHandler> = createLambdaHandler({
    http,
    sync: mirror === undefined ? undefined : createSync(mirror.store),
    log: writeLine,
    now,
});
