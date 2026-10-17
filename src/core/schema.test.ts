import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { calendarDateSchema, formatIssues } from './schema.js';

describe('calendarDateSchema', () => {
    it('reads a real calendar date', () => {
        expect(calendarDateSchema.safeParse('2024-02-29')).toMatchObject({ success: true, data: '2024-02-29' });
    });

    it('refuses a date that is not a real calendar date', () => {
        const parsed = calendarDateSchema.safeParse('2026-02-30');
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map((issue) => issue.message)).toEqual(['not a real YYYY-MM-DD calendar date']);
    });
});

describe('formatIssues', () => {
    it("lists a failed parse's first three issues as path: message, joined by semicolons", () => {
        const parsed = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string() }).safeParse({});
        expect(parsed.success).toBe(false);
        expect(formatIssues(parsed.error?.issues ?? [])).toBe(
            'a: Invalid input: expected string, received undefined; ' +
                'b: Invalid input: expected string, received undefined; ' +
                'c: Invalid input: expected string, received undefined',
        );
    });

    it('names an issue without a path (root)', () => {
        expect(formatIssues([{ path: [], message: 'not an object' }])).toBe('(root): not an object');
        expect(formatIssues([{ path: ['rows', 0, 'code'], message: 'bad' }])).toBe('rows.0.code: bad');
    });
});
