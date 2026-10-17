import { AsyncLocalStorage } from 'node:async_hooks';
import type { NbgFailure } from './nbg-failure.js';

/**
 * What one hosted /mcp request has met so far, carried through that request's own async work. Each request runs in
 * its own scope, and a lookup records on the scope of the request whose async work called it, so a failure lands on
 * that request's log line however many requests are in flight. A service that shares the scopes (the mirror) also
 * reads them: it asks NBG nothing more once the request has met a failure, and writes nothing more once fillStopped
 * is set.
 */

/** What one hosted request has met so far; mutable by design, one per request. */
export interface LookupScope {
    failure: NbgFailure | null;
    /** Set after a failed or timed-out past-table write: the request writes nothing more. */
    fillStopped: boolean;
}

export interface LookupScopes {
    run<T>(scope: LookupScope, work: () => Promise<T>): Promise<T>;
    current(): LookupScope | undefined;
    /** Records the failure on the current scope unless it holds one; outside a scope it does nothing. */
    record(failure: NbgFailure): void;
}

export function createLookupScopes(): LookupScopes {
    const storage = new AsyncLocalStorage<LookupScope>();
    return {
        run(scope, work) {
            return storage.run(scope, work);
        },
        current() {
            return storage.getStore();
        },
        record(failure) {
            const scope = storage.getStore();
            if (scope !== undefined && scope.failure === null) {
                scope.failure = failure;
            }
        },
    };
}

export function newLookupScope(): LookupScope {
    return { failure: null, fillStopped: false };
}
