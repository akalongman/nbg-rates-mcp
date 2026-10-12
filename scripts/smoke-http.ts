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
