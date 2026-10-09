import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { convertAmount } from '../core/convert.js';
import { GEL, parseCurrencyCode } from '../core/currency-code.js';
import { NBG_ARCHIVE_START, TBILISI_TIME_ZONE, parseCalendarDate, todayIn } from '../core/dates.js';
import {
    ok,
    type CalendarDate,
    type CurrencyCode,
    type RatesError,
    type RatesSnapshot,
    type Result,
} from '../core/types.js';
import { historyOutput } from './history-output.js';
import { PROMPTS, promptArgsSchema, renderPrompt } from './prompts.js';
import type { RatesService } from './rates-service.js';
import {
    convertInput,
    convertOutput,
    getRatesInput,
    getRatesOutput,
    listCurrenciesInput,
    listCurrenciesOutput,
    rateHistoryInput,
    rateHistoryOutput,
} from './tool-schemas.js';

export interface ServerDeps {
    readonly service: RatesService;
    readonly now: () => Date;
    readonly version: string;
}

const ISSUES_URL = 'https://github.com/akalongman/nbg-rates-mcp/issues';
const PUBLICATION_RULE = 'NBG sets rates on business days around 17:00 Tbilisi time, valid from the next calendar day.';

export function describeError(error: RatesError): string {
    switch (error.kind) {
        case 'invalid_date':
            return `${error.value} is not a valid calendar date (${error.reason}); use YYYY-MM-DD.`;
        case 'range_too_long':
            return `The range covers ${error.days} days; the maximum is ${error.max}. Split it into shorter ranges.`;
        case 'unknown_currency':
            return `NBG did not quote ${error.code} on the requested date or range. Call nbg_list_currencies for today's codes; NBG has added and dropped currencies over the years, so the code may have rates on other dates.`;
        case 'result_out_of_range':
            return `Converting ${error.amount} ${error.from} to ${error.to} gives a result too large to represent as a number; convert a smaller amount.`;
        case 'no_data_for_date': {
            const subject = error.currency === undefined ? 'rates' : `${error.currency} rate`;
            return `NBG has no ${subject} in force on ${error.date}. The archive starts on ${NBG_ARCHIVE_START}, and a currency has no rate before NBG first quoted it, after NBG stopped quoting it, or on a day where NBG's records have a gap.`;
        }
        case 'rate_not_published': {
            const latest =
                error.latestEffectiveDate === undefined
                    ? ''
                    : ` The latest published rate is valid from ${error.latestEffectiveDate}.`;
            return `NBG has not published a rate for ${error.date} yet.${latest} ${PUBLICATION_RULE}`;
        }
        case 'upstream_unavailable':
            return `NBG did not respond usably (${error.detail}). The request can be retried.`;
        case 'upstream_shape_changed':
            return `The NBG response did not match the expected shape (${error.detail}). Please report this at ${ISSUES_URL} with the package version; the NBG endpoint may have changed.`;
        default: {
            const exhaustive: never = error;
            return exhaustive;
        }
    }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const DATE_RULES =
    'Dates are calendar days in Tbilisi; the default is today. ' +
    'NBG sets a rate on business days around 17:00 Tbilisi time, valid from the next calendar day until the next rate, ' +
    'so after 17:00 tomorrow can be requested by date. ' +
    'Sundays, Mondays and days after a public holiday have no rate of their own: the rate in force was set earlier and is ' +
    'returned with carriedOver true and effectiveDate set to the day it took effect. Quote effectiveDate when carriedOver is true. ' +
    'A date whose rate NBG has not published yet returns an error, never a guess.';

function failure(error: RatesError) {
    return { content: [{ type: 'text' as const, text: describeError(error) }], isError: true };
}

function success<T extends Record<string, unknown>>(output: T) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
}

function resolveDate(input: string | undefined, now: Date): Result<CalendarDate, RatesError> {
    return input === undefined ? ok(todayIn(TBILISI_TIME_ZONE, now)) : parseCalendarDate(input);
}

interface RequestedCodes {
    /** Codes in currency-code shape, to look up in the table. */
    readonly lookup: ReadonlyArray<CurrencyCode>;
    /** Inputs that cannot be a currency code, as typed, once per code ignoring case and surrounding spaces. */
    readonly malformed: ReadonlyArray<string>;
}

/**
 * nbg_get_rates never fails on a code: a malformed one is reported in unknownCodes like a code the table lacks, so
 * one typo does not cost the answer for the other codes.
 */
function splitCodes(inputs: ReadonlyArray<string>): RequestedCodes {
    const lookup: CurrencyCode[] = [];
    const malformed: string[] = [];
    const seenMalformed = new Set<string>();
    for (const input of inputs) {
        const parsed = parseCurrencyCode(input);
        if (parsed.ok) {
            lookup.push(parsed.value);
            continue;
        }
        const key = input.trim().toUpperCase();
        if (!seenMalformed.has(key)) {
            seenMalformed.add(key);
            malformed.push(input);
        }
    }
    return { lookup, malformed };
}

/** A malformed code never equals a well-formed one, so appending it cannot repeat a code the table lacks. */
function snapshotOutput(snapshot: RatesSnapshot, malformedCodes: ReadonlyArray<string> = []) {
    return {
        requestedDate: snapshot.requestedDate,
        effectiveDate: snapshot.effectiveDate,
        carriedOver: snapshot.carriedOver,
        rates: snapshot.rates.map((entry) => ({ ...entry })),
        unknownCodes: [...snapshot.unknownCodes, ...malformedCodes],
    };
}

/** Sent once per session; a client that loads tools on demand reads it to decide when this server is relevant. */
export const SERVER_INSTRUCTIONS =
    'Official exchange rates of the Georgian lari (GEL) set by the National Bank of Georgia (NBG). ' +
    'Use these tools for any question about GEL rates, converting to or from GEL, or historical NBG rates ' +
    'on a date or over a range. Dates are Tbilisi calendar days; quote effectiveDate when carriedOver is true.';

/** Display fields of the server identity; a test keeps them equal to server.json. */
const SERVER_IDENTITY = {
    title: 'NBG Rates (National Bank of Georgia)',
    description: 'GEL exchange rates from the National Bank of Georgia with per-unit values. Not affiliated with NBG.',
    websiteUrl: 'https://github.com/akalongman/nbg-rates-mcp',
} as const;

export function createServer(deps: ServerDeps): McpServer {
    const server = new McpServer(
        { name: 'nbg-rates-mcp', version: deps.version, ...SERVER_IDENTITY },
        { instructions: SERVER_INSTRUCTIONS },
    );

    server.registerTool(
        'nbg_get_rates',
        {
            title: 'NBG rates for a date',
            description:
                'Official National Bank of Georgia (NBG) exchange rates of the Georgian lari (GEL) in force on one calendar date. ' +
                'Every rate is GEL per ONE unit of the currency (NBG quotes some currencies per 10, 100, 1000 or 10000 units; ' +
                'the raw pair is returned as nbgQuantity and nbgRate). ' +
                DATE_RULES,
            inputSchema: getRatesInput,
            outputSchema: getRatesOutput,
            annotations: READ_ONLY,
        },
        async ({ date, currencies, language }) => {
            const resolved = resolveDate(date, deps.now());
            if (!resolved.ok) {
                return failure(resolved.error);
            }
            const requested = currencies === undefined ? undefined : splitCodes(currencies);
            // A list without one well-formed code still asks the service, so its date checks apply as usual.
            const snapshot = await deps.service.getSnapshot({
                date: resolved.value,
                language: language ?? 'en',
                ...(requested === undefined ? {} : { codes: requested.lookup }),
            });
            return snapshot.ok
                ? success(snapshotOutput(snapshot.value, requested?.malformed))
                : failure(snapshot.error);
        },
    );

    server.registerTool(
        'nbg_convert',
        {
            title: 'Convert via NBG rate',
            description:
                'Converts an amount between two currencies using the official NBG rate in force on a calendar date. ' +
                'Either side may be GEL; a pair without GEL is converted through GEL (via: "GEL"). ' +
                'The result is unrounded: round it for display. ' +
                DATE_RULES,
            inputSchema: convertInput,
            outputSchema: convertOutput,
            annotations: READ_ONLY,
        },
        async ({ amount, from, to, date }) => {
            const resolved = resolveDate(date, deps.now());
            if (!resolved.ok) {
                return failure(resolved.error);
            }
            const fromCode = parseCurrencyCode(from);
            if (!fromCode.ok) {
                return failure(fromCode.error);
            }
            const toCode = parseCurrencyCode(to);
            if (!toCode.ok) {
                return failure(toCode.error);
            }
            if (fromCode.value === GEL && toCode.value === GEL) {
                // The identity needs no NBG rate, so it answers for any valid date without a request.
                return success({
                    amount,
                    from: GEL,
                    to: GEL,
                    result: amount,
                    rate: 1,
                    via: 'direct' as const,
                    requestedDate: resolved.value,
                    effectiveDate: resolved.value,
                    carriedOver: false,
                });
            }
            const snapshot = await deps.service.getSnapshot({ date: resolved.value, language: 'en' });
            if (!snapshot.ok) {
                return failure(snapshot.error);
            }
            const conversion = convertAmount(snapshot.value, amount, fromCode.value, toCode.value);
            return conversion.ok ? success({ ...conversion.value }) : failure(conversion.error);
        },
    );

    server.registerTool(
        'nbg_list_currencies',
        {
            title: 'NBG currency list',
            description:
                'Lists every currency NBG publishes a GEL rate for today, with its name and the unit quantity NBG quotes it in. ' +
                'NBG quoted other currencies in the past, so a code missing here may still have historical rates.',
            inputSchema: listCurrenciesInput,
            outputSchema: listCurrenciesOutput,
            annotations: READ_ONLY,
        },
        async ({ language }) => {
            const snapshot = await deps.service.getSnapshot({
                date: todayIn(TBILISI_TIME_ZONE, deps.now()),
                language: language ?? 'en',
            });
            if (!snapshot.ok) {
                return failure(snapshot.error);
            }
            return success({
                effectiveDate: snapshot.value.effectiveDate,
                currencies: snapshot.value.rates.map(({ code, name, nbgQuantity }) => ({ code, name, nbgQuantity })),
            });
        },
    );

    server.registerTool(
        'nbg_rate_history',
        {
            title: 'NBG rate history',
            description:
                'Official NBG rate of one currency (GEL per one unit) in force on every calendar day of an inclusive range ' +
                'of at most 366 days. Dates are calendar days in Tbilisi. Days without a rate of their own (Sundays, ' +
                'Mondays and days after a public holiday; before September 2021 NBG set a rate for every calendar day) ' +
                'carry the earlier rate. Days whose own rate is in force contain only date and rate; a carried-over day ' +
                'adds effectiveDate and carriedOver: true. Quote effectiveDate when carriedOver is true. A range reaching ' +
                'a date NBG has not published yet returns an error. One NBG request per call.',
            inputSchema: rateHistoryInput,
            outputSchema: rateHistoryOutput,
            annotations: READ_ONLY,
        },
        async ({ currency, from, to }) => {
            const code = parseCurrencyCode(currency);
            if (!code.ok) {
                return failure(code.error);
            }
            const fromDate = parseCalendarDate(from);
            if (!fromDate.ok) {
                return failure(fromDate.error);
            }
            const toDate = parseCalendarDate(to);
            if (!toDate.ok) {
                return failure(toDate.error);
            }
            const history = await deps.service.getHistory({
                currency: code.value,
                from: fromDate.value,
                to: toDate.value,
            });
            if (!history.ok) {
                return failure(history.error);
            }
            return success(historyOutput(history.value));
        },
    );

    for (const prompt of PROMPTS) {
        server.registerPrompt(
            prompt.name,
            { title: prompt.title, description: prompt.description, argsSchema: promptArgsSchema(prompt) },
            (args) => ({
                messages: [{ role: 'user', content: { type: 'text', text: renderPrompt(prompt.text, args) } }],
            }),
        );
    }

    server.registerResource(
        'nbg-rates',
        new ResourceTemplate('nbg://rates/{date}', {
            list: () =>
                Promise.resolve({
                    resources: [{ uri: 'nbg://rates/today', name: "Today's NBG rates", mimeType: 'application/json' }],
                }),
        }),
        {
            title: 'NBG rates by date',
            description:
                'Full official NBG rate table in force on a calendar date (YYYY-MM-DD) or "today", as JSON with per-unit rates.',
            mimeType: 'application/json',
        },
        async (uri, variables) => {
            const raw = String(variables['date'] ?? 'today');
            const resolved = raw === 'today' ? ok(todayIn(TBILISI_TIME_ZONE, deps.now())) : parseCalendarDate(raw);
            if (!resolved.ok) {
                throw new Error(describeError(resolved.error));
            }
            const snapshot = await deps.service.getSnapshot({ date: resolved.value, language: 'en' });
            if (!snapshot.ok) {
                throw new Error(describeError(snapshot.error));
            }
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify(snapshotOutput(snapshot.value)),
                    },
                ],
            };
        },
    );

    return server;
}
