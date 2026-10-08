import { describe, expect, it } from 'vitest';
import { date } from '../../test/helpers/values.js';
import type { RatesSnapshot } from '../core/types.js';
import { createSnapshotCache } from './cache.js';

function snapshot(requested: string, effective: string): RatesSnapshot {
    return {
        requestedDate: date(requested),
        effectiveDate: date(effective),
        carriedOver: effective < requested,
        rates: [],
        unknownCodes: [],
    };
}

// 2026-10-08 10:00 in Tbilisi (UTC+4)
const NOW = new Date('2026-10-08T06:00:00Z');
const TEN_MINUTES = 10 * 60 * 1000;
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

describe('createSnapshotCache', () => {
    it('keeps a past carried-over snapshot (a 2024 Sunday) for 12 hours, then asks NBG again', () => {
        const cache = createSnapshotCache({ provisionalTtlMs: 1000 });
        cache.set('en', date('2024-06-02'), snapshot('2024-06-02', '2024-06-01'), NOW);
        expect(cache.get('en', date('2024-06-02'), new Date(NOW.getTime() + TWELVE_HOURS - 1))).toBeDefined();
        expect(cache.get('en', date('2024-06-02'), new Date(NOW.getTime() + TWELVE_HOURS + 1))).toBeUndefined();
    });

    it('keeps a published snapshot for today for 12 hours, not forever', () => {
        const cache = createSnapshotCache({ provisionalTtlMs: 1000 });
        cache.set('en', date('2026-10-08'), snapshot('2026-10-08', '2026-10-08'), NOW);
        expect(cache.get('en', date('2026-10-08'), new Date(NOW.getTime() + TWELVE_HOURS - 1))).toBeDefined();
        expect(cache.get('en', date('2026-10-08'), new Date(NOW.getTime() + TWELVE_HOURS + 1))).toBeUndefined();
    });

    it('expires a carried-over snapshot for tomorrow after the provisional TTL', () => {
        const cache = createSnapshotCache({ provisionalTtlMs: 1000 });
        cache.set('en', date('2026-10-09'), snapshot('2026-10-09', '2026-10-08'), NOW);
        expect(cache.get('en', date('2026-10-09'), new Date(NOW.getTime() + 999))).toBeDefined();
        expect(cache.get('en', date('2026-10-09'), new Date(NOW.getTime() + 1001))).toBeUndefined();
    });

    it('keeps a provisional entry for ten minutes by default', () => {
        const cache = createSnapshotCache();
        cache.set('en', date('2026-10-09'), snapshot('2026-10-09', '2026-10-08'), NOW);
        expect(cache.get('en', date('2026-10-09'), new Date(NOW.getTime() + TEN_MINUTES - 1))).toBeDefined();
        expect(cache.get('en', date('2026-10-09'), new Date(NOW.getTime() + TEN_MINUTES + 1))).toBeUndefined();
    });

    it('treats a carried-over snapshot for today as provisional (NBG may still publish late)', () => {
        const cache = createSnapshotCache({ provisionalTtlMs: 1000 });
        cache.set('en', date('2026-10-08'), snapshot('2026-10-08', '2026-10-07'), NOW);
        expect(cache.get('en', date('2026-10-08'), new Date(NOW.getTime() + 1001))).toBeUndefined();
    });

    it('keeps a newer table when a slower, older answer for the same date arrives later', () => {
        const cache = createSnapshotCache();
        cache.set('en', date('2026-10-08'), snapshot('2026-10-08', '2026-10-08'), NOW);
        cache.set('en', date('2026-10-08'), snapshot('2026-10-08', '2026-10-07'), NOW);
        expect(cache.get('en', date('2026-10-08'), NOW)?.effectiveDate).toBe('2026-10-08');
    });

    it('separates languages', () => {
        const cache = createSnapshotCache();
        cache.set('en', date('2026-10-07'), snapshot('2026-10-07', '2026-10-07'), NOW);
        expect(cache.get('ka', date('2026-10-07'), NOW)).toBeUndefined();
    });

    it('evicts the oldest entry beyond maxEntries', () => {
        const cache = createSnapshotCache({ maxEntries: 2 });
        cache.set('en', date('2026-01-01'), snapshot('2026-01-01', '2026-01-01'), NOW);
        cache.set('en', date('2026-01-02'), snapshot('2026-01-02', '2026-01-02'), NOW);
        cache.set('en', date('2026-01-03'), snapshot('2026-01-03', '2026-01-03'), NOW);
        expect(cache.size).toBe(2);
        expect(cache.get('en', date('2026-01-01'), NOW)).toBeUndefined();
        expect(cache.get('en', date('2026-01-03'), NOW)).toBeDefined();
    });
});
