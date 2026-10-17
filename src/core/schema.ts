import * as z from 'zod';
import { parseCalendarDate } from './dates.js';

/** A real YYYY-MM-DD calendar date, read as a CalendarDate. */
export const calendarDateSchema = z.string().transform((value, context) => {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        context.addIssue('not a real YYYY-MM-DD calendar date');
        return z.NEVER;
    }
    return parsed.value;
});

/** A failed parse's first three issues, each as `path: message` (`(root)` for an empty path), joined by `; `. */
export function formatIssues(
    issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>,
): string {
    return issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
}
