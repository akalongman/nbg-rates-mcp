#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createSnapshotCache } from './shell/cache.js';
import { createNbgClient } from './shell/nbg-client.js';
import { createRatesService } from './shell/rates-service.js';
import { createServer } from './shell/server.js';

// JSON-parse boundary: the package's own package.json, shipped beside dist/ and always carrying a version.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
};

const HELP = `nbg-rates-mcp ${version}
MCP server (stdio) for official National Bank of Georgia exchange rates.

Usage: nbg-rates-mcp [--version] [--help]

Environment:
  NBG_RATES_BASE_URL  Override the NBG host (default https://nbg.gov.ge)
  NBG_RATES_DEBUG=1   Log every upstream request to stderr
`;

function main(): void {
    const args = process.argv.slice(2);
    if (args.includes('--version') || args.includes('-v')) {
        process.stdout.write(`${version}\n`);
        return;
    }
    if (args.includes('--help') || args.includes('-h')) {
        process.stdout.write(HELP);
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

    serveStdio(() => createServer({ service, now: () => new Date(), version }));
    console.error(`nbg-rates-mcp ${version} serving on stdio (upstream ${baseUrl})`);
}

main();
