import { describe, expect, it } from 'vitest';
import { afterRetry, contentTypeCause, httpCause, NBG_CAUSE, requestErrorCause } from './nbg-cause.js';

function fetchFailed(cause: { readonly code: string; readonly message: string }): TypeError {
    return new TypeError('fetch failed', { cause: Object.assign(new Error(cause.message), { code: cause.code }) });
}

describe('requestErrorCause', () => {
    it('names a fired request timeout', () => {
        expect(requestErrorCause(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(
            'timeout',
        );
    });

    it('uses the error code of a closed socket', () => {
        expect(requestErrorCause(fetchFailed({ code: 'UND_ERR_SOCKET', message: 'other side closed' }))).toBe(
            'network UND_ERR_SOCKET',
        );
    });

    it('uses the error code of a failed DNS lookup, not its message naming the host', () => {
        expect(requestErrorCause(fetchFailed({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND nbg.gov.ge' }))).toBe(
            'network ENOTFOUND',
        );
    });

    it('uses the cause message of a redirect loop, which has no code', () => {
        expect(requestErrorCause(new TypeError('fetch failed', { cause: new Error('redirect count exceeded') }))).toBe(
            'network redirect count exceeded',
        );
    });

    it('falls back to the cause message when the code is too short', () => {
        expect(requestErrorCause(fetchFailed({ code: 'EIO', message: 'bad port' }))).toBe('network bad port');
    });

    it('drops a code and a message that could be a currency code', () => {
        expect(requestErrorCause(fetchFailed({ code: 'USD', message: 'USD' }))).toBe('network');
    });

    it('drops messages that carry the request URL', () => {
        const error = new TypeError(
            'fetch failed https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/export/csv?currencies=USD&start=2026-10-01&end=2026-10-19',
            { cause: new Error('connect failed for https://nbg.gov.ge/...?date=2026-10-19') },
        );
        expect(requestErrorCause(error)).toBe('network');
    });

    it('names an error without a cause, and a thrown non-error, as network', () => {
        expect(requestErrorCause(new TypeError('terminated'))).toBe('network');
        expect(requestErrorCause('boom')).toBe('network');
    });
});

describe('contentTypeCause', () => {
    it('names the media type without parameters, lower-cased', () => {
        expect(contentTypeCause('text/html; charset=utf-8')).toBe('content-type text/html');
        expect(contentTypeCause('Text/HTML')).toBe('content-type text/html');
    });

    it('names a missing or empty header as none', () => {
        expect(contentTypeCause(null)).toBe('content-type none');
        expect(contentTypeCause('')).toBe('content-type none');
    });

    it('names a header outside the media type grammar, or one too long for the cause, as other', () => {
        expect(contentTypeCause('text/html <b>2026-10-19</b>')).toBe('content-type other');
        expect(contentTypeCause('a/' + 'b'.repeat(90))).toBe('content-type other');
    });
});

describe('afterRetry', () => {
    it('appends the retry suffix', () => {
        expect(afterRetry(httpCause(503))).toBe('HTTP 503 after retry');
    });
});

describe('NBG_CAUSE', () => {
    it('holds the fixed causes', () => {
        expect(Object.values(NBG_CAUSE)).toEqual([
            'invalid JSON',
            'shape json',
            'shape csv header',
            'shape csv line',
            'shape table date',
            'shape answer',
        ]);
    });
});
