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
