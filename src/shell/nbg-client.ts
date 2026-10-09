import { parseNbgCsv, type NbgCsvRow } from '../core/nbg-csv.js';
import { parseNbgResponse, type NbgDay } from '../core/nbg-schema.js';
import {
    err,
    ok,
    type CalendarDate,
    type CurrencyCode,
    type Language,
    type RatesError,
    type Result,
} from '../core/types.js';

export interface NbgClientOptions {
    readonly baseUrl: string;
    readonly userAgent: string;
    readonly timeoutMs?: number;
    readonly retryDelayMs?: number;
    readonly fetchImpl?: typeof fetch;
    readonly log?: (message: string) => void;
}

export interface NbgClient {
    fetchDay(date: CalendarDate, language: Language): Promise<Result<NbgDay, RatesError>>;
    fetchRange(
        currencies: ReadonlyArray<CurrencyCode>,
        start: CalendarDate,
        end: CalendarDate,
    ): Promise<Result<ReadonlyArray<NbgCsvRow>, RatesError>>;
}

/** The token the response content type must contain: application/json or application/csv. */
type ExpectedType = 'json' | 'csv';

type Attempt =
    { kind: 'ok'; text: string } | { kind: 'retryable'; detail: string } | { kind: 'fatal'; error: RatesError };

const API_PATH = '/gw/api/ct/monetarypolicy/currencies';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text: string): Result<unknown, RatesError> {
    try {
        return ok(JSON.parse(text) as unknown);
    } catch {
        return err({ kind: 'upstream_unavailable', detail: `response is not valid JSON: ${text.slice(0, 80)}` });
    }
}

export function createNbgClient(options: NbgClientOptions): NbgClient {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const retryDelayMs = options.retryDelayMs ?? 500;
    const fetchImpl = options.fetchImpl ?? fetch;
    const log = options.log ?? (() => undefined);

    async function attempt(url: string, expected: ExpectedType): Promise<Attempt> {
        const started = Date.now();
        // One log line per attempt, written when the attempt ends, so a body that fails after the status line
        // reads "200, then <error>" instead of a second line that looks like another request.
        let summary: string | undefined;
        try {
            const response = await fetchImpl(url, {
                headers: {
                    'user-agent': options.userAgent,
                    accept: expected === 'json' ? 'application/json' : 'application/csv, text/csv',
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
            summary = String(response.status);
            if (response.status === 429 || response.status >= 500) {
                await response.body?.cancel();
                return { kind: 'retryable', detail: `HTTP ${response.status}` };
            }
            if (!response.ok) {
                await response.body?.cancel();
                return { kind: 'fatal', error: { kind: 'upstream_unavailable', detail: `HTTP ${response.status}` } };
            }
            const contentType = response.headers.get('content-type') ?? '';
            const text = await response.text();
            if (!contentType.includes(expected)) {
                // A firewall block page arrives as 200 text/html. It says nothing about NBG's data shape.
                return {
                    kind: 'fatal',
                    error: {
                        kind: 'upstream_unavailable',
                        detail: `unexpected ${contentType || 'untyped'} response: ${text.slice(0, 80)}`,
                    },
                };
            }
            return { kind: 'ok', text };
        } catch (error: unknown) {
            const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            summary = summary === undefined ? detail : `${summary}, then ${detail}`;
            return { kind: 'retryable', detail };
        } finally {
            log(`GET ${url} -> ${summary ?? 'no response'} in ${Date.now() - started}ms`);
        }
    }

    async function fetchText(url: string, expected: ExpectedType): Promise<Result<string, RatesError>> {
        let outcome = await attempt(url, expected);
        if (outcome.kind === 'retryable') {
            await sleep(retryDelayMs);
            outcome = await attempt(url, expected);
        }
        if (outcome.kind === 'retryable') {
            return err({ kind: 'upstream_unavailable', detail: `${outcome.detail} after retry` });
        }
        if (outcome.kind === 'fatal') {
            return err(outcome.error);
        }
        return ok(outcome.text);
    }

    return {
        async fetchDay(date, language) {
            const text = await fetchText(`${options.baseUrl}${API_PATH}/${language}/json?date=${date}`, 'json');
            if (!text.ok) {
                return text;
            }
            const json = parseJson(text.value);
            if (!json.ok) {
                return json;
            }
            const parsed = parseNbgResponse(json.value);
            if (!parsed.ok) {
                return parsed;
            }
            const day = parsed.value[0];
            if (day === undefined) {
                return err({ kind: 'no_data_for_date', date, currency: undefined });
            }
            return ok(day);
        },

        async fetchRange(currencies, start, end) {
            const codes = currencies.map((code) => `currencies=${code}`).join('&');
            const url = `${options.baseUrl}${API_PATH}/export/csv?${codes}&start=${start}&end=${end}`;
            const text = await fetchText(url, 'csv');
            if (!text.ok) {
                return text;
            }
            return parseNbgCsv(text.value);
        },
    };
}
