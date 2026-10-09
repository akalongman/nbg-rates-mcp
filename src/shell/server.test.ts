import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { code, date } from '../../test/helpers/values.js';
import { selectCurrencies } from '../core/normalize.js';
import {
    err,
    ok,
    type CalendarDate,
    type CurrencyCode,
    type HistoryPoint,
    type Language,
    type RatesError,
    type RatesSnapshot,
} from '../core/types.js';
import type { RatesService } from './rates-service.js';
import { createServer, describeError } from './server.js';
import { getRatesOutput } from './tool-schemas.js';

const stubService: RatesService = {
    getSnapshot: () =>
        Promise.resolve(
            ok({
                requestedDate: date('2026-10-07'),
                effectiveDate: date('2026-10-07'),
                carriedOver: false,
                rates: [],
                unknownCodes: [],
            }),
        ),
    getHistory: () => Promise.resolve(err({ kind: 'upstream_unavailable', detail: 'stub' })),
};

/** Three rows of the table NBG published for 2026-10-07, per unit as normalizeSnapshot returns them. */
const TABLE: RatesSnapshot = {
    requestedDate: date('2026-10-07'),
    effectiveDate: date('2026-10-07'),
    carriedOver: false,
    rates: [
        {
            code: code('AMD'),
            name: 'Armenian Dram',
            rate: 0.0071783,
            diff: 0.0000004,
            nbgQuantity: 1000,
            nbgRate: 7.1783,
        },
        { code: code('EUR'), name: 'Euro', rate: 2.9263, diff: 0.0094, nbgQuantity: 1, nbgRate: 2.9263 },
        { code: code('USD'), name: 'US Dollar', rate: 2.6025, diff: -0.0007, nbgQuantity: 1, nbgRate: 2.6025 },
    ],
    unknownCodes: [],
};

interface SnapshotRequest {
    readonly date: CalendarDate;
    readonly language: Language;
    readonly codes: ReadonlyArray<CurrencyCode> | undefined;
}

/** Answers every date with TABLE, filters codes as the real service does, and records what it was asked. */
function tableService(): { service: RatesService; requests: SnapshotRequest[] } {
    const requests: SnapshotRequest[] = [];
    const service: RatesService = {
        getSnapshot({ date: requestedDate, language, codes }) {
            requests.push({ date: requestedDate, language, codes });
            const snapshot = { ...TABLE, requestedDate, carriedOver: TABLE.effectiveDate < requestedDate };
            return Promise.resolve(ok(codes === undefined ? snapshot : selectCurrencies(snapshot, codes)));
        },
        getHistory: () => Promise.resolve(err({ kind: 'upstream_unavailable', detail: 'stub' })),
    };
    return { service, requests };
}

async function connectedClient(deps: { service?: RatesService; now?: () => Date } = {}): Promise<Client> {
    const server = createServer({
        service: deps.service ?? stubService,
        now: deps.now ?? (() => new Date('2026-10-08T06:00:00Z')),
        version: '0.0.0-test',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
}

describe('describeError', () => {
    it('gives an actionable sentence for every variant', () => {
        const cases: ReadonlyArray<[RatesError, RegExp]> = [
            [
                { kind: 'invalid_date', value: '2026-02-30', reason: 'not a real calendar date' },
                /2026-02-30.*YYYY-MM-DD/,
            ],
            [{ kind: 'range_too_long', days: 400, max: 366 }, /400.*366/],
            [
                { kind: 'unknown_currency', code: 'XXX' },
                /XXX on the requested date or range.*nbg_list_currencies.*other dates/,
            ],
            [
                { kind: 'result_out_of_range', amount: 1e308, from: code('USD'), to: code('AMD') },
                /1e\+308 USD to AMD.*smaller amount/,
            ],
            [{ kind: 'no_data_for_date', date: date('1995-06-01'), currency: undefined }, /1995-06-01.*1995-10-14/],
            [
                { kind: 'no_data_for_date', date: date('2005-03-15'), currency: code('AZN') },
                /AZN.*2005-03-15.*1995-10-14/,
            ],
            [
                { kind: 'no_data_for_date', date: date('2026-01-01'), currency: code('BGN') },
                /BGN rate in force on 2026-01-01.*first quoted.*stopped quoting.*gap/,
            ],
            [
                { kind: 'rate_not_published', date: date('2026-10-09'), latestEffectiveDate: date('2026-10-08') },
                /2026-10-09.*2026-10-08.*17:00/,
            ],
            [
                { kind: 'rate_not_published', date: date('2099-01-01'), latestEffectiveDate: undefined },
                /2099-01-01.*17:00/,
            ],
            [{ kind: 'upstream_unavailable', detail: 'HTTP 503' }, /503.*retried/],
            [{ kind: 'upstream_shape_changed', detail: 'currencies: expected array' }, /currencies.*issues/],
        ];
        for (const [error, pattern] of cases) {
            expect(describeError(error)).toMatch(pattern);
        }
    });
});

describe('createServer', () => {
    it('registers the four nbg_ tools and the rates resource', async () => {
        const client = await connectedClient();

        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'nbg_convert',
            'nbg_get_rates',
            'nbg_list_currencies',
            'nbg_rate_history',
        ]);
        for (const tool of tools) {
            expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
            expect(tool.outputSchema).toBeDefined();
            expect(JSON.stringify(tool)).not.toMatch(/isFallback|publishedAt/);
        }
        const history = tools.find((tool) => tool.name === 'nbg_rate_history');
        expect(Object.keys(history?.inputSchema.properties ?? {}).sort()).toEqual(['currency', 'from', 'to']);

        const { resourceTemplates } = await client.listResourceTemplates();
        expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual(['nbg://rates/{date}']);
        const { resources } = await client.listResources();
        expect(resources.map((resource) => resource.uri)).toEqual(['nbg://rates/today']);

        await client.close();
    });

    it('sends the instructions, short and leading with what the server is for', async () => {
        const client = await connectedClient();

        const instructions = client.getInstructions();
        expect(instructions).toBe(
            'Official exchange rates of the Georgian lari (GEL) set by the National Bank of Georgia (NBG). ' +
                'Use these tools for any question about GEL rates, converting to or from GEL, or historical NBG rates ' +
                'on a date or over a range. Dates are Tbilisi calendar days; quote effectiveDate when carriedOver is true.',
        );
        expect(instructions?.length).toBeLessThan(400);

        await client.close();
    });

    it('identifies itself with the title, description and website of server.json', async () => {
        const client = await connectedClient();
        const registryEntry = z
            .object({ title: z.string(), description: z.string(), websiteUrl: z.string() })
            .parse(JSON.parse(readFileSync(new URL('../../server.json', import.meta.url), 'utf8')));

        expect(client.getServerVersion()).toEqual({
            name: 'nbg-rates-mcp',
            version: '0.0.0-test',
            title: registryEntry.title,
            description: registryEntry.description,
            websiteUrl: registryEntry.websiteUrl,
        });

        await client.close();
    });

    it('shows the title and description it sends in the bundle manifest as well', async () => {
        const client = await connectedClient();
        // Claude Desktop shows the .mcpb manifest, not the identity the server sends, so the two must not drift.
        const manifest = z
            .object({ display_name: z.string(), description: z.string() })
            .parse(JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8')));

        expect({ title: manifest.display_name, description: manifest.description }).toEqual({
            title: client.getServerVersion()?.title,
            description: client.getServerVersion()?.description,
        });

        await client.close();
    });

    it('declares the compact history day: date and rate required, carriedOver only as the constant true', async () => {
        const client = await connectedClient();
        const { tools } = await client.listTools();
        const history = tools.find((tool) => tool.name === 'nbg_rate_history');

        const daySchema = z
            .object({
                properties: z.object({
                    days: z.object({
                        items: z.object({
                            properties: z.record(z.string(), z.unknown()),
                            required: z.array(z.string()),
                        }),
                    }),
                }),
            })
            .parse(history?.outputSchema).properties.days.items;
        expect([...daySchema.required].sort()).toEqual(['date', 'rate']);
        expect(daySchema.properties['carriedOver']).toMatchObject({ type: 'boolean', const: true });
        expect(daySchema.properties['effectiveDate']).toMatchObject({
            type: 'string',
            description:
                'Present only on carried-over days: the calendar date the rate took effect. ' +
                'When absent, the rate took effect on date.',
        });
        expect(history?.description).toContain(
            'Days whose own rate is in force contain only date and rate; a carried-over day adds effectiveDate and ' +
                'carriedOver: true.',
        );

        await client.close();
    });

    it('answers nbg_rate_history with compact days and the same JSON in its one text block', async () => {
        function point(day: string, effective: string, rate: number): HistoryPoint {
            return { date: date(day), effectiveDate: date(effective), rate, carriedOver: effective < day };
        }
        // USD 2026-10-02 (Friday) to 2026-10-06 (Tuesday), as NBG published it: Saturday has its own table.
        const days = [
            point('2026-10-02', '2026-10-02', 2.6042),
            point('2026-10-03', '2026-10-03', 2.6039),
            point('2026-10-04', '2026-10-03', 2.6039),
            point('2026-10-05', '2026-10-03', 2.6039),
            point('2026-10-06', '2026-10-06', 2.6032),
        ];
        const client = await connectedClient({
            service: {
                ...stubService,
                getHistory: ({ currency, from, to }) => Promise.resolve(ok({ currency, from, to, days })),
            },
        });

        const result = await client.callTool({
            name: 'nbg_rate_history',
            arguments: { currency: 'USD', from: '2026-10-02', to: '2026-10-06' },
        });

        const text =
            '{"currency":"USD","from":"2026-10-02","to":"2026-10-06","days":[' +
            '{"date":"2026-10-02","rate":2.6042},' +
            '{"date":"2026-10-03","rate":2.6039},' +
            '{"date":"2026-10-04","rate":2.6039,"effectiveDate":"2026-10-03","carriedOver":true},' +
            '{"date":"2026-10-05","rate":2.6039,"effectiveDate":"2026-10-03","carriedOver":true},' +
            '{"date":"2026-10-06","rate":2.6032}]}';
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: 'text', text }]);
        expect(result.structuredContent).toEqual(JSON.parse(text));

        await client.close();
    });

    it('returns an isError result with the error sentence for an impossible date', async () => {
        const client = await connectedClient();
        const result = await client.callTool({ name: 'nbg_get_rates', arguments: { date: '2026-02-30' } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('2026-02-30');
        await client.close();
    });

    it('rejects an empty currency list instead of answering with nothing', async () => {
        const client = await connectedClient();
        // The SDK may report schema failures as an isError result or as a protocol error; both are a rejection.
        const rejected = await client.callTool({ name: 'nbg_get_rates', arguments: { currencies: [] } }).then(
            (result) => result.isError === true,
            () => true,
        );
        expect(rejected).toBe(true);
        await client.close();
    });

    it('answers the valid codes and lists a code that cannot be a currency in unknownCodes', async () => {
        const { service, requests } = tableService();
        const client = await connectedClient({ service });

        const result = await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-10-07', currencies: ['USD', 'EURO'] },
        });

        expect(result.isError).toBeFalsy();
        const output = getRatesOutput.parse(result.structuredContent);
        expect(output.rates.map((entry) => entry.code)).toEqual(['USD']);
        expect(output.unknownCodes).toEqual(['EURO']);
        expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
        expect(requests).toEqual([{ date: '2026-10-07', language: 'en', codes: ['USD'] }]);
        await client.close();
    });

    it('answers the valid codes and lists a currency name typed in place of its code in unknownCodes', async () => {
        const { service, requests } = tableService();
        const client = await connectedClient({ service });

        const result = await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-10-07', currencies: ['USD', 'Armenian dram'] },
        });

        expect(result.isError).toBeFalsy();
        const output = getRatesOutput.parse(result.structuredContent);
        expect(output.rates.map((entry) => entry.code)).toEqual(['USD']);
        expect(output.unknownCodes).toEqual(['Armenian dram']);
        expect(requests).toEqual([{ date: '2026-10-07', language: 'en', codes: ['USD'] }]);
        await client.close();
    });

    it('answers the valid codes and lists an empty entry in unknownCodes', async () => {
        const { service, requests } = tableService();
        const client = await connectedClient({ service });

        const result = await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-10-07', currencies: ['USD', ''] },
        });

        expect(result.isError).toBeFalsy();
        const output = getRatesOutput.parse(result.structuredContent);
        expect(output.rates.map((entry) => entry.code)).toEqual(['USD']);
        expect(output.unknownCodes).toEqual(['']);
        expect(requests).toEqual([{ date: '2026-10-07', language: 'en', codes: ['USD'] }]);
        await client.close();
    });

    it('lists each unknown code once: absent from the table first, then malformed as first typed', async () => {
        const { service } = tableService();
        const client = await connectedClient({ service });

        // XXX is well formed but not in the table; "Euro" and " EURO " are one malformed code typed twice.
        const result = await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-10-07', currencies: ['usd', 'Euro', 'XXX', ' EURO ', 'xxx', 'USD'] },
        });

        expect(result.isError).toBeFalsy();
        const output = getRatesOutput.parse(result.structuredContent);
        expect(output.rates.map((entry) => entry.code)).toEqual(['USD']);
        expect(output.unknownCodes).toEqual(['XXX', 'Euro']);
        await client.close();
    });

    it('answers a list without one well-formed code with no rates, after the same date checks', async () => {
        const { service, requests } = tableService();
        const client = await connectedClient({ service });

        const result = await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-10-08', currencies: ['EURO', 'dollars', 'euro'] },
        });
        expect(result.isError).toBeFalsy();
        expect(getRatesOutput.parse(result.structuredContent)).toEqual({
            requestedDate: '2026-10-08',
            effectiveDate: '2026-10-07',
            carriedOver: true,
            rates: [],
            unknownCodes: ['EURO', 'dollars'],
        });
        // The service is still asked, so its checks (beyond tomorrow, not published, no data) apply as usual.
        expect(requests).toEqual([{ date: '2026-10-08', language: 'en', codes: [] }]);

        const impossible = await client.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-02-30', currencies: ['EURO'] },
        });
        expect(impossible.isError).toBe(true);
        expect(JSON.stringify(impossible.content)).toContain('2026-02-30');
        expect(requests).toHaveLength(1);
        await client.close();

        const unpublished: RatesService = {
            getSnapshot: ({ date: requestedDate }) =>
                Promise.resolve(
                    err({ kind: 'rate_not_published', date: requestedDate, latestEffectiveDate: date('2026-10-08') }),
                ),
            getHistory: () => Promise.resolve(err({ kind: 'upstream_unavailable', detail: 'stub' })),
        };
        const unpublishedClient = await connectedClient({ service: unpublished });
        const tomorrow = await unpublishedClient.callTool({
            name: 'nbg_get_rates',
            arguments: { date: '2026-10-09', currencies: ['EURO'] },
        });
        expect(tomorrow.isError).toBe(true);
        expect(JSON.stringify(tomorrow.content)).toMatch(/2026-10-09.*not published|not published.*2026-10-09/);
        await unpublishedClient.close();
    });

    it('rejects a conversion whose result overflows instead of answering it', async () => {
        const { service } = tableService();
        const client = await connectedClient({ service });

        // 1e308 USD is about 3.6e310 AMD, beyond the largest double, so the unrounded result is Infinity.
        const result = await client.callTool({
            name: 'nbg_convert',
            arguments: { amount: 1e308, from: 'USD', to: 'AMD', date: '2026-10-07' },
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        // The project's own message, not the SDK's output validator rejecting Infinity.
        expect(result.content).toEqual([
            {
                type: 'text',
                text: describeError({
                    kind: 'result_out_of_range',
                    amount: 1e308,
                    from: code('USD'),
                    to: code('AMD'),
                }),
            },
        ]);
        await client.close();
    });

    it('resolves today as the Tbilisi calendar date, which can differ from the UTC one', async () => {
        const { service, requests } = tableService();
        // 21:30 UTC on 2026-10-07 is 01:30 on 2026-10-08 in Tbilisi (UTC+4).
        const client = await connectedClient({ service, now: () => new Date('2026-10-07T21:30:00Z') });

        const { contents } = await client.readResource({ uri: 'nbg://rates/today' });
        expect(contents).toHaveLength(1);
        const [content] = contents;
        expect(content?.uri).toBe('nbg://rates/today');
        const text = content !== undefined && 'text' in content ? content.text : '';
        expect(getRatesOutput.parse(JSON.parse(text))).toMatchObject({
            requestedDate: '2026-10-08',
            effectiveDate: '2026-10-07',
            carriedOver: true,
        });
        expect(requests).toEqual([{ date: '2026-10-08', language: 'en', codes: undefined }]);

        // The tools default to the same day when the date is omitted.
        await client.callTool({ name: 'nbg_get_rates', arguments: { currencies: ['USD'] } });
        await client.callTool({ name: 'nbg_convert', arguments: { amount: 1, from: 'USD', to: 'EUR' } });
        await client.callTool({ name: 'nbg_list_currencies', arguments: {} });
        expect(requests.map((request) => request.date)).toEqual([
            '2026-10-08',
            '2026-10-08',
            '2026-10-08',
            '2026-10-08',
        ]);
        await client.close();
    });
});
