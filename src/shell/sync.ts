import { claimRun, type MirrorState } from '../core/mirror.js';
import { isWindowMinute, MAX_EVENT_AGE_MS, type SyncKind } from '../core/sync-schedule.js';
import type { Result } from '../core/types.js';
import { STORE_OPERATION_TIMEOUT_MS, type MirrorStore } from './mirror-store.js';
import type { NbgClient } from './nbg-client.js';
import { runDailyRefetch, runRecheckSlice, type StepOutcome } from './sync-archive.js';
import { runHourlyCheck, runWindowCheck, stoppedWindowDate, type CheckOutcome } from './sync-check.js';
import { createSyncContext, type SyncContext, type SyncFailure } from './sync-publication.js';

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

function skipped(reason: 'late' | 'early' | 'outside_window' | 'window_stopped' | 'duplicate'): RunOutcome {
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

/** Each kind's check, from the state as the run claimed it. */
const CHECKS: Readonly<
    Record<SyncKind, (context: SyncContext, state: MirrorState) => Promise<Result<CheckOutcome, SyncFailure>>>
> = { hourly: runHourlyCheck, window: runWindowCheck };

type Step = (context: SyncContext, state: MirrorState) => Promise<Result<StepOutcome, SyncFailure>>;

/** Each kind's steps after its check, in order, each from the state as the run claimed it. */
const STEPS: Readonly<Record<SyncKind, ReadonlyArray<Step>>> = {
    hourly: [runDailyRefetch, runRecheckSlice],
    window: [],
};

/**
 * The kind's check, then its later steps. A failed check fails the run, and a check that failed or met the deadline
 * runs no step. Otherwise each step runs in order, whatever an earlier one returned, until one meets the deadline: an
 * unresolved date NBG withdrew from both views fails every retry, and only a re-check slice can clear it, so a failure
 * must not starve the later steps. The run fails with the first failure in step order (the check's retry of
 * unresolved dates, then each step), and is otherwise ok, with 'deadline' when the check or a step met it; `checked` is
 * as the check left it.
 */
async function runKind(kind: SyncKind, context: SyncContext, state: MirrorState): Promise<RunOutcome> {
    const check = await CHECKS[kind](context, state);
    if (!check.ok) {
        return failed(check.error.kind);
    }
    const { checked, deadline, retryFailure } = check.value;
    const failures: SyncFailure[] = retryFailure === undefined ? [] : [retryFailure];
    let stopped = deadline;
    for (const step of STEPS[kind]) {
        if (stopped) {
            break;
        }
        const outcome = await step(context, state);
        if (!outcome.ok) {
            failures.push(outcome.error);
        } else if (outcome.value === 'deadline') {
            stopped = true;
        }
    }
    const [failure] = failures;
    if (failure !== undefined) {
        return { result: 'failed', detail: failure.kind, checked };
    }
    return { result: 'ok', detail: stopped ? 'deadline' : null, checked };
}

/**
 * One scheduled sync run. An event not shown to be at most MAX_EVENT_AGE_MS old (an invalid scheduled time included)
 * is skipped as late, and one scheduled more than MAX_EVENT_AGE_MS ahead of now as early, with no store call: the
 * claim, the fresh-until time and the span only move forward, so a future time must never reach them. A window event
 * not on a window minute is skipped as outside_window, with no store call either. Then the state is read, a window
 * event on the Tbilisi date whose window is stopped is skipped as window_stopped with no write, the run is claimed (a
 * lost claim is a duplicate), and the kind's check and later steps done (runKind). Writes the run's log line and
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
    if (event.kind === 'window' && !isWindowMinute(event.scheduledTime)) {
        return finish(skipped('outside_window'));
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
    if (event.kind === 'window' && stoppedWindowDate(read.value) === context.today) {
        return finish(skipped('window_stopped'), context);
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
    return finish(await runKind(event.kind, context, claim.value), context);
}
