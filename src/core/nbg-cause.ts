import type { NbgCause } from './types.js';

/**
 * The cause of an NBG failure, made to be logged. A cause is one fixed category and at most one value, and a value is
 * used only when it passes its rule below; one that fails is dropped, never cleaned. So a cause carries nothing from
 * the user's request, the request URL or NBG's response body: no amount, date, currency code, URL or response text.
 */

/** Four or more upper-case letters, digits and underscores, so never a three-letter currency code. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{3,63}$/;
/** Lower-case letters and spaces only, so never a URL, a date, a number or a currency code. */
const CAUSE_MESSAGE = /^[a-z][a-z ]{0,59}$/;
const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const MAX_CAUSE_LENGTH = 100;

/** The only place the NbgCause brand is asserted: every caller passes vocabulary and checked values. */
function nbgCause(text: string): NbgCause {
    return text as NbgCause;
}

export function httpCause(status: number): NbgCause {
    return nbgCause(`HTTP ${status}`);
}

/** The value a fetch error's cause names: its code, else its message, each only when it passes its rule. */
function networkValue(cause: unknown): string | undefined {
    if (typeof cause !== 'object' || cause === null) {
        return undefined;
    }
    const code: unknown = 'code' in cause ? cause.code : undefined;
    if (typeof code === 'string' && ERROR_CODE.test(code)) {
        return code;
    }
    const message: unknown = 'message' in cause ? cause.message : undefined;
    if (typeof message === 'string' && CAUSE_MESSAGE.test(message)) {
        return message;
    }
    return undefined;
}

/** A rejected request or a body that failed to read: `timeout`, or `network` with the value of the error's cause. */
export function requestErrorCause(error: unknown): NbgCause {
    if (error instanceof Error && error.name === 'TimeoutError') {
        return nbgCause('timeout');
    }
    const value = error instanceof Error ? networkValue(error.cause) : undefined;
    return nbgCause(value === undefined ? 'network' : `network ${value}`);
}

/** A 2xx answer of the wrong type: its media type without parameters, `none` without a header, else `other`. */
export function contentTypeCause(header: string | null): NbgCause {
    if (header === null || header === '') {
        return nbgCause('content-type none');
    }
    const [beforeParameters = ''] = header.split(';');
    const mediaType = beforeParameters.trim().toLowerCase();
    const named = `content-type ${mediaType}`;
    return nbgCause(MEDIA_TYPE.test(mediaType) && named.length <= MAX_CAUSE_LENGTH ? named : 'content-type other');
}

/** The cause of a request whose two attempts both ended in a retryable outcome. */
export function afterRetry(cause: NbgCause): NbgCause {
    return nbgCause(`${cause} after retry`);
}

export const NBG_CAUSE: Readonly<{
    invalidJson: NbgCause;
    shapeJson: NbgCause;
    shapeCsvHeader: NbgCause;
    shapeCsvLine: NbgCause;
    shapeTableDate: NbgCause;
    shapeAnswer: NbgCause;
}> = {
    invalidJson: nbgCause('invalid JSON'),
    shapeJson: nbgCause('shape json'),
    shapeCsvHeader: nbgCause('shape csv header'),
    shapeCsvLine: nbgCause('shape csv line'),
    shapeTableDate: nbgCause('shape table date'),
    shapeAnswer: nbgCause('shape answer'),
};
