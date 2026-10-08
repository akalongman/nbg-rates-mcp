import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
    convertOutput,
    getRatesOutput,
    listCurrenciesOutput,
    rateHistoryOutput,
} from '../../src/shell/tool-schemas.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'dist', 'bin.js');
const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')));
const USER_AGENT = `nbg-rates-mcp/${version} (+https://github.com/akalongman/nbg-rates-mcp)`;

function childEnv(baseUrl: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
            env[key] = value;
        }
    }
    // The trailing slash must be stripped by the binary; the exact request URLs asserted below would show it.
    env['NBG_RATES_BASE_URL'] = `${baseUrl}/`;
    env['TZ'] = 'America/Los_Angeles';
    return env;
}

describe('nbg-rates-mcp over stdio', () => {
    let server: FixtureServer;
    let client: Client;

    beforeAll(async () => {
        server = await startFixtureServer();
        client = new Client({ name: 'e2e', version: '0.0.0' });
        await client.connect(
            new StdioClientTransport({ command: process.execPath, args: [BIN], env: childEnv(server.baseUrl) }),
        );
    });

    afterAll(async () => {
        await client.close();
        await server.close();
    });

    it('lists the tools', async () => {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'nbg_convert',
            'nbg_get_rates',
            'nbg_list_currencies',
            'nbg_rate_history',
        ]);
    });

    it('answers a Sunday with the carried-over Saturday rate, per unit, even in a US time zone', async () => {
        const result = await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-10-04', currencies: ['usd', 'amd'] },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).not.toHaveProperty('publishedAt');
        const output = getRatesOutput.parse(result.structuredContent);
        expect(output.requestedDate).toBe('2026-10-04');
        expect(output.effectiveDate).toBe('2026-10-03');
        expect(output.carriedOver).toBe(true);
        const amd = output.rates.find((entry) => entry.code === 'AMD');
        expect(amd?.nbgQuantity).toBe(1000);
        expect(amd?.rate).toBe(Number((Number(amd?.nbgRate) / 1000).toFixed(7)));
    });

    it('answers a Monday with the same Saturday rate', async () => {
        const result = await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-10-05', currencies: ['USD'] },
        });
        expect(result.structuredContent).toMatchObject({ effectiveDate: '2026-10-03', carriedOver: true });
    });

    it('refuses a far-future date with an error, without calling NBG', async () => {
        const before = server.requests.length;
        const result = await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2099-01-01', currencies: ['USD'] },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(/2099-01-01.*not published|not published.*2099-01-01/);
        expect(server.requests.length).toBe(before);
    });

    it('converts USD to EUR through GEL', async () => {
        const result = await client.callTool({
            name: 'nbg_convert',
            arguments: { amount: 100, from: 'USD', to: 'EUR', date: '2026-10-07' },
        });
        const output = convertOutput.parse(result.structuredContent);
        expect(output.via).toBe('GEL');
        expect(output.result).toBeCloseTo(100 * output.rate, 9);
    });

    it('lists currencies', async () => {
        const result = await client.callTool({ name: 'nbg_list_currencies', arguments: {} });
        const output = listCurrenciesOutput.parse(result.structuredContent);
        expect(output.currencies.length).toBeGreaterThan(30);
        expect(output.currencies.some((entry) => entry.code === 'USD')).toBe(true);
    });

    it('returns one history point per calendar day from a single CSV request', async () => {
        const before = server.requests.length;
        const result = await client.callTool({
            name: 'nbg_rate_history',
            arguments: { currency: 'USD', from: '2026-10-01', to: '2026-10-07' },
        });
        expect(JSON.stringify(result.structuredContent)).not.toContain('diff');
        const output = rateHistoryOutput.parse(result.structuredContent);
        expect(output.days).toHaveLength(7);
        expect(output.days.filter((point) => point.carriedOver).map((point) => point.date)).toEqual([
            '2026-10-04',
            '2026-10-05',
        ]);
        const issued = server.requests.slice(before).map((request) => request.url);
        expect(issued).toEqual([
            '/gw/api/ct/monetarypolicy/currencies/export/csv?currencies=USD&start=2026-08-31&end=2026-10-07',
        ]);
    });

    it('names the package and its version in the User-Agent of every NBG request', async () => {
        const before = server.requests.length;
        // Georgian 2026-10-07 is asked nowhere else in this file, so it is not cached and reaches NBG.
        await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-10-07', currencies: ['USD'], language: 'ka' },
        });
        await client.callTool({
            name: 'nbg_rate_history',
            arguments: { currency: 'USD', from: '2026-10-06', to: '2026-10-07' },
        });
        const issued = server.requests.slice(before);
        expect(issued.map((request) => request.url)).toEqual([
            '/gw/api/ct/monetarypolicy/currencies/ka/json?date=2026-10-07',
            '/gw/api/ct/monetarypolicy/currencies/export/csv?currencies=USD&start=2026-09-05&end=2026-10-07',
        ]);
        expect(issued.map((request) => request.headers['user-agent'])).toEqual([USER_AGENT, USER_AGENT]);
    });

    it('converts GEL to GEL without calling NBG', async () => {
        const before = server.requests.length;
        const result = await client.callTool({ name: 'nbg_convert', arguments: { amount: 5, from: 'GEL', to: 'gel' } });
        expect(result.structuredContent).toMatchObject({ result: 5, rate: 1, via: 'direct', carriedOver: false });
        expect(server.requests.length).toBe(before);
    });

    it('reports an impossible date as a tool error, without calling NBG', async () => {
        const before = server.requests.length;
        const result = await client.callTool({
            name: 'nbg_convert',
            arguments: { amount: 1, from: 'USD', to: 'EUR', date: '2026-02-30' },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('2026-02-30');
        expect(server.requests.length).toBe(before);
    });

    it('serves the today resource', async () => {
        const { resources } = await client.listResources();
        expect(resources.map((resource) => resource.uri)).toEqual(['nbg://rates/today']);
        const { contents } = await client.readResource({ uri: 'nbg://rates/2026-10-07' });
        const text = contents[0] !== undefined && 'text' in contents[0] ? String(contents[0].text) : '';
        expect(getRatesOutput.parse(JSON.parse(text))).toMatchObject({
            effectiveDate: '2026-10-07',
            carriedOver: false,
        });
    });
});
