import { describe, expect, it } from 'vitest';
import { date } from '../../test/helpers/values.js';
import { afterRetry, httpCause } from '../core/nbg-cause.js';
import type { RatesError } from '../core/types.js';
import { syncNbgFailure } from './sync-publication.js';

describe('syncNbgFailure', () => {
    it('counts an answer with no table as a shape NBG should not answer with', () => {
        expect(syncNbgFailure({ kind: 'no_data_for_date', date: date('2026-10-07'), currency: undefined })).toEqual({
            kind: 'upstream_shape_changed',
            detail: 'NBG answered no_data_for_date',
            cause: 'shape answer',
        });
    });

    it('passes an NBG failure through with its own cause', () => {
        const outage: RatesError = {
            kind: 'upstream_unavailable',
            detail: 'HTTP 503 after retry',
            cause: afterRetry(httpCause(503)),
        };
        expect(syncNbgFailure(outage)).toEqual(outage);
    });
});
