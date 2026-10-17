import { describe, expect, it } from 'vitest';
import { createLookupScopes, newLookupScope, type LookupScopes } from './lookup-scope.js';
import type { NbgFailure } from './nbg-failure.js';

const UNAVAILABLE: NbgFailure = { kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' };
const SHAPE_CHANGED: NbgFailure = { kind: 'upstream_shape_changed', detail: 'missing header' };

/** Marks the scope the caller runs in as having stopped its past-table writes. */
function stopFillingCurrent(scopes: LookupScopes): void {
    const scope = scopes.current();
    if (scope === undefined) {
        throw new Error('no lookup scope is current');
    }
    scope.fillStopped = true;
}

describe('newLookupScope', () => {
    it('starts with no failure and filling allowed', () => {
        expect(newLookupScope()).toEqual({ failure: null, fillStopped: false });
    });
});

describe('createLookupScopes', () => {
    it('records a failure on the scope it runs in and returns what the work returns', async () => {
        const scopes = createLookupScopes();
        const scope = newLookupScope();
        const answer = await scopes.run(scope, () => {
            expect(scopes.current()).toBe(scope);
            scopes.record(UNAVAILABLE);
            return Promise.resolve('answered');
        });
        expect(answer).toBe('answered');
        expect(scope.failure).toBe(UNAVAILABLE);
        expect(scopes.current()).toBeUndefined();
    });

    it('keeps the first failure when a second one is recorded', async () => {
        const scopes = createLookupScopes();
        const scope = newLookupScope();
        await scopes.run(scope, () => {
            scopes.record(SHAPE_CHANGED);
            scopes.record(UNAVAILABLE);
            return Promise.resolve();
        });
        expect(scope.failure).toBe(SHAPE_CHANGED);
    });

    it('does nothing when a failure is recorded outside any scope', async () => {
        const scopes = createLookupScopes();
        expect(() => scopes.record(UNAVAILABLE)).not.toThrow();
        expect(scopes.current()).toBeUndefined();
        const later = newLookupScope();
        await scopes.run(later, () => Promise.resolve());
        expect(later).toEqual({ failure: null, fillStopped: false });
    });

    it('keeps two overlapping runs apart, each seeing only its own failure and fill stop', async () => {
        const scopes = createLookupScopes();
        const first = newLookupScope();
        const second = newLookupScope();
        let secondEntered: () => void = () => undefined;
        const secondInside = new Promise<void>((resolve) => {
            secondEntered = resolve;
        });
        let firstRecorded: () => void = () => undefined;
        const firstDone = new Promise<void>((resolve) => {
            firstRecorded = resolve;
        });
        await Promise.all([
            scopes.run(first, async () => {
                // Records only once the second run is inside its own scope, so the two overlap.
                await secondInside;
                scopes.record(UNAVAILABLE);
                expect(scopes.current()).toBe(first);
                firstRecorded();
            }),
            scopes.run(second, async () => {
                secondEntered();
                await firstDone;
                expect(scopes.current()).toBe(second);
                stopFillingCurrent(scopes);
                scopes.record(SHAPE_CHANGED);
            }),
        ]);
        expect(first).toEqual({ failure: UNAVAILABLE, fillStopped: false });
        expect(second).toEqual({ failure: SHAPE_CHANGED, fillStopped: true });
    });
});
