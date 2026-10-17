import { readFileSync } from 'node:fs';
import { createSnapshotCache } from './cache.js';
import type { LookupScopes } from './lookup-scope.js';
import type { MirrorRequestStore } from './mirror-store.js';
import { createMirroredRatesService } from './mirrored-rates-service.js';
import { createNbgClient, type NbgClient } from './nbg-client.js';
import { createRatesService, type RatesService } from './rates-service.js';

/**
 * What both entries (bin.ts on a machine, lambda.ts on AWS) read from their process: the package version and the
 * variables that configure the NBG client. One copy, so NBG_RATES_BASE_URL and NBG_RATES_DEBUG mean the same in both.
 * NBG_RATES_MIRROR_TABLE is read by lambda.ts alone, through mirrorTableFromEnvironment.
 */

/** The mirrored service's one try at NBG when the mirror holds an answer to fall back on. */
export const SHORT_ATTEMPT_TIMEOUT_MS = 3_000;

export interface EnvironmentService {
    readonly service: RatesService;
    /** The NBG host the service calls, without a trailing slash. */
    readonly baseUrl: string;
}

/**
 * Reads the version of the package.json at the URL. Each entry passes the URL relative to its own file, which sits in
 * dist/ beside that package.json in the checkout, the npm package, the Lambda zip and the Claude Desktop bundle alike.
 */
export function readPackageVersion(packageJson: URL): string {
    // JSON-parse boundary: the package's own package.json, always carrying a version.
    const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
    return version;
}

/** The DynamoDB table NBG_RATES_MIRROR_TABLE names, trimmed; undefined when it is unset, empty or blank. */
export function mirrorTableFromEnvironment(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const table = (env['NBG_RATES_MIRROR_TABLE'] ?? '').trim();
    return table === '' ? undefined : table;
}

/** An NBG client on the configured host, with the versioned user agent; `options` override the client's timing. */
export function createNbgClientFromEnvironment(
    version: string,
    env: Readonly<Record<string, string | undefined>>,
    options: { readonly timeoutMs?: number; readonly retry?: boolean } = {},
): { readonly client: NbgClient; readonly baseUrl: string } {
    const baseUrl = (env['NBG_RATES_BASE_URL'] ?? 'https://nbg.gov.ge').replace(/\/+$/, '');
    const debug = env['NBG_RATES_DEBUG'] === '1';
    const { timeoutMs, retry } = options;
    const client = createNbgClient({
        baseUrl,
        userAgent: `nbg-rates-mcp/${version} (+https://github.com/akalongman/nbg-rates-mcp)`,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(retry === undefined ? {} : { retry }),
        ...(debug ? { log: (message: string) => console.error(`[nbg-rates-mcp] ${message}`) } : {}),
    });
    return { client, baseUrl };
}

/**
 * The rates service. Without `mirror`, today's service: the default client and the instance's cache. With it, the
 * mirrored service over that store and those scopes, asking NBG through today's service (`live`) or through one over
 * a one-try client of SHORT_ATTEMPT_TIMEOUT_MS (`shortLive`), the two sharing one cache.
 */
export function createServiceFromEnvironment(
    version: string,
    env: Readonly<Record<string, string | undefined>>,
    mirror?: { readonly store: MirrorRequestStore; readonly scopes: LookupScopes },
): EnvironmentService {
    const { client, baseUrl } = createNbgClientFromEnvironment(version, env);
    const now = (): Date => new Date();
    const cache = createSnapshotCache();
    const live = createRatesService({ client, cache, now });
    if (mirror === undefined) {
        return { service: live, baseUrl };
    }
    const short = createNbgClientFromEnvironment(version, env, { timeoutMs: SHORT_ATTEMPT_TIMEOUT_MS, retry: false });
    const shortLive = createRatesService({ client: short.client, cache, now });
    const service = createMirroredRatesService({ mirror: mirror.store, live, shortLive, scopes: mirror.scopes, now });
    return { service, baseUrl };
}
