import { claimRun, type MirrorState } from '../core/mirror.js';
import { MAX_EVENT_AGE_MS, type SyncKind } from '../core/sync-schedule.js';
import { STORE_OPERATION_TIMEOUT_MS, type MirrorStore } from './mirror-store.js';
import type { NbgClient } from './nbg-client.js';
import { runHourlyCheck } from './sync-check.js';
import { createSyncContext, type SyncContext } from './sync-publication.js';

export interface SyncEvent {
    readonly kind: SyncKind;
    readonly scheduledTime: Date;
}

export interface SyncLogLine {
    readonly time: string;
    readonly syncRun: SyncKind;
    readonly scheduledTime: string;
    readonly syncResult: 'ok' | 'skipped' | 'failed';
    /** The failure kind, the skip reason, 'deadline', or null. */
    readonly syncDetail: string | null;
    /** True when this run recorded a fresh-until time, or found a later one a newer run had recorded. */
    readonly checked: boolean;
    readonly committed: number;
    readonly nbgRequests: number;
    /** 'start..end', or null without a span. */
    readonly span: string | null;
    readonly durationMs: number;
}

export interface SyncDeps {
    readonly store: MirrorStore;
    readonly client: NbgClient;
    readonly now: () => Date;
    readonly sleep: (ms: number) => Promise<void>;
    readonly log: (line: SyncLogLine) => void;
}

interface RunOutcome {
    readonly result: SyncLogLine['syncResult'];
    readonly detail: string | null;
    readonly checked: boolean;
}

function skipped(reason: 'late' | 'early' | 'duplicate' | 'not_built'): RunOutcome {
    return { result: 'skipped', detail: reason, checked: false };
}

function failed(kind: string): RunOutcome {
    return { result: 'failed', detail: kind, checked: false };
}

/** toISOString throws a RangeError on an invalid Date, which a malformed event can carry. */
function printed(instant: Date): string {
    return Number.isFinite(instant.getTime()) ? instant.toISOString() : String(instant);
}

function spanText(state: MirrorState | undefined): string | null {
    const span = state?.span;
    return span === undefined ? null : `${span.start}..${span.end}`;
}

export function notConfiguredLine(event: SyncEvent, now: Date): SyncLogLine {
    return {
        time: printed(now),
        syncRun: event.kind,
        scheduledTime: printed(event.scheduledTime),
        syncResult: 'failed',
        syncDetail: 'mirror_not_configured',
        checked: false,
        committed: 0,
        nbgRequests: 0,
        span: null,
        durationMs: 0,
    };
}

/** The store, with each state the run reads or writes handed to `seen`, so the log line can name the span. */
function watchedStore(store: MirrorStore, seen: (state: MirrorState) => void): MirrorStore {
    return {
        async readState(signal) {
            const read = await store.readState(signal);
            if (read.ok) {
                seen(read.value);
            }
            return read;
        },
        readRowsInForce: (date, signal) => store.readRowsInForce(date, signal),
        readTable: (validFrom, language, signal) => store.readTable(validFrom, language, signal),
        readRowsBetween: (start, end, signal) => store.readRowsBetween(start, end, signal),
        readTablesBetween: (start, end, signal) => store.readTablesBetween(start, end, signal),
        fillPastTable: (validFrom, language, day, signal) => store.fillPastTable(validFrom, language, day, signal),
        async updateState(change, signal) {
            // The last attempt's result is the state the store holds when the update succeeds.
            const last: { state: MirrorState | undefined } = { state: undefined };
            const updated = await store.updateState(async (state) => {
                const applied = await change(state);
                last.state = applied.next ?? state;
                return applied;
            }, signal);
            if (updated.ok && last.state !== undefined) {
                seen(last.state);
            }
            return updated;
        },
        commitPublication: (publication, signal) => store.commitPublication(publication, signal),
        removePublication: (validFrom, observedAt, signal) => store.removePublication(validFrom, observedAt, signal),
        writeArchiveRows: (items, signal) => store.writeArchiveRows(items, signal),
        replaceArchivePublication: (validFrom, rows, observedAt, signal) =>
            store.replaceArchivePublication(validFrom, rows, observedAt, signal),
    };
}

/**
 * The hourly kind's steps in order; a failed check ends the run before any later step. A failure while retrying
 * unresolved dates after a successful check fails the run too, with `checked` as the check left it.
 */
async function runHourly(context: SyncContext, state: MirrorState): Promise<RunOutcome> {
    const check = await runHourlyCheck(context, state);
    if (!check.ok) {
        return failed(check.error.kind);
    }
    const { checked, deadline, retryFailure } = check.value;
    if (retryFailure !== undefined) {
        return { result: 'failed', detail: retryFailure.kind, checked };
    }
    if (deadline) {
        return { result: 'ok', detail: 'deadline', checked };
    }
    return { result: 'ok', detail: null, checked };
}

/**
 * One scheduled sync run. An event not shown to be at most MAX_EVENT_AGE_MS old (an invalid scheduled time included)
 * is skipped as late, and one scheduled more than MAX_EVENT_AGE_MS ahead of now as early, with no store call: the
 * claim, the fresh-until time and the span only move forward, so a future time must never reach them. Then the state
 * is read, the run claimed (a lost claim is a duplicate), and the kind's work done. Writes the run's log line and
 * returns it.
 */
export async function runSync(event: SyncEvent, remainingMs: () => number, deps: SyncDeps): Promise<SyncLogLine> {
    const startedAt = deps.now();
    const seen: { state: MirrorState | undefined } = { state: undefined };

    function finish(outcome: RunOutcome, context?: SyncContext): SyncLogLine {
        const now = deps.now();
        const line: SyncLogLine = {
            time: printed(now),
            syncRun: event.kind,
            scheduledTime: printed(event.scheduledTime),
            syncResult: outcome.result,
            syncDetail: outcome.detail,
            checked: outcome.checked,
            committed: context?.counts.committed ?? 0,
            nbgRequests: context?.counts.nbgRequests ?? 0,
            span: spanText(seen.state),
            durationMs: now.getTime() - startedAt.getTime(),
        };
        deps.log(line);
        return line;
    }

    // Written so NaN fails it: a non-finite time never reaches claimRun, which would store it as null.
    const age = startedAt.getTime() - event.scheduledTime.getTime();
    if (!(age <= MAX_EVENT_AGE_MS)) {
        return finish(skipped('late'));
    }
    if (age < -MAX_EVENT_AGE_MS) {
        return finish(skipped('early'));
    }
    switch (event.kind) {
        case 'window':
            return finish(skipped('not_built'));
        case 'hourly':
            break;
        default: {
            const exhaustive: never = event.kind;
            return exhaustive;
        }
    }
    const store = watchedStore(deps.store, (state) => {
        seen.state = state;
    });
    const context = createSyncContext({
        store,
        client: deps.client,
        now: deps.now,
        sleep: deps.sleep,
        scheduledAt: event.scheduledTime,
        remainingMs,
    });
    const read = await store.readState(context.signal());
    if (!read.ok) {
        return finish(failed(read.error.kind), context);
    }
    if (!context.allows(STORE_OPERATION_TIMEOUT_MS)) {
        return finish({ result: 'ok', detail: 'deadline', checked: false }, context);
    }
    const scheduledAt = event.scheduledTime.getTime();
    const claim = await store.updateState((state) => {
        const claimed = claimRun(state, event.kind, scheduledAt);
        return { next: claimed, outcome: claimed };
    }, context.signal());
    if (!claim.ok) {
        return finish(failed(claim.error.kind), context);
    }
    if (claim.value === undefined) {
        return finish(skipped('duplicate'), context);
    }
    return finish(await runHourly(context, claim.value), context);
}
