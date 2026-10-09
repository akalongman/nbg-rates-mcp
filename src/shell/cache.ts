import { TBILISI_TIME_ZONE, addDays, todayIn } from '../core/dates.js';
import type { CalendarDate, Language, RatesSnapshot } from '../core/types.js';

/** How many days back NBG may still publish a table valid from a past day. */
const LATE_PUBLICATION_DAYS = 7;

export interface SnapshotCache {
    get(language: Language, requestedDate: CalendarDate, now: Date): RatesSnapshot | undefined;
    set(language: Language, requestedDate: CalendarDate, snapshot: RatesSnapshot, now: Date): void;
    readonly size: number;
}

interface Entry {
    readonly snapshot: RatesSnapshot;
    readonly expiresAt: number;
}

/**
 * A final entry (a rate that can no longer change) is kept for twelve hours, not forever: nothing proves NBG never
 * corrects a published rate, and a client left running for days would otherwise keep a superseded value.
 */
export function createSnapshotCache(
    options: { maxEntries?: number; provisionalTtlMs?: number; finalTtlMs?: number; timeZone?: string } = {},
): SnapshotCache {
    const maxEntries = options.maxEntries ?? 2000;
    const provisionalTtlMs = options.provisionalTtlMs ?? 10 * 60 * 1000;
    const finalTtlMs = options.finalTtlMs ?? 12 * 60 * 60 * 1000;
    const timeZone = options.timeZone ?? TBILISI_TIME_ZONE;
    const entries = new Map<string, Entry>();

    function key(language: Language, requestedDate: CalendarDate): string {
        return `${language}:${requestedDate}`;
    }

    function isExpired(entry: Entry, now: Date): boolean {
        return now.getTime() > entry.expiresAt;
    }

    /**
     * A carried-over answer is provisional while NBG can still publish a table for that day: on Monday 2026-09-28 at
     * 17:01 it published the table valid from Saturday 2026-09-26, replacing Friday's rate for 09-26 to 09-28. The
     * longest such delay in the archive is three days, so a week covers it.
     */
    function isFinal(requestedDate: CalendarDate, snapshot: RatesSnapshot, now: Date): boolean {
        if (!snapshot.carriedOver) {
            return true;
        }
        return requestedDate < addDays(todayIn(timeZone, now), -LATE_PUBLICATION_DAYS);
    }

    return {
        get(language, requestedDate, now) {
            const entry = entries.get(key(language, requestedDate));
            if (entry === undefined) {
                return undefined;
            }
            if (isExpired(entry, now)) {
                entries.delete(key(language, requestedDate));
                return undefined;
            }
            return entry.snapshot;
        },
        set(language, requestedDate, snapshot, now) {
            const entryKey = key(language, requestedDate);
            const existing = entries.get(entryKey);
            const existingIsLive = existing !== undefined && !isExpired(existing, now);
            if (existingIsLive && existing.snapshot.effectiveDate > snapshot.effectiveDate) {
                // Two requests straddling a publication can finish out of order; the older table must not win.
                return;
            }
            const expiresAt = now.getTime() + (isFinal(requestedDate, snapshot, now) ? finalTtlMs : provisionalTtlMs);
            entries.delete(entryKey);
            entries.set(entryKey, { snapshot, expiresAt });
            while (entries.size > maxEntries) {
                const oldest = entries.keys().next().value;
                if (oldest === undefined) {
                    break;
                }
                entries.delete(oldest);
            }
        },
        get size() {
            return entries.size;
        },
    };
}
