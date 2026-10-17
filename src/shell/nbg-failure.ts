import type { RatesError, Result } from '../core/types.js';
import type { NbgFailure, RatesService } from './rates-service.js';

export type { NbgFailure };

/**
 * Which rates errors mean NBG failed: it did not answer usably, or it answered in a shape the parser does not know.
 * Every other kind (a bad date or code, a rate not published yet, a gap in the archive) answers the user's own
 * request. The hosted server logs the counted kind a request met, so an alarm on the log can tell an outage from
 * ordinary use.
 */

export type NbgFailureKind = NbgFailure['kind'];

/** The counted kind of an error, or undefined for one that is not an NBG failure. */
export function nbgFailureKind(error: RatesError): NbgFailureKind | undefined {
    return asNbgFailure(error)?.kind;
}

/** The error itself when it is an NBG failure, or undefined. */
export function asNbgFailure(error: RatesError): NbgFailure | undefined {
    switch (error.kind) {
        case 'upstream_unavailable':
        case 'upstream_shape_changed':
            return error;
        case 'invalid_date':
        case 'range_too_long':
        case 'unknown_currency':
        case 'invalid_currency_code':
        case 'result_out_of_range':
        case 'no_data_for_date':
        case 'rate_not_published':
            return undefined;
        default: {
            const exhaustive: never = error;
            return exhaustive;
        }
    }
}

/**
 * The service, with report called once for each call whose result is an NBG failure; results pass through unchanged.
 * The client retries inside a call, so a failed first attempt followed by a successful retry reports nothing.
 */
export function reportingNbgFailures(service: RatesService, report: (kind: NbgFailureKind) => void): RatesService {
    function reportIfFailed(result: Result<unknown, RatesError>): void {
        const kind = result.ok ? undefined : nbgFailureKind(result.error);
        if (kind !== undefined) {
            report(kind);
        }
    }
    return {
        async getSnapshot(args) {
            const result = await service.getSnapshot(args);
            reportIfFailed(result);
            return result;
        },
        async getHistory(args) {
            const result = await service.getHistory(args);
            reportIfFailed(result);
            return result;
        },
    };
}
