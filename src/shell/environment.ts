import { readFileSync } from 'node:fs';
import { createSnapshotCache } from './cache.js';
import { createNbgClient } from './nbg-client.js';
import { createRatesService, type RatesService } from './rates-service.js';

/**
 * What both entries (bin.ts on a machine, lambda.ts on AWS) read from their process: the package version and the
 * variables that configure the NBG client. One copy, so NBG_RATES_BASE_URL and NBG_RATES_DEBUG mean the same in both.
 */

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

export function createServiceFromEnvironment(
    version: string,
    env: Readonly<Record<string, string | undefined>>,
): EnvironmentService {
    const baseUrl = (env['NBG_RATES_BASE_URL'] ?? 'https://nbg.gov.ge').replace(/\/+$/, '');
    const debug = env['NBG_RATES_DEBUG'] === '1';
    const client = createNbgClient({
        baseUrl,
        userAgent: `nbg-rates-mcp/${version} (+https://github.com/akalongman/nbg-rates-mcp)`,
        ...(debug ? { log: (message: string) => console.error(`[nbg-rates-mcp] ${message}`) } : {}),
    });
    const service = createRatesService({ client, cache: createSnapshotCache(), now: () => new Date() });
    return { service, baseUrl };
}
