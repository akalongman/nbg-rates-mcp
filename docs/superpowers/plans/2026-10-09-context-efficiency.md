# nbg-rates-mcp 0.2.0 Context Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 0.2.0 with server instructions, a compact `nbg_rate_history` output and display identity fields, so the server costs a client less context and is found when a question needs it.

**Architecture:** All changes sit at the MCP boundary in `src/shell/`. `src/core/` stays untouched: `assembleHistory` keeps producing full `HistoryPoint`s, and a new pure module `src/shell/history-output.ts` turns them into the compact wire form. Instructions and identity are constants passed to the `McpServer` constructor.

**Tech Stack:** TypeScript 6.0, Node 22+, ESM, `@modelcontextprotocol/server` 2.3 and `@modelcontextprotocol/client` 2.3, Zod 4, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-09-context-efficiency-design.md` (amends `docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md`).

## Global Constraints

- Instructions text, exactly: `Official exchange rates of the Georgian lari (GEL) set by the National Bank of Georgia (NBG). Use these tools for any question about GEL rates, converting to or from GEL, or historical NBG rates on a date or over a range. Dates are Tbilisi calendar days; quote effectiveDate when carriedOver is true.` Under 400 characters.
- History day shape, keys in this order: own rate in force `{ date, rate }`; carried over `{ date, rate, effectiveDate, carriedOver: true }`. `carriedOver` never appears as `false`; an absent `effectiveDate` means the rate took effect on `date`.
- `src/core/**` does not change. The `content` text block holds the same JSON as `structuredContent`. The 366-day cap stays.
- A synthetic 366-day series, five plain and two carried-over days per week, eight-decimal rate, serialises to at most 21,000 characters.
- Identity: `title` `NBG Rates (National Bank of Georgia)`, `description` `GEL exchange rates from the National Bank of Georgia with per-unit values. Not affiliated with NBG.`, `websiteUrl` `https://github.com/akalongman/nbg-rates-mcp`; equal to `server.json`; `name` and `version` unchanged; no icons.
- Version 0.2.0 in `package.json`, `package-lock.json`, both fields of `server.json`, `manifest.json`; `CHANGELOG.md` section `## 0.2.0 - <YYYY-MM-DD>`.
- Repository rules: ESM with `.js` import extensions; strict tsconfig; 4-space indent, 120 columns, single quotes; no `any`, no `!`, `as` only at validated boundaries; prose agent-neutral, no em or en dashes.
- Commit with explicit paths in one command: `git add <paths> && git commit -m "<title>" -- <paths>`. Commits are signed by the repository's configured ssh signing; never bypass it. Commit on `main`; never push (the publish section is run by the driver with the user's go).
- Gates for every task: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`.

## Review Focus

1. A client that validates schemas strictly (Claude Code drops a tool whose schema it cannot read): the history `outputSchema` must be plain JSON Schema with `carriedOver` as `{ "type": "boolean", "const": true }` and only `date` and `rate` required. Pinned in Task 2, Step 1.
2. The text block drifting from `structuredContent` for the compact shape (clients that read only `content` would see a different answer). Pinned in Task 2, Step 6.
3. A carried run longer than a weekend (the New Year gap): every carried day names the publication actually in force, not the previous calendar day. Pinned in Task 2, Step 1.
4. Instructions growing past the point where clients truncate or skim them, or losing their opening statement of purpose. Pinned in Task 1, Step 1.
5. The identity in the binary drifting from `server.json`, which the MCP registry shows. Pinned in Task 1, Step 1.

---

### Task 1: Server instructions and display identity

**Files:**
- Modify: `src/shell/server.ts` (constants above `createServer`; constructor at the `new McpServer(` line)
- Modify: `src/shell/server.test.ts` (imports; two tests in `describe('createServer'`)
- Modify: `test/e2e/stdio.test.ts` (imports; one test)
- Modify: `docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md` (end of the "Tool contracts" introduction)

**Interfaces:**
- Consumes: `createServer(deps: ServerDeps): McpServer` and the test helper `connectedClient()` in `src/shell/server.test.ts`; client accessors `getInstructions(): string | undefined` and `getServerVersion(): Implementation | undefined` from `@modelcontextprotocol/client`.
- Produces: `export const SERVER_INSTRUCTIONS: string` in `src/shell/server.ts`.

- [ ] **Step 1: Write the failing server tests**

In `src/shell/server.test.ts`, add to the imports:

```ts
import { readFileSync } from 'node:fs';
import * as z from 'zod';
```

Add inside `describe('createServer', () => {`, after the test `registers the four nbg_ tools and the rates resource`:

```ts
    it('sends the instructions, short and leading with what the server is for', async () => {
        const client = await connectedClient();

        const instructions = client.getInstructions();
        expect(instructions).toBe(
            'Official exchange rates of the Georgian lari (GEL) set by the National Bank of Georgia (NBG). ' +
                'Use these tools for any question about GEL rates, converting to or from GEL, or historical NBG rates ' +
                'on a date or over a range. Dates are Tbilisi calendar days; quote effectiveDate when carriedOver is true.',
        );
        expect(instructions?.length).toBeLessThan(400);

        await client.close();
    });

    it('identifies itself with the title, description and website of server.json', async () => {
        const client = await connectedClient();
        const registryEntry = z
            .object({ title: z.string(), description: z.string(), websiteUrl: z.string() })
            .parse(JSON.parse(readFileSync(new URL('../../server.json', import.meta.url), 'utf8')));

        expect(client.getServerVersion()).toEqual({
            name: 'nbg-rates-mcp',
            version: '0.0.0-test',
            title: registryEntry.title,
            description: registryEntry.description,
            websiteUrl: registryEntry.websiteUrl,
        });

        await client.close();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/shell/server.test.ts`
Expected: the two new tests FAIL (`getInstructions()` returns `undefined`; `getServerVersion()` lacks `title`, `description`, `websiteUrl`).

- [ ] **Step 3: Implement the constants and the constructor change**

In `src/shell/server.ts`, add above `export function createServer`:

```ts
/** Sent once per session; a client that loads tools on demand reads it to decide when this server is relevant. */
export const SERVER_INSTRUCTIONS =
    'Official exchange rates of the Georgian lari (GEL) set by the National Bank of Georgia (NBG). ' +
    'Use these tools for any question about GEL rates, converting to or from GEL, or historical NBG rates ' +
    'on a date or over a range. Dates are Tbilisi calendar days; quote effectiveDate when carriedOver is true.';

/** Display fields of the server identity; a test keeps them equal to server.json. */
const SERVER_IDENTITY = {
    title: 'NBG Rates (National Bank of Georgia)',
    description: 'GEL exchange rates from the National Bank of Georgia with per-unit values. Not affiliated with NBG.',
    websiteUrl: 'https://github.com/akalongman/nbg-rates-mcp',
} as const;
```

Replace

```ts
    const server = new McpServer({ name: 'nbg-rates-mcp', version: deps.version });
```

with

```ts
    const server = new McpServer(
        { name: 'nbg-rates-mcp', version: deps.version, ...SERVER_IDENTITY },
        { instructions: SERVER_INSTRUCTIONS },
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/shell/server.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Add the end-to-end check over stdio**

In `test/e2e/stdio.test.ts`, add to the imports:

```ts
import { SERVER_INSTRUCTIONS } from '../../src/shell/server.js';
```

Add after the test `lists the tools`:

```ts
    it('sends the instructions and the display identity', () => {
        expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
        expect(client.getServerVersion()).toMatchObject({
            name: 'nbg-rates-mcp',
            version,
            title: 'NBG Rates (National Bank of Georgia)',
            description: 'GEL exchange rates from the National Bank of Georgia with per-unit values. Not affiliated with NBG.',
            websiteUrl: 'https://github.com/akalongman/nbg-rates-mcp',
        });
    });
```

Run: `npm run test:e2e`
Expected: PASS (12 tests).

- [ ] **Step 6: Amend the main spec**

In `docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md`, replace

```
itself. `language` affects only the `name` field; codes, numbers and dates
are identical in `en` and `ka`.
```

with

```
itself. `language` affects only the `name` field; codes, numbers and dates
are identical in `en` and `ka`.

The server sends instructions and display identity fields (`title`,
`description`, `websiteUrl`) to every client; their exact values, and the
rule that the identity fields equal `server.json`, are in
`2026-10-09-context-efficiency-design.md`.
```

- [ ] **Step 7: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: all pass.

```bash
git add src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md && git commit -m "Send server instructions and display identity" -- src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md
```

### Task 2: Compact `nbg_rate_history` output

**Files:**
- Create: `src/shell/history-output.ts`, `src/shell/history-output.test.ts`
- Modify: `src/shell/tool-schemas.ts` (`rateHistoryOutput`)
- Modify: `src/shell/server.ts` (import; `nbg_rate_history` description and return)
- Modify: `src/shell/server.test.ts` (one test)
- Modify: `test/e2e/stdio.test.ts` (test `returns one history point per calendar day from a single CSV request`)
- Modify: `README.md` (`nbg_rate_history` output), `docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md` (history output and cap rationale)

**Interfaces:**
- Consumes: `HistoryPoint` and `HistorySeries` from `src/core/types.ts` (`HistoryPoint` is `{ date: CalendarDate; effectiveDate: CalendarDate; rate: number; carriedOver: boolean }`); `addDays(date: CalendarDate, days: number): CalendarDate` from `src/core/dates.ts`; test helpers `date()` and `code()` from `test/helpers/values.ts`.
- Produces: `historyOutput(series: HistorySeries): HistoryOutput` and `historyDayOutput(point: HistoryPoint): HistoryDayOutput` in `src/shell/history-output.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/shell/history-output.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { code, date } from '../../test/helpers/values.js';
import { addDays } from '../core/dates.js';
import type { CalendarDate, HistoryPoint } from '../core/types.js';
import { historyOutput } from './history-output.js';

function point(day: string, effective: string, rate: number): HistoryPoint {
    return { date: date(day), effectiveDate: date(effective), rate, carriedOver: effective < day };
}

describe('historyOutput', () => {
    it('keeps date and rate on days with their own rate and adds the source on carried-over days', () => {
        // USD 2026-10-02 (Friday) to 2026-10-06 (Tuesday), as NBG published it: Saturday has its own table.
        const output = historyOutput({
            currency: code('USD'),
            from: date('2026-10-02'),
            to: date('2026-10-06'),
            days: [
                point('2026-10-02', '2026-10-02', 2.6042),
                point('2026-10-03', '2026-10-03', 2.6039),
                point('2026-10-04', '2026-10-03', 2.6039),
                point('2026-10-05', '2026-10-03', 2.6039),
                point('2026-10-06', '2026-10-06', 2.6032),
            ],
        });

        expect(JSON.stringify(output)).toBe(
            '{"currency":"USD","from":"2026-10-02","to":"2026-10-06","days":[' +
                '{"date":"2026-10-02","rate":2.6042},' +
                '{"date":"2026-10-03","rate":2.6039},' +
                '{"date":"2026-10-04","rate":2.6039,"effectiveDate":"2026-10-03","carriedOver":true},' +
                '{"date":"2026-10-05","rate":2.6039,"effectiveDate":"2026-10-03","carriedOver":true},' +
                '{"date":"2026-10-06","rate":2.6032}]}',
        );
    });

    it('names the publication in force on every day of a carried run longer than a weekend', () => {
        const output = historyOutput({
            currency: code('USD'),
            from: date('2025-12-31'),
            to: date('2026-01-03'),
            days: [
                point('2025-12-31', '2025-12-31', 2.7),
                point('2026-01-01', '2025-12-31', 2.7),
                point('2026-01-02', '2025-12-31', 2.7),
                point('2026-01-03', '2025-12-31', 2.7),
            ],
        });

        expect(output.days.map((day) => ('effectiveDate' in day ? day.effectiveDate : day.date))).toEqual([
            '2025-12-31',
            '2025-12-31',
            '2025-12-31',
            '2025-12-31',
        ]);
    });

    it('keeps a full year of an eight-decimal rate under 21,000 characters', () => {
        // Five days with their own rate, then two carried-over days, every week; 0.00012345 is a rate quoted per 10000.
        const first = date('2025-10-06');
        const days: HistoryPoint[] = [];
        let effective: CalendarDate = first;
        for (let index = 0; index < 366; index += 1) {
            const day = addDays(first, index);
            const carried = index % 7 >= 5;
            if (!carried) {
                effective = day;
            }
            days.push({ date: day, effectiveDate: effective, rate: 0.00012345, carriedOver: carried });
        }

        const text = JSON.stringify(historyOutput({ currency: code('XAU'), from: first, to: addDays(first, 365), days }));

        expect(days.filter((day) => day.carriedOver)).toHaveLength(104);
        expect(text).not.toContain('"carriedOver":false');
        expect(text.length).toBeLessThanOrEqual(21_000);
    });
});
```

`XAU` is used only as a well-formed three-letter code; the size, not the currency, is under test.

In `src/shell/server.test.ts`, add inside `describe('createServer', () => {`:

```ts
    it('declares the compact history day: date and rate required, carriedOver only as the constant true', async () => {
        const client = await connectedClient();
        const { tools } = await client.listTools();
        const history = tools.find((tool) => tool.name === 'nbg_rate_history');

        const daySchema = z
            .object({
                properties: z.object({
                    days: z.object({
                        items: z.object({ properties: z.record(z.string(), z.unknown()), required: z.array(z.string()) }),
                    }),
                }),
            })
            .parse(history?.outputSchema).properties.days.items;
        expect([...daySchema.required].sort()).toEqual(['date', 'rate']);
        expect(daySchema.properties['carriedOver']).toMatchObject({ type: 'boolean', const: true });
        expect(daySchema.properties['effectiveDate']).toMatchObject({ type: 'string' });
        expect(history?.description).toContain(
            'Days whose own rate is in force carry only date and rate; a carried-over day adds effectiveDate and ' +
                'carriedOver: true.',
        );

        await client.close();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/shell/history-output.test.ts src/shell/server.test.ts`
Expected: FAIL. `history-output.test.ts` cannot import `./history-output.js`; the new server test finds `effectiveDate` and `carriedOver` in `required` and no `const`.

- [ ] **Step 3: Create the mapper**

Create `src/shell/history-output.ts`:

```ts
import type { CalendarDate, CurrencyCode, HistoryPoint, HistorySeries } from '../core/types.js';

/** A day whose own publication is in force carries date and rate; a carried-over day adds where its rate came from. */
export type HistoryDayOutput =
    | { readonly date: CalendarDate; readonly rate: number }
    | {
          readonly date: CalendarDate;
          readonly rate: number;
          readonly effectiveDate: CalendarDate;
          readonly carriedOver: true;
      };

// A type alias, not an interface: the server's result helper needs a type assignable to Record<string, unknown>.
export type HistoryOutput = {
    readonly currency: CurrencyCode;
    readonly from: CalendarDate;
    readonly to: CalendarDate;
    readonly days: ReadonlyArray<HistoryDayOutput>;
};

export function historyDayOutput(point: HistoryPoint): HistoryDayOutput {
    return point.carriedOver
        ? { date: point.date, rate: point.rate, effectiveDate: point.effectiveDate, carriedOver: true }
        : { date: point.date, rate: point.rate };
}

/** The wire form of nbg_rate_history: about 40% smaller than full points, so a year stays near 6,000 tokens. */
export function historyOutput(series: HistorySeries): HistoryOutput {
    return { currency: series.currency, from: series.from, to: series.to, days: series.days.map(historyDayOutput) };
}
```

- [ ] **Step 4: Change the output schema**

In `src/shell/tool-schemas.ts`, replace the whole `rateHistoryOutput` declaration with:

```ts
export const rateHistoryOutput = z.object({
    currency: z.string(),
    from: z.string(),
    to: z.string(),
    days: z.array(
        z.object({
            date: z.string(),
            rate: z.number().describe('GEL per ONE unit of the currency'),
            effectiveDate: z
                .string()
                .describe('Present only on carried-over days: the calendar date the rate took effect')
                .optional(),
            carriedOver: z
                .literal(true)
                .describe('Present, and true, only on days that carry a rate set earlier')
                .optional(),
        }),
    ),
});
```

- [ ] **Step 5: Use the mapper and describe the shape in the tool**

In `src/shell/server.ts`, add to the imports:

```ts
import { historyOutput } from './history-output.js';
```

In the `nbg_rate_history` registration, replace the `description:` value with:

```ts
            description:
                'Official NBG rate of one currency (GEL per one unit) in force on every calendar day of an inclusive range ' +
                'of at most 366 days. Dates are calendar days in Tbilisi. Days without a rate of their own (Sundays, ' +
                'Mondays and days after a public holiday; before September 2021 NBG set a rate for every calendar day) ' +
                'carry the earlier rate. Days whose own rate is in force carry only date and rate; a carried-over day ' +
                'adds effectiveDate and carriedOver: true. Quote effectiveDate when carriedOver is true. A range reaching ' +
                'a date NBG has not published yet returns an error. One NBG request per call.',
```

Replace

```ts
            return success({ ...history.value, days: history.value.days.map((point) => ({ ...point })) });
```

with

```ts
            return success(historyOutput(history.value));
```

Run: `npx vitest run --project unit src/shell/history-output.test.ts src/shell/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Update the end-to-end history test**

In `test/e2e/stdio.test.ts` (it already imports `* as z from 'zod'`), in the test `returns one history point per calendar day from a single CSV request`, replace

```ts
        const output = rateHistoryOutput.parse(result.structuredContent);
        expect(output.days).toHaveLength(7);
```

with

```ts
        const output = rateHistoryOutput.parse(result.structuredContent);
        expect(output.days).toHaveLength(7);
        const [block] = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(result.content);
        expect(JSON.parse(block?.text ?? '')).toEqual(result.structuredContent);
        const saturday = output.days.find((point) => point.date === '2026-10-03');
        const sunday = output.days.find((point) => point.date === '2026-10-04');
        expect(Object.keys(saturday ?? {})).toEqual(['date', 'rate']);
        expect(Object.keys(sunday ?? {})).toEqual(['date', 'rate', 'effectiveDate', 'carriedOver']);
        expect(sunday?.effectiveDate).toBe('2026-10-03');
```

The existing lines after it (the carried-over dates filter and the single CSV request URL) stay unchanged; `point.carriedOver` is `undefined` on plain days, so the filter still yields `['2026-10-04', '2026-10-05']`.

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 7: Update the README and the main spec**

In `README.md`, replace

```
- `days`: one entry per calendar day with `date`, `effectiveDate`, `rate` (GEL per one unit) and `carriedOver`, with the same meaning as in `nbg_get_rates`.
```

with

````
- `days`: one entry per calendar day. A day whose own rate is in force is `{ date, rate }`, with `rate` in GEL per one unit. A carried-over day adds `effectiveDate`, the day its rate took effect, and `carriedOver: true`; an absent `effectiveDate` means the rate took effect on `date` itself. A full year stays near 6,000 tokens.

For example, USD from Friday 2026-10-02 to Tuesday 2026-10-06 (Saturday has its own rate; Sunday and Monday carry it):

```json
{
  "currency": "USD",
  "from": "2026-10-02",
  "to": "2026-10-06",
  "days": [
    { "date": "2026-10-02", "rate": 2.6042 },
    { "date": "2026-10-03", "rate": 2.6039 },
    { "date": "2026-10-04", "rate": 2.6039, "effectiveDate": "2026-10-03", "carriedOver": true },
    { "date": "2026-10-05", "rate": 2.6039, "effectiveDate": "2026-10-03", "carriedOver": true },
    { "date": "2026-10-06", "rate": 2.6032 }
  ]
}
```
````

Then run `npx prettier --write README.md` and keep whatever layout Prettier settles on.

In `docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md`, replace

```
Output: `currency`, `from`, `to`, `days`: one entry per calendar day in
order, `{ date, effectiveDate, rate, carriedOver }`. Every calendar day is
included, carried-over days with `carriedOver` true, because the rate
```

with

```
Output: `currency`, `from`, `to`, `days`: one entry per calendar day in
order. A day whose own publication is in force is `{ date, rate }`; a
carried-over day is `{ date, rate, effectiveDate, carriedOver: true }`
(since 0.2.0, see `2026-10-09-context-efficiency-design.md`). Every
calendar day is included, because the rate
```

and replace

```
The range is capped at 366 days per call, because each day costs about 35
tokens of model context, not because of upstream cost.
```

with

```
The range is capped at 366 days per call, so that a full year stays near
6,000 tokens of model context, under the 10,000-token warning of Claude
Code; the cap is not about upstream cost.
```

- [ ] **Step 8: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: all pass.

```bash
git add src/shell/history-output.ts src/shell/history-output.test.ts src/shell/tool-schemas.ts src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts README.md docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md && git commit -m "Return compact days from nbg_rate_history" -- src/shell/history-output.ts src/shell/history-output.test.ts src/shell/tool-schemas.ts src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts README.md docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md
```

### Task 3: Prepare release 0.2.0

**Files:**
- Modify: `package.json`, `package-lock.json`, `server.json` (two `version` fields), `manifest.json`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `scripts/check-release.ts <version>` (checks every version field, a dated `## <version> - YYYY-MM-DD` CHANGELOG heading, and npm 11.5.1 or later).
- Produces: a tree whose release check passes for `0.2.0`.

- [ ] **Step 1: Bump the versions**

Run: `npm version 0.2.0 --no-git-tag-version`
Expected: prints `v0.2.0`; `package.json` and `package-lock.json` now say `0.2.0`.

In `server.json`, change both `"version": "0.1.0"` lines to `"version": "0.2.0"` (the top-level field and the one inside `packages[0]`). In `manifest.json`, change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 2: Add the CHANGELOG section**

Get the date: `TZ=Asia/Tbilisi date +%F`. In `CHANGELOG.md`, insert above the line `## 0.1.0 - 2026-10-09`, with that date in place of `<date>`:

```
## 0.2.0 - <date>

Breaking: `nbg_rate_history` days are now `{ date, rate }` when the day's own rate is in force; only carried-over days add `effectiveDate` and `carriedOver: true`. A full year of history is about 40% smaller.

Added: server instructions, so clients that load tools on demand know when to use this server; `title`, `description` and `websiteUrl` in the server identity.

```

- [ ] **Step 3: Run the release check**

The local npm may be older than 11.5.1, so run the check through npm 11:

```bash
shim=$(mktemp -d) && printf '#!/usr/bin/env bash\nexec npx -y npm@11.21.0 "$@"\n' > "$shim/npm" && chmod +x "$shim/npm" && PATH="$shim:$PATH" npx tsx scripts/check-release.ts 0.2.0; echo "exit $?"; rm -rf "$shim"
```

Expected: `exit 0` and nothing else printed.

- [ ] **Step 4: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e && npm pack --dry-run`
Expected: all pass; the pack listing has 18 files, `nbg-rates-mcp@0.2.0`.

```bash
git add package.json package-lock.json server.json manifest.json CHANGELOG.md && git commit -m "Release 0.2.0" -- package.json package-lock.json server.json manifest.json CHANGELOG.md
```

## After the tasks: publish (driver only, with the user's go)

1. `git log --format='%h %G? %s' origin/main..HEAD` lists the spec commit, this plan's commit and the three task commits, all `G`. Push `main` only if nothing else is ahead, then watch CI on the pushed head to green.
2. `git tag -s v0.2.0 -m "v0.2.0" <head> && git push origin v0.2.0`, then watch `release.yml` to the end.
3. Verify from outside, reading fresh: `npm view nbg-rates-mcp dist-tags.latest --prefer-online` is `0.2.0`; `curl -s https://registry.npmjs.org/-/npm/v1/attestations/nbg-rates-mcp@0.2.0 | jq '[.attestations[].predicateType]'` lists a provenance predicate; `gh release view v0.2.0` has the `.mcpb` asset and only the 0.2.0 notes; the MCP registry API lists `io.github.akalongman/nbg-rates` 0.2.0 as `active`.
