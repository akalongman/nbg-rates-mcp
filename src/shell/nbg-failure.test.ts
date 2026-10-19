import { describe, expect, it } from 'vitest';
import { code, date } from '../../test/helpers/values.js';
import { afterRetry, httpCause, NBG_CAUSE } from '../core/nbg-cause.js';
import { err, ok, type HistorySeries, type RatesError, type RatesSnapshot, type Result } from '../core/types.js';
import {
    asNbgFailure,
    nbgFailureKind,
    reportingNbgFailures,
    type NbgFailure,
    type NbgFailureKind,
} from './nbg-failure.js';
import type { RatesService } from './rates-service.js';

const SNAPSHOT: RatesSnapshot = {
    requestedDate: date('2026-10-07'),
    effectiveDate: date('2026-10-07'),
    carriedOver: false,
    rates: [{ code: code('USD'), name: 'US Dollar', rate: 2.6025, diff: -0.0007, nbgQuantity: 1, nbgRate: 2.6025 }],
    unknownCodes: [],
};

const HISTORY: HistorySeries = { currency: code('USD'), from: date('2026-10-01'), to: date('2026-10-07'), days: [] };

const RATE_NOT_PUBLISHED: RatesError = {
    kind: 'rate_not_published',
    date: date('2026-10-09'),
    latestEffectiveDate: date('2026-10-07'),
    today: date('2026-10-08'),
};

/** A service whose two methods answer with the given results, whatever they are asked. */
function serviceAnswering(
    snapshot: Result<RatesSnapshot, RatesError>,
    history: Result<HistorySeries, RatesError> = ok(HISTORY),
): RatesService {
    return {
        getSnapshot: () => Promise.resolve(snapshot),
        getHistory: () => Promise.resolve(history),
    };
}

function reporting(service: RatesService): { service: RatesService; reported: NbgFailure[] } {
    const reported: NbgFailure[] = [];
    return { service: reportingNbgFailures(service, (failure) => reported.push(failure)), reported };
}

function kinds(failures: ReadonlyArray<NbgFailure>): NbgFailureKind[] {
    return failures.map((failure) => failure.kind);
}

describe('nbgFailureKind', () => {
    it.each<RatesError>([
        { kind: 'upstream_unavailable', detail: 'x', cause: httpCause(503) },
        { kind: 'upstream_shape_changed', detail: 'x', cause: NBG_CAUSE.shapeJson },
    ])('counts $kind', (error) => {
        expect(nbgFailureKind(error)).toBe(error.kind);
    });

    it.each<RatesError>([
        RATE_NOT_PUBLISHED,
        { kind: 'unknown_currency', code: 'XYZ' },
        { kind: 'invalid_date', value: '2026-13-01', reason: 'month 13 does not exist' },
        { kind: 'no_data_for_date', date: date('1990-01-01'), currency: undefined },
        { kind: 'range_too_long', days: 400, max: 366 },
        { kind: 'result_out_of_range', amount: 1e300, from: code('USD'), to: code('GEL') },
        { kind: 'invalid_currency_code', value: 'dollar' },
    ])('leaves $kind uncounted', (error) => {
        expect(nbgFailureKind(error)).toBeUndefined();
    });
});

describe('asNbgFailure', () => {
    it.each<RatesError>([
        { kind: 'upstream_unavailable', detail: 'HTTP 503 after retry', cause: afterRetry(httpCause(503)) },
        { kind: 'upstream_shape_changed', detail: 'missing header', cause: NBG_CAUSE.shapeCsvHeader },
    ])('returns $kind itself', (error) => {
        expect(asNbgFailure(error)).toBe(error);
    });

    it('returns undefined for rate_not_published', () => {
        expect(asNbgFailure(RATE_NOT_PUBLISHED)).toBeUndefined();
    });
});

describe('reportingNbgFailures', () => {
    it('reports an unavailable NBG behind getSnapshot and returns the same result', async () => {
        const failed = err<RatesError>({
            kind: 'upstream_unavailable',
            detail: 'HTTP 503 after retry',
            cause: afterRetry(httpCause(503)),
        });
        const asked: unknown[] = [];
        const inner: RatesService = {
            getSnapshot: (args) => {
                asked.push(args);
                return Promise.resolve(failed);
            },
            getHistory: () => Promise.resolve(ok(HISTORY)),
        };
        const { service, reported } = reporting(inner);
        const args = { date: date('2026-10-07'), language: 'en' as const, codes: [code('USD')] };
        expect(await service.getSnapshot(args)).toBe(failed);
        expect(asked).toEqual([args]);
        expect(kinds(reported)).toEqual(['upstream_unavailable']);
    });

    it('reports a history that NBG answered in a changed shape', async () => {
        const failed = err<RatesError>({
            kind: 'upstream_shape_changed',
            detail: 'missing header',
            cause: NBG_CAUSE.shapeCsvHeader,
        });
        const { service, reported } = reporting(serviceAnswering(ok(SNAPSHOT), failed));
        const result = await service.getHistory({
            currency: code('USD'),
            from: date('2026-10-01'),
            to: date('2026-10-07'),
        });
        expect(result).toBe(failed);
        expect(kinds(reported)).toEqual(['upstream_shape_changed']);
    });

    it('reports nothing for an answer or an error that is not an NBG failure', async () => {
        const answered = reporting(serviceAnswering(ok(SNAPSHOT), ok(HISTORY)));
        await answered.service.getSnapshot({ date: date('2026-10-07'), language: 'en' });
        await answered.service.getHistory({ currency: code('USD'), from: date('2026-10-01'), to: date('2026-10-07') });
        expect(answered.reported).toEqual([]);

        const notPublished = reporting(serviceAnswering(err(RATE_NOT_PUBLISHED)));
        const result = await notPublished.service.getSnapshot({ date: date('2026-10-09'), language: 'en' });
        expect(result).toEqual(err(RATE_NOT_PUBLISHED));
        expect(notPublished.reported).toEqual([]);
    });
});
