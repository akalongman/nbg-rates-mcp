# nbg-rates-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `nbg-rates-mcp` 0.1.0: a stdio MCP server on npm that returns official National Bank of Georgia (NBG) exchange rates with per-unit values, Tbilisi date semantics and an explicit fallback flag.

**Architecture:** A pure `src/core/` (types, NBG schema, normalisation, dates, conversion, history assembly) tested on recorded fixtures with no network, and an effectful `src/shell/` (HTTP client, cache, rates service, MCP server wiring, binary) tested against a local fixture HTTP server. One end-to-end test drives the built binary over stdio. A weekly live contract test is the only thing that touches nbg.gov.ge in CI.

**Tech Stack:** TypeScript 5.9, Node 22+, ESM, `@modelcontextprotocol/server` 2.3 and `@modelcontextprotocol/client` 2.3 (tests), Zod 4, Vitest 4, fast-check 4, typescript-eslint 8, Prettier 3, tsx, GitHub Actions, `mcp-publisher`, `@anthropic-ai/mcpb`.

**Spec:** `docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md`

One naming deviation from the spec: the fan-out logic the spec calls `history-fetcher.ts` lives in `src/shell/rates-service.ts` together with the single-date path, because both share the client, cache and clock, and a separate `src/shell/concurrency.ts` holds the generic concurrency helper. Everything else matches the spec's layout.

## Global Constraints

- Node `>=22` in `engines`; CI runs Node 22 and 24. Node 20 is end of life and unsupported.
- ESM only (`"type": "module"`), imports inside `src/` use explicit `.js` extensions (NodeNext resolution).
- tsconfig: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `verbatimModuleSyntax`.
- Style: 4-space indent, 120 columns, single quotes, `===` only, `const` by default, no `var`, no TypeScript `enum`, no `any`, no `!` non-null assertions, `as` only at validated boundaries (JSON parse, branding constructors).
- `src/core/**` never imports `src/shell/**`, never uses `fetch`, `Date.now()`, `console`, or mutable module state. ESLint enforces the import ban.
- Tool names: `nbg_get_rates`, `nbg_convert`, `nbg_list_currencies`, `nbg_rate_history`. Resource template: `nbg://rates/{date}`.
- All rates are per one unit of the currency in GEL. `rate` and `diff` are `nbgRate / nbgQuantity` rounded to `4 + log10(nbgQuantity)` decimals.
- Calendar dates are `YYYY-MM-DD` strings. A calendar date is taken from an NBG timestamp as its first ten characters, never through a `Date` object.
- "Today" is the calendar date in `Asia/Tbilisi`.
- History range cap: 366 days inclusive. Concurrency cap against NBG: 6.
- HTTP: 10 s timeout, one retry after 500 ms on network error, HTTP 429 or 5xx, `User-Agent: nbg-rates-mcp/<version> (+https://github.com/akalongman/nbg-rates-mcp)`.
- Cache: keyed by language and requested date; final when requested date is before today in Tbilisi, or when `isFallback` is false; otherwise ten minutes. Max 2000 entries.
- stdout is the protocol channel. All logging goes to stderr. `NBG_RATES_DEBUG=1` enables upstream request logging. `NBG_RATES_BASE_URL` overrides `https://nbg.gov.ge`.
- Commit messages: short imperative title, no attribution trailers. Commit with explicit paths: `git add <paths> && git commit -m "<title>" -- <paths>`.
- Prose in the repo (README, comments, docs) is agent-neutral and uses no em or en dashes.

## Review Focus

1. A request for a date far in the future (`2099-01-01`): NBG returns today's table; the result must carry `isFallback: true` with today's `effectiveDate`, never claim a 2099 rate. Pinned in Task 4 (`normalize`) and Task 10 (end to end).
2. A `nbg_rate_history` range that spans a month boundary and a weekend (`2026-09-28` to `2026-10-05`): every calendar day present, in order, weekend days flagged, no duplicates. Pinned in Task 2 (`enumerateDays`) and Task 9 (history over the fixture week).
3. A currency code with surrounding whitespace or lower case (`" usd "`): accepted and normalised to `USD`, not reported unknown. Pinned in Task 2.
4. An NBG response where one row has `quantity: 0` or a non-integer quantity: rejected as `upstream_shape_changed`, never a division by zero producing `Infinity`. Pinned in Task 3.
5. The process started with `TZ=America/Los_Angeles` at 23:30 local on a Monday: "today" is already Tuesday in Tbilisi, and a snapshot timestamp `2026-10-08T00:00:00.000Z` yields `2026-10-08`, not `2026-10-07`. Pinned in Task 2 and Task 10.

## File map

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `.prettierrc`, `.editorconfig`, `vitest.config.ts`, `.gitignore`, `LICENSE` | Project scaffold (Task 1) |
| `src/core/types.ts` | Branded types, records, `Result`, error union |
| `src/core/currency-code.ts` | `parseCurrencyCode`, `GEL` |
| `src/core/dates.ts` | Calendar-date parsing, Tbilisi today, enumeration, range cap |
| `src/core/nbg-schema.ts` | Zod schema of the NBG response, `parseNbgResponse` |
| `src/core/normalize.ts` | `normalizeSnapshot`, `selectCurrencies`, `perUnit` |
| `src/core/convert.ts` | `convertAmount` |
| `src/core/history.ts` | `assembleHistory` |
| `src/shell/nbg-client.ts` | `createNbgClient` (fetch, timeout, retry, user agent, debug log) |
| `src/shell/cache.ts` | `createSnapshotCache` |
| `src/shell/concurrency.ts` | `mapWithConcurrency` |
| `src/shell/rates-service.ts` | `createRatesService`: snapshot and history over client plus cache |
| `src/shell/tool-schemas.ts` | Zod input and output schemas for the four tools |
| `src/shell/server.ts` | `createServer`, `describeError` |
| `src/bin.ts` | Executable entry |
| `scripts/record-fixtures.ts` | Records real NBG responses into `test/fixtures/` |
| `test/fixtures/*.json` | Recorded responses |
| `test/helpers/fixture-server.ts` | Local `node:http` server serving fixtures with fault injection |
| `test/e2e/stdio.test.ts` | Spawns `dist/bin.js` through the MCP client |
| `test/contract/nbg-live.test.ts` | Live test, opt-in with `NBG_LIVE=1` |
| `.github/workflows/ci.yml`, `contract.yml`, `release.yml`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/bug_report.md` | CI and release |
| `server.json`, `manifest.json`, `.mcpbignore`, `README.md`, `CHANGELOG.md` | Publishing and docs |

---

### Task 1: Project scaffold and CI skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `.prettierrc`, `.editorconfig`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `src/core/smoke.test.ts` (deleted again in Task 2), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: npm scripts `build`, `typecheck`, `lint`, `format`, `test`, `test:e2e`, `test:contract`, `record-fixtures` that every later task runs.

- [ ] **Step 1: Create `package.json`**

```json
{
    "name": "nbg-rates-mcp",
    "version": "0.1.0",
    "description": "Official National Bank of Georgia (NBG) GEL exchange rates for AI agents, with correct per-unit values and date semantics",
    "keywords": ["nbg", "national-bank-of-georgia", "georgia", "gel", "lari", "exchange-rates", "currency", "mcp", "mcp-server"],
    "license": "MIT",
    "author": "Avtandil Kikabidze",
    "repository": {
        "type": "git",
        "url": "git+https://github.com/akalongman/nbg-rates-mcp.git"
    },
    "homepage": "https://github.com/akalongman/nbg-rates-mcp#readme",
    "bugs": "https://github.com/akalongman/nbg-rates-mcp/issues",
    "mcpName": "io.github.akalongman/nbg-rates",
    "type": "module",
    "bin": {
        "nbg-rates-mcp": "dist/bin.js"
    },
    "files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
    "engines": {
        "node": ">=22"
    },
    "scripts": {
        "build": "tsc -p tsconfig.build.json",
        "typecheck": "tsc -p tsconfig.json --noEmit",
        "lint": "eslint .",
        "format": "prettier --write .",
        "format:check": "prettier --check .",
        "test": "vitest run --exclude test/e2e --exclude test/contract",
        "test:e2e": "npm run build && vitest run test/e2e",
        "test:contract": "NBG_LIVE=1 vitest run test/contract",
        "record-fixtures": "tsx scripts/record-fixtures.ts",
        "prepublishOnly": "npm run build"
    },
    "dependencies": {
        "@modelcontextprotocol/server": "^2.3.1",
        "zod": "^4.2.0"
    },
    "devDependencies": {
        "@modelcontextprotocol/client": "^2.3.1",
        "@types/node": "^26.6.4",
        "eslint": "^10.0.0",
        "fast-check": "^4.10.2",
        "prettier": "^3.9.9",
        "tsx": "^4.23.15",
        "typescript": "^5.9.0",
        "typescript-eslint": "^8.71.1",
        "vitest": "^4.0.0"
    }
}
```

If `npm install` reports that `eslint@^10` does not exist yet, use `^9.0.0`; typescript-eslint 8 supports both. If `vitest@^4` is unavailable, use `^3.2.0` and adjust nothing else.

- [ ] **Step 2: Create `tsconfig.json` and `tsconfig.build.json`**

`tsconfig.json` (used for typecheck, lint and tests; includes test files):

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "lib": ["ES2022"],
        "types": ["node"],
        "strict": true,
        "noUncheckedIndexedAccess": true,
        "noUnusedLocals": true,
        "noUnusedParameters": true,
        "exactOptionalPropertyTypes": true,
        "noFallthroughCasesInSwitch": true,
        "forceConsistentCasingInFileNames": true,
        "verbatimModuleSyntax": true,
        "isolatedModules": true,
        "skipLibCheck": true,
        "outDir": "dist",
        "rootDir": "."
    },
    "include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "vitest.config.ts"]
}
```

`tsconfig.build.json` (emits only `src/`):

```json
{
    "extends": "./tsconfig.json",
    "compilerOptions": {
        "rootDir": "src",
        "declaration": false,
        "sourceMap": false
    },
    "include": ["src/**/*.ts"],
    "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create `eslint.config.js`, `.prettierrc`, `.editorconfig`, `vitest.config.ts`, `.gitignore`**

`eslint.config.js`:

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**', '*.mcpb', 'bundle/**'] },
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-non-null-assertion': 'error',
            eqeqeq: ['error', 'always'],
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
    {
        files: ['src/core/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [{ group: ['**/shell/**', 'node:*'], message: 'core is pure: no shell, no Node built-ins' }],
                },
            ],
            'no-console': 'error',
        },
    },
    {
        files: ['eslint.config.js'],
        extends: [tseslint.configs.disableTypeChecked],
    },
);
```

`.prettierrc`:

```json
{
    "singleQuote": true,
    "printWidth": 120,
    "tabWidth": 4,
    "trailingComma": "all"
}
```

`.editorconfig`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 4
trim_trailing_whitespace = true

[*.{yml,yaml,md}]
indent_size = 2
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        environment: 'node',
        testTimeout: 15_000,
    },
});
```

`.gitignore`:

```
node_modules/
dist/
bundle/
*.mcpb
*.tgz
.DS_Store
```

- [ ] **Step 4: Create `LICENSE`**

MIT text with `Copyright (c) 2026 Avtandil Kikabidze` as the first line after the title.

- [ ] **Step 5: Install and write a smoke test that proves the toolchain**

Run: `npm install`

Create `src/core/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
    it('runs a test', () => {
        expect(1 + 1).toBe(2);
    });
});
```

- [ ] **Step 6: Run every script once**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: all pass. If `format:check` fails, run `npm run format` and re-run.

- [ ] **Step 7: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run format:check
      - run: npm test
      - run: npm run test:e2e
```

The `test:e2e` step fails until Task 10 lands the binary and the e2e test. That is expected; CI is red for the project until then, and green CI on `main` is a Task 10 exit criterion. Do not delete the step.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json eslint.config.js .prettierrc .editorconfig vitest.config.ts .gitignore LICENSE src/core/smoke.test.ts .github/workflows/ci.yml
git commit -m "Scaffold the TypeScript project and CI" -- package.json package-lock.json tsconfig.json tsconfig.build.json eslint.config.js .prettierrc .editorconfig vitest.config.ts .gitignore LICENSE src/core/smoke.test.ts .github/workflows/ci.yml
```

- [ ] **Step 9: Create the GitHub repository and push**

Run: `gh repo create akalongman/nbg-rates-mcp --public --source . --remote origin --push --description "Official National Bank of Georgia (NBG) GEL exchange rates for AI agents (MCP server)"`
Expected: repository created, `main` pushed. Verify with `gh repo view akalongman/nbg-rates-mcp --json url -q .url`.


### Task 2: Core types, currency codes and calendar dates

**Files:**
- Create: `src/core/types.ts`, `src/core/currency-code.ts`, `src/core/currency-code.test.ts`, `src/core/dates.ts`, `src/core/dates.test.ts`
- Delete: `src/core/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - `type CurrencyCode`, `type CalendarDate` (branded strings), `type Language = 'en' | 'ka'`
  - `type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`, helpers `ok(value)`, `err(error)`
  - `type RatesError` (six variants, see code)
  - `RateEntry`, `RatesSnapshot`, `Conversion`, `HistoryPoint`, `HistorySeries`
  - `parseCurrencyCode(input: string): Result<CurrencyCode, RatesError>`, `const GEL: CurrencyCode`
  - `TBILISI_TIME_ZONE`, `MAX_HISTORY_DAYS`, `parseCalendarDate(input: string): Result<CalendarDate, RatesError>`, `calendarDateFromTimestamp(timestamp: string): CalendarDate`, `todayIn(timeZone: string, now: Date): CalendarDate`, `addDays(date: CalendarDate, days: number): CalendarDate`, `enumerateDays(from: CalendarDate, to: CalendarDate): Result<ReadonlyArray<CalendarDate>, RatesError>`

- [ ] **Step 1: Write `src/core/types.ts`** (types only, no tests needed)

```ts
export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };
export type CalendarDate = string & { readonly __brand: 'CalendarDate' };
export type Language = 'en' | 'ka';

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
    return { ok: true, value };
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
    return { ok: false, error };
}

export type RatesError =
    | { readonly kind: 'invalid_date'; readonly value: string; readonly reason: string }
    | { readonly kind: 'range_too_long'; readonly days: number; readonly max: number }
    | { readonly kind: 'unknown_currency'; readonly code: string }
    | { readonly kind: 'no_data_for_date'; readonly date: CalendarDate }
    | { readonly kind: 'upstream_unavailable'; readonly detail: string }
    | { readonly kind: 'upstream_shape_changed'; readonly detail: string };

export interface RateEntry {
    readonly code: CurrencyCode;
    readonly name: string;
    readonly rate: number;
    readonly diff: number;
    readonly nbgQuantity: number;
    readonly nbgRate: number;
}

export interface RatesSnapshot {
    readonly requestedDate: CalendarDate;
    readonly effectiveDate: CalendarDate;
    readonly isFallback: boolean;
    readonly publishedAt: string;
    readonly rates: ReadonlyArray<RateEntry>;
    readonly unknownCodes: ReadonlyArray<string>;
}

export interface Conversion {
    readonly amount: number;
    readonly from: CurrencyCode;
    readonly to: CurrencyCode;
    readonly result: number;
    readonly rate: number;
    readonly via: 'direct' | 'GEL';
    readonly requestedDate: CalendarDate;
    readonly effectiveDate: CalendarDate;
    readonly isFallback: boolean;
}

export interface HistoryPoint {
    readonly date: CalendarDate;
    readonly effectiveDate: CalendarDate;
    readonly rate: number;
    readonly diff: number;
    readonly isFallback: boolean;
}

export interface HistorySeries {
    readonly currency: CurrencyCode;
    readonly from: CalendarDate;
    readonly to: CalendarDate;
    readonly days: ReadonlyArray<HistoryPoint>;
}
```

- [ ] **Step 2: Write the failing currency-code test `src/core/currency-code.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { GEL, parseCurrencyCode } from './currency-code.js';

describe('parseCurrencyCode', () => {
    it('accepts an upper-case ISO code', () => {
        const result = parseCurrencyCode('USD');
        expect(result).toEqual({ ok: true, value: 'USD' });
    });

    it('normalises case and surrounding whitespace', () => {
        expect(parseCurrencyCode(' usd ')).toEqual({ ok: true, value: 'USD' });
    });

    it('rejects anything that is not three letters', () => {
        for (const input of ['US', 'USDD', 'U$D', '', '123']) {
            const result = parseCurrencyCode(input);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toEqual({ kind: 'unknown_currency', code: input });
            }
        }
    });

    it('exports GEL as a branded code', () => {
        expect(GEL).toBe('GEL');
    });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/core/currency-code.test.ts`
Expected: FAIL, cannot find module `./currency-code.js`.

- [ ] **Step 4: Write `src/core/currency-code.ts`**

```ts
import { err, ok, type CurrencyCode, type RatesError, type Result } from './types.js';

const CODE_PATTERN = /^[A-Z]{3}$/;

export const GEL = 'GEL' as CurrencyCode;

export function parseCurrencyCode(input: string): Result<CurrencyCode, RatesError> {
    const normalised = input.trim().toUpperCase();
    if (!CODE_PATTERN.test(normalised)) {
        return err({ kind: 'unknown_currency', code: input });
    }
    return ok(normalised as CurrencyCode);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/core/currency-code.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the failing dates test `src/core/dates.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
    MAX_HISTORY_DAYS,
    TBILISI_TIME_ZONE,
    addDays,
    calendarDateFromTimestamp,
    enumerateDays,
    parseCalendarDate,
    todayIn,
} from './dates.js';
import type { CalendarDate } from './types.js';

function date(value: string): CalendarDate {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        throw new Error(`test fixture date is invalid: ${value}`);
    }
    return parsed.value;
}

describe('parseCalendarDate', () => {
    it('accepts real calendar dates', () => {
        expect(parseCalendarDate('2026-10-08')).toEqual({ ok: true, value: '2026-10-08' });
        expect(parseCalendarDate('2024-02-29')).toEqual({ ok: true, value: '2024-02-29' });
    });

    it('rejects impossible dates that NBG would silently accept', () => {
        for (const value of ['2026-02-30', '2026-13-01', '2023-02-29', '2026-00-10', '2026-10-32']) {
            const result = parseCalendarDate(value);
            expect(result.ok, value).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe('invalid_date');
            }
        }
    });

    it('rejects anything that is not YYYY-MM-DD', () => {
        for (const value of ['bad', '2026-1-5', '08.10.2026', '2026-10-08T00:00:00Z', '']) {
            expect(parseCalendarDate(value).ok, value).toBe(false);
        }
    });
});

describe('calendarDateFromTimestamp', () => {
    it('takes the first ten characters and ignores the process time zone', () => {
        expect(calendarDateFromTimestamp('2026-10-08T00:00:00.000Z')).toBe('2026-10-08');
        expect(calendarDateFromTimestamp('2026-10-07T17:01:12.447Z')).toBe('2026-10-07');
    });

    it('throws on a malformed timestamp (programmer error: schema should have caught it)', () => {
        expect(() => calendarDateFromTimestamp('nope')).toThrow();
    });
});

describe('todayIn', () => {
    it('is already tomorrow in Tbilisi when it is late evening in UTC', () => {
        const now = new Date('2026-10-07T21:30:00Z');
        expect(todayIn(TBILISI_TIME_ZONE, now)).toBe('2026-10-08');
        expect(todayIn('UTC', now)).toBe('2026-10-07');
    });

    it('is still today in Tbilisi just before 20:00 UTC', () => {
        expect(todayIn(TBILISI_TIME_ZONE, new Date('2026-10-07T19:59:59Z'))).toBe('2026-10-07');
    });
});

describe('addDays', () => {
    it('crosses month and year boundaries', () => {
        expect(addDays(date('2026-01-31'), 1)).toBe('2026-02-01');
        expect(addDays(date('2026-12-31'), 1)).toBe('2027-01-01');
        expect(addDays(date('2024-03-01'), -1)).toBe('2024-02-29');
    });
});

describe('enumerateDays', () => {
    it('includes both ends, in order, across a month boundary and a weekend', () => {
        const result = enumerateDays(date('2026-09-28'), date('2026-10-05'));
        expect(result).toEqual({
            ok: true,
            value: [
                '2026-09-28',
                '2026-09-29',
                '2026-09-30',
                '2026-10-01',
                '2026-10-02',
                '2026-10-03',
                '2026-10-04',
                '2026-10-05',
            ],
        });
    });

    it('accepts a single-day range', () => {
        expect(enumerateDays(date('2026-10-05'), date('2026-10-05'))).toEqual({ ok: true, value: ['2026-10-05'] });
    });

    it('rejects from after to', () => {
        const result = enumerateDays(date('2026-10-06'), date('2026-10-05'));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_date');
        }
    });

    it('accepts exactly 366 days and rejects 367', () => {
        const from = date('2024-01-01');
        expect(enumerateDays(from, addDays(from, MAX_HISTORY_DAYS - 1)).ok).toBe(true);
        const tooLong = enumerateDays(from, addDays(from, MAX_HISTORY_DAYS));
        expect(tooLong).toEqual({ ok: false, error: { kind: 'range_too_long', days: 367, max: 366 } });
    });

    it('property: any valid range yields to - from + 1 unique ordered days', () => {
        fc.assert(
            fc.property(
                fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z') }),
                fc.integer({ min: 0, max: MAX_HISTORY_DAYS - 1 }),
                (start, length) => {
                    const from = calendarDateFromTimestamp(start.toISOString());
                    const to = addDays(from, length);
                    const result = enumerateDays(from, to);
                    if (!result.ok) {
                        return false;
                    }
                    const days = result.value;
                    const sorted = [...days].sort();
                    return (
                        days.length === length + 1 &&
                        new Set(days).size === days.length &&
                        days.every((day, index) => day === sorted[index])
                    );
                },
            ),
        );
    });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/core/dates.test.ts`
Expected: FAIL, cannot find module `./dates.js`.

- [ ] **Step 8: Write `src/core/dates.ts`**

```ts
import { err, ok, type CalendarDate, type RatesError, type Result } from './types.js';

export const TBILISI_TIME_ZONE = 'Asia/Tbilisi';
export const MAX_HISTORY_DAYS = 366;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(year: number, month: number, day: number): boolean {
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return (
        candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day
    );
}

export function parseCalendarDate(input: string): Result<CalendarDate, RatesError> {
    const match = DATE_PATTERN.exec(input);
    if (match === null) {
        return err({ kind: 'invalid_date', value: input, reason: 'expected YYYY-MM-DD' });
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isRealDate(year, month, day)) {
        return err({ kind: 'invalid_date', value: input, reason: 'not a real calendar date' });
    }
    return ok(input as CalendarDate);
}

/** Takes the calendar date out of an NBG timestamp without going through a Date object. */
export function calendarDateFromTimestamp(timestamp: string): CalendarDate {
    const parsed = parseCalendarDate(timestamp.slice(0, 10));
    if (!parsed.ok) {
        throw new Error(`not a timestamp: ${timestamp}`);
    }
    return parsed.value;
}

export function todayIn(timeZone: string, now: Date): CalendarDate {
    // en-CA formats as YYYY-MM-DD; Intl does the zone arithmetic.
    const formatted = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
    return calendarDateFromTimestamp(formatted);
}

function toUtcMillis(date: CalendarDate): number {
    const [year, month, day] = date.split('-').map(Number);
    return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
    const shifted = new Date(toUtcMillis(date) + days * 86_400_000);
    return calendarDateFromTimestamp(shifted.toISOString());
}

export function enumerateDays(from: CalendarDate, to: CalendarDate): Result<ReadonlyArray<CalendarDate>, RatesError> {
    if (from > to) {
        return err({ kind: 'invalid_date', value: `${from}..${to}`, reason: 'from is after to' });
    }
    const days = Math.round((toUtcMillis(to) - toUtcMillis(from)) / 86_400_000) + 1;
    if (days > MAX_HISTORY_DAYS) {
        return err({ kind: 'range_too_long', days, max: MAX_HISTORY_DAYS });
    }
    const result: CalendarDate[] = [];
    for (let offset = 0; offset < days; offset += 1) {
        result.push(addDays(from, offset));
    }
    return ok(result);
}
```

String comparison of `YYYY-MM-DD` values is chronological, which is why `from > to` works without parsing.

- [ ] **Step 9: Run the tests, lint and typecheck**

Run: `rm src/core/smoke.test.ts && npx vitest run src/core && npm run lint && npm run typecheck`
Expected: all PASS. Also run once with `TZ=America/Los_Angeles npx vitest run src/core/dates.test.ts` and expect PASS; this is Review Focus item 5.

- [ ] **Step 10: Commit**

```bash
git add src/core/types.ts src/core/currency-code.ts src/core/currency-code.test.ts src/core/dates.ts src/core/dates.test.ts
git add -u src/core/smoke.test.ts
git commit -m "Add core types, currency codes and calendar dates" -- src/core/types.ts src/core/currency-code.ts src/core/currency-code.test.ts src/core/dates.ts src/core/dates.test.ts src/core/smoke.test.ts
```


### Task 3: NBG response schema and recorded fixtures

**Files:**
- Create: `src/core/nbg-schema.ts`, `src/core/nbg-schema.test.ts`, `scripts/record-fixtures.ts`, `test/fixtures/*.json`, `test/helpers/fixtures.ts`

**Interfaces:**
- Consumes: `Result`, `ok`, `err`, `RatesError` from Task 2.
- Produces:
  - `type NbgCurrencyRow = { code: string; quantity: number; rate: number; diff: number; name: string; date: string; validFromDate?: string }` (plus unknown extra keys)
  - `type NbgDay = { date: string; currencies: ReadonlyArray<NbgCurrencyRow> }`
  - `parseNbgResponse(json: unknown): Result<ReadonlyArray<NbgDay>, RatesError>` (empty array is a valid, empty result)
  - `test/helpers/fixtures.ts`: `loadFixture(name: string): unknown`, `fixturePath(name: string): string`; fixture names are `<language>-<date>.json`
  - Recorded fixtures: `en-2026-10-01` through `en-2026-10-07`, `ka-2026-10-07`, `en-2005-03-15`, `en-1995-01-01`

- [ ] **Step 1: Write `scripts/record-fixtures.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env['NBG_RATES_BASE_URL'] ?? 'https://nbg.gov.ge';
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

const RECORDINGS: ReadonlyArray<{ language: 'en' | 'ka'; date: string }> = [
    { language: 'en', date: '2026-10-01' },
    { language: 'en', date: '2026-10-02' },
    { language: 'en', date: '2026-10-03' },
    { language: 'en', date: '2026-10-04' },
    { language: 'en', date: '2026-10-05' },
    { language: 'en', date: '2026-10-06' },
    { language: 'en', date: '2026-10-07' },
    { language: 'ka', date: '2026-10-07' },
    { language: 'en', date: '2005-03-15' },
    { language: 'en', date: '1995-01-01' },
];

async function record({ language, date }: { language: 'en' | 'ka'; date: string }): Promise<void> {
    const url = `${BASE_URL}/gw/api/ct/monetarypolicy/currencies/${language}/json?date=${date}`;
    const response = await fetch(url, { headers: { 'user-agent': 'nbg-rates-mcp fixture recorder' } });
    if (!response.ok) {
        throw new Error(`${url} -> HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    const target = join(FIXTURE_DIR, `${language}-${date}.json`);
    await writeFile(target, `${JSON.stringify(body, null, 4)}\n`);
    console.error(`recorded ${target}`);
}

async function main(): Promise<void> {
    await mkdir(FIXTURE_DIR, { recursive: true });
    for (const recording of RECORDINGS) {
        await record(recording);
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
```

- [ ] **Step 2: Record the fixtures**

Run: `npm run record-fixtures && ls test/fixtures && head -c 300 test/fixtures/en-2026-10-04.json && cat test/fixtures/en-1995-01-01.json`
Expected: ten files. `en-2026-10-04.json` (a Sunday) shows `"date": "2026-10-03T00:00:00.000Z"`, the Saturday table. `en-1995-01-01.json` is `[]`. `en-2005-03-15.json` rows have no `validFromDate` key.

If NBG is unreachable, stop and report; the fixtures are the ground truth for every later test and must be real.

- [ ] **Step 3: Write `test/helpers/fixtures.ts`**

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixturePath(name: string): string {
    return join(FIXTURE_DIR, `${name}.json`);
}

export function loadFixture(name: string): unknown {
    return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as unknown;
}
```

- [ ] **Step 4: Write the failing schema test `src/core/nbg-schema.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/helpers/fixtures.js';
import { parseNbgResponse } from './nbg-schema.js';

describe('parseNbgResponse', () => {
    it('parses a current weekday table', () => {
        const result = parseNbgResponse(loadFixture('en-2026-10-07'));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toHaveLength(1);
            const day = result.value[0];
            expect(day?.date).toBe('2026-10-07T00:00:00.000Z');
            expect(day?.currencies.length).toBeGreaterThan(30);
            const usd = day?.currencies.find((row) => row.code === 'USD');
            expect(usd?.quantity).toBe(1);
            expect(usd?.validFromDate).toBe('2026-10-07T00:00:00.000Z');
        }
    });

    it('parses a 2005 table whose rows have no validFromDate', () => {
        const result = parseNbgResponse(loadFixture('en-2005-03-15'));
        expect(result.ok).toBe(true);
        if (result.ok) {
            const usd = result.value[0]?.currencies.find((row) => row.code === 'USD');
            expect(usd).toBeDefined();
            expect(usd?.validFromDate).toBeUndefined();
        }
    });

    it('parses an empty archive answer as an empty list', () => {
        expect(parseNbgResponse(loadFixture('en-1995-01-01'))).toEqual({ ok: true, value: [] });
    });

    it('tolerates extra fields NBG may add', () => {
        const result = parseNbgResponse([
            {
                date: '2026-10-07T00:00:00.000Z',
                extra: true,
                currencies: [
                    { code: 'USD', quantity: 1, rate: 2.6, diff: 0, name: 'US Dollar', date: '2026-10-06T17:01:00Z', newField: 1 },
                ],
            },
        ]);
        expect(result.ok).toBe(true);
    });

    it('rejects a zero or fractional quantity as a shape change, never as a rate', () => {
        for (const quantity of [0, 0.5, -10]) {
            const result = parseNbgResponse([
                {
                    date: '2026-10-07T00:00:00.000Z',
                    currencies: [{ code: 'USD', quantity, rate: 2.6, diff: 0, name: 'US Dollar', date: '2026-10-06T17:01:00Z' }],
                },
            ]);
            expect(result.ok, String(quantity)).toBe(false);
            if (!result.ok) {
                expect(result.error.kind).toBe('upstream_shape_changed');
            }
        }
    });

    it('rejects a renamed field with a detail naming the path', () => {
        const result = parseNbgResponse([{ date: '2026-10-07T00:00:00.000Z', items: [] }]);
        expect(result.ok).toBe(false);
        if (!result.ok && result.error.kind === 'upstream_shape_changed') {
            expect(result.error.detail).toContain('currencies');
        }
    });

    it('rejects non-JSON-shaped input', () => {
        expect(parseNbgResponse('<html>').ok).toBe(false);
        expect(parseNbgResponse(null).ok).toBe(false);
    });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run src/core/nbg-schema.test.ts`
Expected: FAIL, cannot find module `./nbg-schema.js`.

- [ ] **Step 6: Write `src/core/nbg-schema.ts`**

```ts
import * as z from 'zod';
import { err, ok, type RatesError, type Result } from './types.js';

const nbgCurrencyRowSchema = z.looseObject({
    code: z.string().min(1),
    quantity: z.number().int().positive(),
    rate: z.number(),
    diff: z.number(),
    name: z.string(),
    date: z.string().min(10),
    validFromDate: z.string().min(10).optional(),
});

const nbgDaySchema = z.looseObject({
    date: z.string().min(10),
    currencies: z.array(nbgCurrencyRowSchema),
});

const nbgResponseSchema = z.array(nbgDaySchema);

export type NbgCurrencyRow = z.infer<typeof nbgCurrencyRowSchema>;
export type NbgDay = z.infer<typeof nbgDaySchema>;

export function parseNbgResponse(json: unknown): Result<ReadonlyArray<NbgDay>, RatesError> {
    const parsed = nbgResponseSchema.safeParse(json);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
        return err({ kind: 'upstream_shape_changed', detail });
    }
    return ok(parsed.data);
}
```

If `z.looseObject` is not exported by the installed Zod, use `z.object({ ... }).loose()`; both exist in Zod 4.

- [ ] **Step 7: Run the tests, lint and typecheck**

Run: `npx vitest run src/core/nbg-schema.test.ts && npm run lint && npm run typecheck`
Expected: PASS (7 tests), lint and typecheck clean. The core import ban allows `zod` because it is not a Node built-in and not under `shell/`.

- [ ] **Step 8: Commit**

```bash
git add src/core/nbg-schema.ts src/core/nbg-schema.test.ts scripts/record-fixtures.ts test/fixtures test/helpers/fixtures.ts
git commit -m "Add the NBG response schema and recorded fixtures" -- src/core/nbg-schema.ts src/core/nbg-schema.test.ts scripts/record-fixtures.ts test/fixtures test/helpers/fixtures.ts
```


### Task 4: Normalisation (per-unit rates, fallback flag, currency selection)

**Files:**
- Create: `src/core/normalize.ts`, `src/core/normalize.test.ts`

**Interfaces:**
- Consumes: `NbgDay` from Task 3; `CalendarDate`, `CurrencyCode`, `RatesSnapshot`, `RateEntry` from Task 2; `calendarDateFromTimestamp` from Task 2.
- Produces:
  - `perUnit(value: number, quantity: number): number`
  - `normalizeSnapshot(day: NbgDay, requestedDate: CalendarDate): RatesSnapshot` (full table, `unknownCodes` empty)
  - `selectCurrencies(snapshot: RatesSnapshot, codes: ReadonlyArray<CurrencyCode>): RatesSnapshot` (filtered rates, `unknownCodes` filled, order follows `codes`)

- [ ] **Step 1: Write the failing test `src/core/normalize.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/helpers/fixtures.js';
import { parseCurrencyCode } from './currency-code.js';
import { parseCalendarDate } from './dates.js';
import { parseNbgResponse, type NbgDay } from './nbg-schema.js';
import { normalizeSnapshot, perUnit, selectCurrencies } from './normalize.js';
import type { CalendarDate, CurrencyCode } from './types.js';

function day(fixture: string): NbgDay {
    const parsed = parseNbgResponse(loadFixture(fixture));
    if (!parsed.ok || parsed.value[0] === undefined) {
        throw new Error(`fixture ${fixture} has no day`);
    }
    return parsed.value[0];
}

function date(value: string): CalendarDate {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

function code(value: string): CurrencyCode {
    const parsed = parseCurrencyCode(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

describe('perUnit', () => {
    it('divides by the quantity and rounds to 4 + log10(quantity) decimals', () => {
        expect(perUnit(2.6025, 1)).toBe(2.6025);
        expect(perUnit(7.0844, 10)).toBe(0.70844);
        expect(perUnit(1.2345, 100)).toBe(0.012345);
        expect(perUnit(7.1748, 1000)).toBe(0.0071748);
        expect(perUnit(1.2345, 10000)).toBe(0.00012345);
        expect(perUnit(-0.0035, 1000)).toBe(-0.0000035);
    });

    it('never leaves float noise', () => {
        expect(String(perUnit(7.1748, 1000))).toBe('0.0071748');
    });
});

describe('normalizeSnapshot', () => {
    it('maps a weekday table with per-unit rates and the raw NBG pair', () => {
        const snapshot = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-07'));
        expect(snapshot.requestedDate).toBe('2026-10-07');
        expect(snapshot.effectiveDate).toBe('2026-10-07');
        expect(snapshot.isFallback).toBe(false);
        expect(snapshot.publishedAt).toMatch(/^2026-10-06T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(snapshot.unknownCodes).toEqual([]);
        for (const entry of snapshot.rates) {
            expect(entry.rate).toBe(perUnit(entry.nbgRate, entry.nbgQuantity));
            expect(Number.isFinite(entry.rate)).toBe(true);
        }
        const amd = snapshot.rates.find((entry) => entry.code === 'AMD');
        expect(amd?.nbgQuantity).toBe(1000);
    });

    it('flags a Sunday request answered with the Saturday table', () => {
        const snapshot = normalizeSnapshot(day('en-2026-10-04'), date('2026-10-04'));
        expect(snapshot.requestedDate).toBe('2026-10-04');
        expect(snapshot.effectiveDate).toBe('2026-10-03');
        expect(snapshot.isFallback).toBe(true);
    });

    it('flags a far-future request answered with the current table', () => {
        const snapshot = normalizeSnapshot(day('en-2026-10-07'), date('2099-01-01'));
        expect(snapshot.effectiveDate).toBe('2026-10-07');
        expect(snapshot.isFallback).toBe(true);
    });

    it('uses the day-level date when rows have no validFromDate (2005 archive)', () => {
        const snapshot = normalizeSnapshot(day('en-2005-03-15'), date('2005-03-15'));
        expect(snapshot.effectiveDate).toBe('2005-03-15');
        expect(snapshot.isFallback).toBe(false);
        expect(snapshot.publishedAt).toBe('2005-03-15T00:00:00.000Z');
    });

    it('keeps Georgian names when given the ka table', () => {
        const snapshot = normalizeSnapshot(day('ka-2026-10-07'), date('2026-10-07'));
        const usd = snapshot.rates.find((entry) => entry.code === 'USD');
        expect(usd?.name).not.toBe('US Dollar');
        expect(usd?.rate).toBe(normalizeSnapshot(day('en-2026-10-07'), date('2026-10-07')).rates.find((e) => e.code === 'USD')?.rate);
    });
});

describe('selectCurrencies', () => {
    it('filters in request order and reports unknown codes without failing', () => {
        const full = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-07'));
        const selected = selectCurrencies(full, [code('EUR'), code('XXX'), code('USD')]);
        expect(selected.rates.map((entry) => entry.code)).toEqual(['EUR', 'USD']);
        expect(selected.unknownCodes).toEqual(['XXX']);
        expect(selected.effectiveDate).toBe(full.effectiveDate);
    });

    it('returns no rates and all codes unknown when nothing matches', () => {
        const full = normalizeSnapshot(day('en-2026-10-07'), date('2026-10-07'));
        const selected = selectCurrencies(full, [code('XXX')]);
        expect(selected.rates).toEqual([]);
        expect(selected.unknownCodes).toEqual(['XXX']);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/normalize.test.ts`
Expected: FAIL, cannot find module `./normalize.js`.

- [ ] **Step 3: Write `src/core/normalize.ts`**

```ts
import { calendarDateFromTimestamp } from './dates.js';
import type { NbgDay } from './nbg-schema.js';
import type { CalendarDate, CurrencyCode, RateEntry, RatesSnapshot } from './types.js';

export function perUnit(value: number, quantity: number): number {
    const decimals = 4 + Math.round(Math.log10(quantity));
    return Number((value / quantity).toFixed(decimals));
}

export function normalizeSnapshot(day: NbgDay, requestedDate: CalendarDate): RatesSnapshot {
    const firstRow = day.currencies[0];
    const effectiveDate = calendarDateFromTimestamp(firstRow?.validFromDate ?? day.date);
    const publishedAt = day.currencies
        .map((row) => new Date(row.date).toISOString())
        .reduce((latest, current) => (current > latest ? current : latest), new Date(day.date).toISOString());
    const rates: RateEntry[] = day.currencies.map((row) => ({
        code: row.code.toUpperCase() as CurrencyCode,
        name: row.name,
        rate: perUnit(row.rate, row.quantity),
        diff: perUnit(row.diff, row.quantity),
        nbgQuantity: row.quantity,
        nbgRate: row.rate,
    }));
    return {
        requestedDate,
        effectiveDate,
        isFallback: effectiveDate !== requestedDate,
        publishedAt,
        rates,
        unknownCodes: [],
    };
}

export function selectCurrencies(snapshot: RatesSnapshot, codes: ReadonlyArray<CurrencyCode>): RatesSnapshot {
    const byCode = new Map(snapshot.rates.map((entry) => [entry.code, entry]));
    const rates: RateEntry[] = [];
    const unknownCodes: string[] = [];
    for (const requested of codes) {
        const entry = byCode.get(requested);
        if (entry === undefined) {
            unknownCodes.push(requested);
        } else {
            rates.push(entry);
        }
    }
    return { ...snapshot, rates, unknownCodes };
}
```

The `as CurrencyCode` is a boundary assertion: the row passed the schema and NBG codes are ISO codes. The `Math.round` around `log10` guards against `log10(1000)` evaluating to `2.9999999999999996`.

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run src/core/normalize.test.ts && npm run lint && npm run typecheck`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/normalize.ts src/core/normalize.test.ts
git commit -m "Add snapshot normalisation with per-unit rates and fallback flag" -- src/core/normalize.ts src/core/normalize.test.ts
```

### Task 5: Conversion arithmetic

**Files:**
- Create: `src/core/convert.ts`, `src/core/convert.test.ts`

**Interfaces:**
- Consumes: `RatesSnapshot`, `Conversion`, `CurrencyCode`, `Result`, `ok`, `err`, `RatesError`, `GEL`.
- Produces: `convertAmount(snapshot: RatesSnapshot, amount: number, from: CurrencyCode, to: CurrencyCode): Result<Conversion, RatesError>`

- [ ] **Step 1: Write the failing test `src/core/convert.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { GEL, parseCurrencyCode } from './currency-code.js';
import { convertAmount } from './convert.js';
import type { CalendarDate, CurrencyCode, RatesSnapshot } from './types.js';

function code(value: string): CurrencyCode {
    const parsed = parseCurrencyCode(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

const snapshot: RatesSnapshot = {
    requestedDate: '2026-10-07' as CalendarDate,
    effectiveDate: '2026-10-07' as CalendarDate,
    isFallback: false,
    publishedAt: '2026-10-06T17:01:10.327Z',
    rates: [
        { code: code('USD'), name: 'US Dollar', rate: 2.6025, diff: -0.0007, nbgQuantity: 1, nbgRate: 2.6025 },
        { code: code('EUR'), name: 'Euro', rate: 2.9263, diff: 0.001, nbgQuantity: 1, nbgRate: 2.9263 },
        { code: code('AMD'), name: 'Armenian Dram', rate: 0.0071748, diff: 0, nbgQuantity: 1000, nbgRate: 7.1748 },
    ],
    unknownCodes: [],
};

describe('convertAmount', () => {
    it('converts a foreign currency to GEL directly', () => {
        const result = convertAmount(snapshot, 100, code('USD'), GEL);
        expect(result).toEqual({
            ok: true,
            value: {
                amount: 100,
                from: 'USD',
                to: 'GEL',
                result: 260.25,
                rate: 2.6025,
                via: 'direct',
                requestedDate: '2026-10-07',
                effectiveDate: '2026-10-07',
                isFallback: false,
            },
        });
    });

    it('converts GEL to a foreign currency directly', () => {
        const result = convertAmount(snapshot, 260.25, GEL, code('USD'));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.result).toBeCloseTo(100, 10);
            expect(result.value.rate).toBeCloseTo(1 / 2.6025, 12);
            expect(result.value.via).toBe('direct');
        }
    });

    it('converts a cross pair through GEL', () => {
        const result = convertAmount(snapshot, 100, code('USD'), code('EUR'));
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.via).toBe('GEL');
            expect(result.value.rate).toBeCloseTo(2.6025 / 2.9263, 12);
            expect(result.value.result).toBeCloseTo((100 * 2.6025) / 2.9263, 10);
        }
    });

    it('treats identical codes and GEL to GEL as rate 1', () => {
        for (const [from, to] of [
            [code('USD'), code('USD')],
            [GEL, GEL],
        ] as const) {
            const result = convertAmount(snapshot, 42, from, to);
            expect(result).toMatchObject({ ok: true, value: { rate: 1, result: 42, via: 'direct' } });
        }
    });

    it('fails with unknown_currency when either side is missing from the table', () => {
        const missing = convertAmount(snapshot, 1, code('XXX'), GEL);
        expect(missing).toEqual({ ok: false, error: { kind: 'unknown_currency', code: 'XXX' } });
        const missingTo = convertAmount(snapshot, 1, GEL, code('ZZZ'));
        expect(missingTo).toEqual({ ok: false, error: { kind: 'unknown_currency', code: 'ZZZ' } });
    });

    it('property: converting there and back returns the amount within float tolerance', () => {
        const codes = [GEL, code('USD'), code('EUR'), code('AMD')];
        fc.assert(
            fc.property(
                fc.double({ min: -1e9, max: 1e9, noNaN: true, noDefaultInfinity: true }),
                fc.constantFrom(...codes),
                fc.constantFrom(...codes),
                (amount, from, to) => {
                    const there = convertAmount(snapshot, amount, from, to);
                    if (!there.ok) {
                        return false;
                    }
                    const back = convertAmount(snapshot, there.value.result, to, from);
                    return back.ok && Math.abs(back.value.result - amount) <= Math.abs(amount) * 1e-9 + 1e-9;
                },
            ),
        );
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/convert.test.ts`
Expected: FAIL, cannot find module `./convert.js`.

- [ ] **Step 3: Write `src/core/convert.ts`**

```ts
import { GEL } from './currency-code.js';
import { err, ok, type Conversion, type CurrencyCode, type RatesError, type RatesSnapshot, type Result } from './types.js';

function rateInGel(snapshot: RatesSnapshot, code: CurrencyCode): Result<number, RatesError> {
    if (code === GEL) {
        return ok(1);
    }
    const entry = snapshot.rates.find((candidate) => candidate.code === code);
    if (entry === undefined) {
        return err({ kind: 'unknown_currency', code });
    }
    return ok(entry.rate);
}

export function convertAmount(
    snapshot: RatesSnapshot,
    amount: number,
    from: CurrencyCode,
    to: CurrencyCode,
): Result<Conversion, RatesError> {
    const fromRate = rateInGel(snapshot, from);
    if (!fromRate.ok) {
        return fromRate;
    }
    const toRate = rateInGel(snapshot, to);
    if (!toRate.ok) {
        return toRate;
    }
    const identical = from === to;
    const rate = identical ? 1 : fromRate.value / toRate.value;
    const via: Conversion['via'] = identical || from === GEL || to === GEL ? 'direct' : 'GEL';
    return ok({
        amount,
        from,
        to,
        result: identical ? amount : amount * rate,
        rate,
        via,
        requestedDate: snapshot.requestedDate,
        effectiveDate: snapshot.effectiveDate,
        isFallback: snapshot.isFallback,
    });
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run src/core/convert.test.ts && npm run lint && npm run typecheck`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/convert.ts src/core/convert.test.ts
git commit -m "Add conversion through GEL" -- src/core/convert.ts src/core/convert.test.ts
```

### Task 6: History assembly

**Files:**
- Create: `src/core/history.ts`, `src/core/history.test.ts`

**Interfaces:**
- Consumes: `RatesSnapshot`, `HistorySeries`, `HistoryPoint`, `CalendarDate`, `CurrencyCode`, `Result`, `RatesError`.
- Produces: `assembleHistory(currency: CurrencyCode, days: ReadonlyArray<CalendarDate>, snapshots: ReadonlyMap<CalendarDate, RatesSnapshot>): Result<HistorySeries, RatesError>`

- [ ] **Step 1: Write the failing test `src/core/history.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { parseCurrencyCode } from './currency-code.js';
import { enumerateDays, parseCalendarDate } from './dates.js';
import { assembleHistory } from './history.js';
import type { CalendarDate, CurrencyCode, RatesSnapshot } from './types.js';

function date(value: string): CalendarDate {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

function code(value: string): CurrencyCode {
    const parsed = parseCurrencyCode(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

function snapshot(requested: string, effective: string, usdRate: number | undefined): RatesSnapshot {
    return {
        requestedDate: date(requested),
        effectiveDate: date(effective),
        isFallback: requested !== effective,
        publishedAt: `${effective}T00:00:00.000Z`,
        rates:
            usdRate === undefined
                ? []
                : [{ code: code('USD'), name: 'US Dollar', rate: usdRate, diff: 0.001, nbgQuantity: 1, nbgRate: usdRate }],
        unknownCodes: [],
    };
}

describe('assembleHistory', () => {
    it('produces one point per calendar day in order with weekend fallbacks flagged', () => {
        const days = enumerateDays(date('2026-10-01'), date('2026-10-05'));
        if (!days.ok) {
            throw new Error('range');
        }
        const snapshots = new Map<CalendarDate, RatesSnapshot>([
            [date('2026-10-01'), snapshot('2026-10-01', '2026-10-01', 2.61)],
            [date('2026-10-02'), snapshot('2026-10-02', '2026-10-02', 2.6)],
            [date('2026-10-03'), snapshot('2026-10-03', '2026-10-03', 2.6039)],
            [date('2026-10-04'), snapshot('2026-10-04', '2026-10-03', 2.6039)],
            [date('2026-10-05'), snapshot('2026-10-05', '2026-10-05', 2.603)],
        ]);
        const result = assembleHistory(code('USD'), days.value, snapshots);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.from).toBe('2026-10-01');
            expect(result.value.to).toBe('2026-10-05');
            expect(result.value.days.map((point) => point.date)).toEqual(days.value);
            expect(result.value.days[3]).toEqual({
                date: '2026-10-04',
                effectiveDate: '2026-10-03',
                rate: 2.6039,
                diff: 0.001,
                isFallback: true,
            });
            expect(result.value.days.filter((point) => point.isFallback).map((point) => point.date)).toEqual(['2026-10-04']);
        }
    });

    it('fails with unknown_currency when any day lacks the currency', () => {
        const days = [date('2026-10-01'), date('2026-10-02')];
        const snapshots = new Map<CalendarDate, RatesSnapshot>([
            [date('2026-10-01'), snapshot('2026-10-01', '2026-10-01', 2.61)],
            [date('2026-10-02'), snapshot('2026-10-02', '2026-10-02', undefined)],
        ]);
        expect(assembleHistory(code('USD'), days, snapshots)).toEqual({
            ok: false,
            error: { kind: 'unknown_currency', code: 'USD' },
        });
    });

    it('throws when a day has no snapshot (programmer error: the fetcher must supply every day)', () => {
        const days = [date('2026-10-01')];
        expect(() => assembleHistory(code('USD'), days, new Map())).toThrow(/2026-10-01/);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/history.test.ts`
Expected: FAIL, cannot find module `./history.js`.

- [ ] **Step 3: Write `src/core/history.ts`**

```ts
import {
    err,
    ok,
    type CalendarDate,
    type CurrencyCode,
    type HistoryPoint,
    type HistorySeries,
    type RatesError,
    type RatesSnapshot,
    type Result,
} from './types.js';

export function assembleHistory(
    currency: CurrencyCode,
    days: ReadonlyArray<CalendarDate>,
    snapshots: ReadonlyMap<CalendarDate, RatesSnapshot>,
): Result<HistorySeries, RatesError> {
    const first = days[0];
    const last = days[days.length - 1];
    if (first === undefined || last === undefined) {
        throw new Error('assembleHistory needs at least one day');
    }
    const points: HistoryPoint[] = [];
    for (const day of days) {
        const snapshot = snapshots.get(day);
        if (snapshot === undefined) {
            throw new Error(`no snapshot for ${day}`);
        }
        const entry = snapshot.rates.find((candidate) => candidate.code === currency);
        if (entry === undefined) {
            return err({ kind: 'unknown_currency', code: currency });
        }
        points.push({
            date: day,
            effectiveDate: snapshot.effectiveDate,
            rate: entry.rate,
            diff: entry.diff,
            isFallback: snapshot.isFallback,
        });
    }
    return ok({ currency, from: first, to: last, days: points });
}
```

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run src/core && npm run lint && npm run typecheck`
Expected: all core tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/history.ts src/core/history.test.ts
git commit -m "Add history series assembly" -- src/core/history.ts src/core/history.test.ts
```


### Task 7: Fixture HTTP server and the NBG client

**Files:**
- Create: `test/helpers/fixture-server.ts`, `src/shell/nbg-client.ts`, `src/shell/nbg-client.test.ts`

**Interfaces:**
- Consumes: `parseNbgResponse`, `NbgDay` (Task 3); `CalendarDate`, `Language`, `Result`, `RatesError`, `ok`, `err` (Task 2); `loadFixture`, `fixturePath` (Task 3).
- Produces:
  - `startFixtureServer(): Promise<FixtureServer>` where `FixtureServer = { baseUrl: string; requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }>; setResponder(fn: Responder | undefined): void; close(): Promise<void> }` and `Responder = (url: URL) => { status: number; body: string; delayMs?: number } | undefined`
  - `createNbgClient(options: NbgClientOptions): NbgClient` with `NbgClient = { fetchDay(date: CalendarDate, language: Language): Promise<Result<NbgDay, RatesError>> }` and `NbgClientOptions = { baseUrl: string; userAgent: string; timeoutMs?: number; retryDelayMs?: number; fetchImpl?: typeof fetch; log?: (message: string) => void }`

- [ ] **Step 1: Write `test/helpers/fixture-server.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixturePath } from './fixtures.js';

export type Responder = (url: URL) => { status: number; body: string; delayMs?: number } | undefined;

export interface FixtureServer {
    readonly baseUrl: string;
    readonly requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }>;
    setResponder(responder: Responder | undefined): void;
    close(): Promise<void>;
}

const LATEST_FIXTURE_DATE = '2026-10-07';

/** Mimics nbg.gov.ge: serves a recorded fixture per language and date, and the latest table for any other date. */
export async function startFixtureServer(): Promise<FixtureServer> {
    const requests: FixtureServer['requests'] = [];
    let responder: Responder | undefined;

    const server: Server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        requests.push({ url: url.pathname + url.search, headers: request.headers });

        const custom = responder?.(url);
        if (custom !== undefined) {
            setTimeout(() => {
                response.writeHead(custom.status, { 'content-type': 'application/json' });
                response.end(custom.body);
            }, custom.delayMs ?? 0);
            return;
        }

        const match = /^\/gw\/api\/ct\/monetarypolicy\/currencies\/(en|ka)\/json\/?$/.exec(url.pathname);
        if (match === null) {
            response.writeHead(404).end('not found');
            return;
        }
        const language = match[1] ?? 'en';
        const date = url.searchParams.get('date') ?? LATEST_FIXTURE_DATE;
        const exact = fixturePath(`${language}-${date}`);
        const file = existsSync(exact) ? exact : fixturePath(`${language}-${LATEST_FIXTURE_DATE}`);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(readFileSync(file));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        setResponder(next) {
            responder = next;
        },
        close() {
            return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
```

- [ ] **Step 2: Write the failing test `src/shell/nbg-client.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../test/helpers/fixture-server.js';
import { parseCalendarDate } from '../core/dates.js';
import type { CalendarDate } from '../core/types.js';
import { createNbgClient } from './nbg-client.js';

function date(value: string): CalendarDate {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

describe('createNbgClient', () => {
    let server: FixtureServer;

    beforeEach(async () => {
        server = await startFixtureServer();
    });

    afterEach(async () => {
        await server.close();
    });

    function client(overrides: { timeoutMs?: number; log?: (message: string) => void } = {}) {
        return createNbgClient({
            baseUrl: server.baseUrl,
            userAgent: 'nbg-rates-mcp/test',
            retryDelayMs: 5,
            ...overrides,
        });
    }

    it('fetches a day with the date in the query and the user agent header', async () => {
        const result = await client().fetchDay(date('2026-10-07'), 'en');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.date).toBe('2026-10-07T00:00:00.000Z');
        }
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]?.url).toBe('/gw/api/ct/monetarypolicy/currencies/en/json?date=2026-10-07');
        expect(server.requests[0]?.headers['user-agent']).toBe('nbg-rates-mcp/test');
    });

    it('uses the ka path for Georgian', async () => {
        await client().fetchDay(date('2026-10-07'), 'ka');
        expect(server.requests[0]?.url).toContain('/currencies/ka/json');
    });

    it('maps an empty table to no_data_for_date', async () => {
        const result = await client().fetchDay(date('1995-01-01'), 'en');
        expect(result).toEqual({ ok: false, error: { kind: 'no_data_for_date', date: '1995-01-01' } });
    });

    it('retries once after a 503 and succeeds', async () => {
        let calls = 0;
        server.setResponder(() => {
            calls += 1;
            return calls === 1 ? { status: 503, body: 'down' } : undefined;
        });
        const result = await client().fetchDay(date('2026-10-07'), 'en');
        expect(result.ok).toBe(true);
        expect(server.requests).toHaveLength(2);
    });

    it('retries once after a 429 and succeeds', async () => {
        let calls = 0;
        server.setResponder(() => {
            calls += 1;
            return calls === 1 ? { status: 429, body: 'slow down' } : undefined;
        });
        expect((await client().fetchDay(date('2026-10-07'), 'en')).ok).toBe(true);
        expect(server.requests).toHaveLength(2);
    });

    it('gives up after the second 503 with upstream_unavailable', async () => {
        server.setResponder(() => ({ status: 503, body: 'down' }));
        const result = await client().fetchDay(date('2026-10-07'), 'en');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('upstream_unavailable');
            expect(result.error.kind === 'upstream_unavailable' && result.error.detail).toContain('503');
        }
        expect(server.requests).toHaveLength(2);
    });

    it('does not retry a 404', async () => {
        server.setResponder(() => ({ status: 404, body: 'gone' }));
        const result = await client().fetchDay(date('2026-10-07'), 'en');
        expect(result.ok).toBe(false);
        expect(server.requests).toHaveLength(1);
    });

    it('times out and reports upstream_unavailable', async () => {
        server.setResponder(() => ({ status: 200, body: '[]', delayMs: 500 }));
        const result = await client({ timeoutMs: 50 }).fetchDay(date('2026-10-07'), 'en');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('upstream_unavailable');
        }
    });

    it('reports a non-JSON 200 body as upstream_shape_changed', async () => {
        server.setResponder(() => ({ status: 200, body: '<html>maintenance</html>' }));
        const result = await client().fetchDay(date('2026-10-07'), 'en');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('upstream_shape_changed');
        }
    });

    it('reports a connection failure as upstream_unavailable', async () => {
        const dead = createNbgClient({ baseUrl: 'http://127.0.0.1:1', userAgent: 'x', retryDelayMs: 1 });
        const result = await dead.fetchDay(date('2026-10-07'), 'en');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('upstream_unavailable');
        }
    });

    it('logs each request with status and duration when a logger is given', async () => {
        const lines: string[] = [];
        await client({ log: (line) => lines.push(line) }).fetchDay(date('2026-10-07'), 'en');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/GET .*date=2026-10-07 -> 200 in \d+ms/);
    });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/shell/nbg-client.test.ts`
Expected: FAIL, cannot find module `./nbg-client.js`.

- [ ] **Step 4: Write `src/shell/nbg-client.ts`**

```ts
import { parseNbgResponse, type NbgDay } from '../core/nbg-schema.js';
import { err, ok, type CalendarDate, type Language, type RatesError, type Result } from '../core/types.js';

export interface NbgClientOptions {
    readonly baseUrl: string;
    readonly userAgent: string;
    readonly timeoutMs?: number;
    readonly retryDelayMs?: number;
    readonly fetchImpl?: typeof fetch;
    readonly log?: (message: string) => void;
}

export interface NbgClient {
    fetchDay(date: CalendarDate, language: Language): Promise<Result<NbgDay, RatesError>>;
}

type Attempt = { kind: 'ok'; body: unknown } | { kind: 'retryable'; detail: string } | { kind: 'fatal'; error: RatesError };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createNbgClient(options: NbgClientOptions): NbgClient {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const retryDelayMs = options.retryDelayMs ?? 500;
    const fetchImpl = options.fetchImpl ?? fetch;
    const log = options.log ?? (() => undefined);

    async function attempt(url: string): Promise<Attempt> {
        const started = Date.now();
        try {
            const response = await fetchImpl(url, {
                headers: { 'user-agent': options.userAgent, accept: 'application/json' },
                signal: AbortSignal.timeout(timeoutMs),
            });
            log(`GET ${url} -> ${response.status} in ${Date.now() - started}ms`);
            if (response.status === 429 || response.status >= 500) {
                return { kind: 'retryable', detail: `HTTP ${response.status}` };
            }
            if (!response.ok) {
                return { kind: 'fatal', error: { kind: 'upstream_unavailable', detail: `HTTP ${response.status}` } };
            }
            const text = await response.text();
            try {
                return { kind: 'ok', body: JSON.parse(text) as unknown };
            } catch {
                return {
                    kind: 'fatal',
                    error: { kind: 'upstream_shape_changed', detail: `response is not JSON: ${text.slice(0, 80)}` },
                };
            }
        } catch (error: unknown) {
            const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            log(`GET ${url} -> ${detail} in ${Date.now() - started}ms`);
            return { kind: 'retryable', detail };
        }
    }

    return {
        async fetchDay(date, language) {
            const url = `${options.baseUrl}/gw/api/ct/monetarypolicy/currencies/${language}/json?date=${date}`;
            let outcome = await attempt(url);
            if (outcome.kind === 'retryable') {
                await sleep(retryDelayMs);
                outcome = await attempt(url);
            }
            if (outcome.kind === 'retryable') {
                return err({ kind: 'upstream_unavailable', detail: `${outcome.detail} after retry` });
            }
            if (outcome.kind === 'fatal') {
                return err(outcome.error);
            }
            const parsed = parseNbgResponse(outcome.body);
            if (!parsed.ok) {
                return parsed;
            }
            const day = parsed.value[0];
            if (day === undefined) {
                return err({ kind: 'no_data_for_date', date });
            }
            return ok(day);
        },
    };
}
```

- [ ] **Step 5: Run tests, lint, typecheck**

Run: `npx vitest run src/shell/nbg-client.test.ts && npm run lint && npm run typecheck`
Expected: PASS (11 tests). The `as unknown` after `JSON.parse` is the documented boundary assertion.

- [ ] **Step 6: Commit**

```bash
git add test/helpers/fixture-server.ts src/shell/nbg-client.ts src/shell/nbg-client.test.ts
git commit -m "Add the NBG HTTP client with timeout and retry" -- test/helpers/fixture-server.ts src/shell/nbg-client.ts src/shell/nbg-client.test.ts
```

### Task 8: Snapshot cache

**Files:**
- Create: `src/shell/cache.ts`, `src/shell/cache.test.ts`

**Interfaces:**
- Consumes: `RatesSnapshot`, `CalendarDate`, `Language` (Task 2); `todayIn`, `TBILISI_TIME_ZONE` (Task 2).
- Produces: `createSnapshotCache(options?: { maxEntries?: number; provisionalTtlMs?: number; timeZone?: string }): SnapshotCache` with `SnapshotCache = { get(language: Language, requestedDate: CalendarDate, now: Date): RatesSnapshot | undefined; set(language: Language, requestedDate: CalendarDate, snapshot: RatesSnapshot, now: Date): void; readonly size: number }`

- [ ] **Step 1: Write the failing test `src/shell/cache.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { parseCalendarDate } from '../core/dates.js';
import type { CalendarDate, RatesSnapshot } from '../core/types.js';
import { createSnapshotCache } from './cache.js';

function date(value: string): CalendarDate {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

function snapshot(requested: string, effective: string): RatesSnapshot {
    return {
        requestedDate: date(requested),
        effectiveDate: date(effective),
        isFallback: requested !== effective,
        publishedAt: `${effective}T13:01:00.000Z`,
        rates: [],
        unknownCodes: [],
    };
}

// 2026-10-08 10:00 in Tbilisi (UTC+4)
const NOW = new Date('2026-10-08T06:00:00Z');

describe('createSnapshotCache', () => {
    it('keeps a past fallback snapshot (a 2024 Sunday) forever', () => {
        const cache = createSnapshotCache({ provisionalTtlMs: 1000 });
        cache.set('en', date('2024-06-02'), snapshot('2024-06-02', '2024-06-01'), NOW);
        const muchLater = new Date(NOW.getTime() + 365 * 86_400_000);
        expect(cache.get('en', date('2024-06-02'), muchLater)).toBeDefined();
    });

    it('keeps a published snapshot for today forever', () => {
        const cache = createSnapshotCache({ provisionalTtlMs: 1000 });
        cache.set('en', date('2026-10-08'), snapshot('2026-10-08', '2026-10-08'), NOW);
        expect(cache.get('en', date('2026-10-08'), new Date(NOW.getTime() + 86_400_000))).toBeDefined();
    });

    it('expires a fallback snapshot for tomorrow after the provisional TTL', () => {
        const cache = createSnapshotCache({ provisionalTtlMs: 1000 });
        cache.set('en', date('2026-10-09'), snapshot('2026-10-09', '2026-10-08'), NOW);
        expect(cache.get('en', date('2026-10-09'), new Date(NOW.getTime() + 999))).toBeDefined();
        expect(cache.get('en', date('2026-10-09'), new Date(NOW.getTime() + 1001))).toBeUndefined();
    });

    it('treats a fallback snapshot for today as provisional (tomorrow in Tbilisi may already be today elsewhere)', () => {
        const cache = createSnapshotCache({ provisionalTtlMs: 1000 });
        cache.set('en', date('2026-10-08'), snapshot('2026-10-08', '2026-10-07'), NOW);
        expect(cache.get('en', date('2026-10-08'), new Date(NOW.getTime() + 1001))).toBeUndefined();
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/shell/cache.test.ts`
Expected: FAIL, cannot find module `./cache.js`.

- [ ] **Step 3: Write `src/shell/cache.ts`**

```ts
import { TBILISI_TIME_ZONE, todayIn } from '../core/dates.js';
import type { CalendarDate, Language, RatesSnapshot } from '../core/types.js';

export interface SnapshotCache {
    get(language: Language, requestedDate: CalendarDate, now: Date): RatesSnapshot | undefined;
    set(language: Language, requestedDate: CalendarDate, snapshot: RatesSnapshot, now: Date): void;
    readonly size: number;
}

interface Entry {
    readonly snapshot: RatesSnapshot;
    /** Undefined means final: never expires. */
    readonly expiresAt: number | undefined;
}

export function createSnapshotCache(
    options: { maxEntries?: number; provisionalTtlMs?: number; timeZone?: string } = {},
): SnapshotCache {
    const maxEntries = options.maxEntries ?? 2000;
    const provisionalTtlMs = options.provisionalTtlMs ?? 10 * 60 * 1000;
    const timeZone = options.timeZone ?? TBILISI_TIME_ZONE;
    const entries = new Map<string, Entry>();

    function key(language: Language, requestedDate: CalendarDate): string {
        return `${language}:${requestedDate}`;
    }

    function isFinal(requestedDate: CalendarDate, snapshot: RatesSnapshot, now: Date): boolean {
        if (requestedDate < todayIn(timeZone, now)) {
            return true;
        }
        return !snapshot.isFallback;
    }

    return {
        get(language, requestedDate, now) {
            const entry = entries.get(key(language, requestedDate));
            if (entry === undefined) {
                return undefined;
            }
            if (entry.expiresAt !== undefined && now.getTime() > entry.expiresAt) {
                entries.delete(key(language, requestedDate));
                return undefined;
            }
            return entry.snapshot;
        },
        set(language, requestedDate, snapshot, now) {
            const expiresAt = isFinal(requestedDate, snapshot, now) ? undefined : now.getTime() + provisionalTtlMs;
            const entryKey = key(language, requestedDate);
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
```

A `Map` iterates in insertion order, so deleting then re-setting a key moves it to the back and the first key is always the oldest.

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run src/shell/cache.test.ts && npm run lint && npm run typecheck`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shell/cache.ts src/shell/cache.test.ts
git commit -m "Add the snapshot cache with finality rules" -- src/shell/cache.ts src/shell/cache.test.ts
```


### Task 9: Rates service (single date and history fan-out)

**Files:**
- Create: `src/shell/concurrency.ts`, `src/shell/concurrency.test.ts`, `src/shell/rates-service.ts`, `src/shell/rates-service.test.ts`

**Interfaces:**
- Consumes: `NbgClient` (Task 7), `SnapshotCache` (Task 8), `normalizeSnapshot`, `selectCurrencies` (Task 4), `assembleHistory` (Task 6), `enumerateDays` (Task 2), core types.
- Produces:
  - `mapWithConcurrency<T, R>(items: ReadonlyArray<T>, limit: number, fn: (item: T) => Promise<R>): Promise<R[]>` (results in input order)
  - `createRatesService(deps: { client: NbgClient; cache: SnapshotCache; now: () => Date; concurrency?: number }): RatesService` with
    `RatesService = { getSnapshot(args: { date: CalendarDate; language: Language; codes?: ReadonlyArray<CurrencyCode> }): Promise<Result<RatesSnapshot, RatesError>>; getHistory(args: { currency: CurrencyCode; from: CalendarDate; to: CalendarDate; language: Language }): Promise<Result<HistorySeries, RatesError>> }`

- [ ] **Step 1: Write the failing test `src/shell/concurrency.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

describe('mapWithConcurrency', () => {
    it('returns results in input order and never exceeds the limit', async () => {
        let inFlight = 0;
        let peak = 0;
        const items = Array.from({ length: 20 }, (_, index) => index);
        const results = await mapWithConcurrency(items, 3, async (item) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, (20 - item) % 4));
            inFlight -= 1;
            return item * 2;
        });
        expect(results).toEqual(items.map((item) => item * 2));
        expect(peak).toBe(3);
    });

    it('handles an empty list', async () => {
        expect(await mapWithConcurrency([], 4, async (item: number) => item)).toEqual([]);
    });

    it('rejects when any item rejects', async () => {
        await expect(
            mapWithConcurrency([1, 2, 3], 2, async (item) => {
                if (item === 2) {
                    throw new Error('boom');
                }
                return item;
            }),
        ).rejects.toThrow('boom');
    });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `src/shell/concurrency.ts`**

Run: `npx vitest run src/shell/concurrency.test.ts` and expect FAIL (module missing).

```ts
export async function mapWithConcurrency<T, R>(
    items: ReadonlyArray<T>,
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            const item = items[index];
            if (item === undefined) {
                throw new Error(`no item at index ${index}`);
            }
            results[index] = await fn(item);
        }
    }

    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
    await Promise.all(workers);
    return results;
}
```

Run: `npx vitest run src/shell/concurrency.test.ts` and expect PASS (3 tests).

- [ ] **Step 3: Write the failing test `src/shell/rates-service.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/helpers/fixtures.js';
import { parseCurrencyCode } from '../core/currency-code.js';
import { parseCalendarDate } from '../core/dates.js';
import { parseNbgResponse, type NbgDay } from '../core/nbg-schema.js';
import { err, ok, type CalendarDate, type CurrencyCode, type Language, type RatesError, type Result } from '../core/types.js';
import { createSnapshotCache } from './cache.js';
import type { NbgClient } from './nbg-client.js';
import { createRatesService } from './rates-service.js';

function date(value: string): CalendarDate {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

function code(value: string): CurrencyCode {
    const parsed = parseCurrencyCode(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

function fixtureDay(language: Language, value: string): Result<NbgDay, RatesError> {
    const parsed = parseNbgResponse(loadFixture(`${language}-${value}`));
    if (!parsed.ok) {
        return parsed;
    }
    const day = parsed.value[0];
    return day === undefined ? err({ kind: 'no_data_for_date', date: date(value) }) : ok(day);
}

/** Fake client: serves recorded fixtures, falls back to the latest table like NBG, counts calls, can fail a date. */
function fakeClient(options: { failDate?: string } = {}) {
    const calls: string[] = [];
    const recorded = new Set(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2005-03-15', '1995-01-01']);
    const client: NbgClient = {
        fetchDay(requested, language) {
            calls.push(`${language}:${requested}`);
            if (requested === options.failDate) {
                return Promise.resolve(err({ kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' }));
            }
            const value = recorded.has(requested) && language === 'en' ? requested : '2026-10-07';
            return Promise.resolve(fixtureDay(language === 'ka' ? 'ka' : 'en', value));
        },
    };
    return { client, calls };
}

const NOW = new Date('2026-10-08T06:00:00Z');

function service(options: { failDate?: string; concurrency?: number } = {}) {
    const { client, calls } = fakeClient(options);
    const cache = createSnapshotCache();
    const deps = { client, cache, now: () => NOW, ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }) };
    return { service: createRatesService(deps), calls };
}

describe('getSnapshot', () => {
    it('returns the full table and caches it, so a second call with a filter fetches nothing', async () => {
        const { service: rates, calls } = service();
        const full = await rates.getSnapshot({ date: date('2026-10-07'), language: 'en' });
        expect(full.ok).toBe(true);
        const filtered = await rates.getSnapshot({ date: date('2026-10-07'), language: 'en', codes: [code('USD'), code('XXX')] });
        expect(filtered.ok).toBe(true);
        if (filtered.ok) {
            expect(filtered.value.rates.map((entry) => entry.code)).toEqual(['USD']);
            expect(filtered.value.unknownCodes).toEqual(['XXX']);
        }
        expect(calls).toEqual(['en:2026-10-07']);
    });

    it('flags a Sunday as fallback', async () => {
        const { service: rates } = service();
        const result = await rates.getSnapshot({ date: date('2026-10-04'), language: 'en' });
        expect(result.ok && result.value.isFallback).toBe(true);
        expect(result.ok && result.value.effectiveDate).toBe('2026-10-03');
    });

    it('passes upstream errors through', async () => {
        const { service: rates } = service({ failDate: '2026-10-07' });
        const result = await rates.getSnapshot({ date: date('2026-10-07'), language: 'en' });
        expect(result).toEqual({ ok: false, error: { kind: 'upstream_unavailable', detail: 'HTTP 503 after retry' } });
    });
});

describe('getHistory', () => {
    it('fetches each day once, in bounded parallel, and returns every calendar day', async () => {
        const { service: rates, calls } = service({ concurrency: 2 });
        const result = await rates.getHistory({ currency: code('USD'), from: date('2026-10-01'), to: date('2026-10-07'), language: 'en' });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.days).toHaveLength(7);
            expect(result.value.days.map((point) => point.date)).toEqual([
                '2026-10-01',
                '2026-10-02',
                '2026-10-03',
                '2026-10-04',
                '2026-10-05',
                '2026-10-06',
                '2026-10-07',
            ]);
            expect(result.value.days.find((point) => point.date === '2026-10-04')?.isFallback).toBe(true);
        }
        expect([...calls].sort()).toEqual(
            ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'].map((d) => `en:${d}`),
        );
    });

    it('reuses cached days on a second range', async () => {
        const { service: rates, calls } = service();
        await rates.getHistory({ currency: code('USD'), from: date('2026-10-01'), to: date('2026-10-07'), language: 'en' });
        await rates.getHistory({ currency: code('EUR'), from: date('2026-10-01'), to: date('2026-10-07'), language: 'en' });
        expect(calls).toHaveLength(7);
    });

    it('fails the whole call and names the date when one day fails', async () => {
        const { service: rates } = service({ failDate: '2026-10-03' });
        const result = await rates.getHistory({ currency: code('USD'), from: date('2026-10-01'), to: date('2026-10-05'), language: 'en' });
        expect(result.ok).toBe(false);
        if (!result.ok && result.error.kind === 'upstream_unavailable') {
            expect(result.error.detail).toContain('2026-10-03');
        }
    });

    it('rejects a range longer than 366 days before fetching anything', async () => {
        const { service: rates, calls } = service();
        const result = await rates.getHistory({ currency: code('USD'), from: date('2024-01-01'), to: date('2025-01-01'), language: 'en' });
        expect(result).toEqual({ ok: false, error: { kind: 'range_too_long', days: 367, max: 366 } });
        expect(calls).toHaveLength(0);
    });

    it('reports unknown_currency for a code absent from the table', async () => {
        const { service: rates } = service();
        const result = await rates.getHistory({ currency: code('XXX'), from: date('2026-10-01'), to: date('2026-10-02'), language: 'en' });
        expect(result).toEqual({ ok: false, error: { kind: 'unknown_currency', code: 'XXX' } });
    });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/shell/rates-service.test.ts`
Expected: FAIL, cannot find module `./rates-service.js`.

- [ ] **Step 5: Write `src/shell/rates-service.ts`**

```ts
import { enumerateDays } from '../core/dates.js';
import { assembleHistory } from '../core/history.js';
import { normalizeSnapshot, selectCurrencies } from '../core/normalize.js';
import {
    err,
    ok,
    type CalendarDate,
    type CurrencyCode,
    type HistorySeries,
    type Language,
    type RatesError,
    type RatesSnapshot,
    type Result,
} from '../core/types.js';
import type { SnapshotCache } from './cache.js';
import { mapWithConcurrency } from './concurrency.js';
import type { NbgClient } from './nbg-client.js';

export interface RatesService {
    getSnapshot(args: {
        date: CalendarDate;
        language: Language;
        codes?: ReadonlyArray<CurrencyCode>;
    }): Promise<Result<RatesSnapshot, RatesError>>;
    getHistory(args: {
        currency: CurrencyCode;
        from: CalendarDate;
        to: CalendarDate;
        language: Language;
    }): Promise<Result<HistorySeries, RatesError>>;
}

export function createRatesService(deps: {
    client: NbgClient;
    cache: SnapshotCache;
    now: () => Date;
    concurrency?: number;
}): RatesService {
    const concurrency = deps.concurrency ?? 6;

    async function fullSnapshot(date: CalendarDate, language: Language): Promise<Result<RatesSnapshot, RatesError>> {
        const cached = deps.cache.get(language, date, deps.now());
        if (cached !== undefined) {
            return ok(cached);
        }
        const day = await deps.client.fetchDay(date, language);
        if (!day.ok) {
            return day;
        }
        const snapshot = normalizeSnapshot(day.value, date);
        deps.cache.set(language, date, snapshot, deps.now());
        return ok(snapshot);
    }

    return {
        async getSnapshot({ date, language, codes }) {
            const snapshot = await fullSnapshot(date, language);
            if (!snapshot.ok || codes === undefined) {
                return snapshot;
            }
            return ok(selectCurrencies(snapshot.value, codes));
        },

        async getHistory({ currency, from, to, language }) {
            const days = enumerateDays(from, to);
            if (!days.ok) {
                return days;
            }
            const fetched = await mapWithConcurrency(days.value, concurrency, async (day) => ({
                day,
                result: await fullSnapshot(day, language),
            }));
            const snapshots = new Map<CalendarDate, RatesSnapshot>();
            for (const { day, result } of fetched) {
                if (!result.ok) {
                    const error = result.error;
                    if (error.kind === 'upstream_unavailable' || error.kind === 'upstream_shape_changed') {
                        return err({ kind: error.kind, detail: `${day}: ${error.detail}` });
                    }
                    return err(error);
                }
                snapshots.set(day, result.value);
            }
            return assembleHistory(currency, days.value, snapshots);
        },
    };
}
```

- [ ] **Step 6: Run tests, lint, typecheck**

Run: `npx vitest run src/shell && npm run lint && npm run typecheck`
Expected: all shell tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shell/concurrency.ts src/shell/concurrency.test.ts src/shell/rates-service.ts src/shell/rates-service.test.ts
git commit -m "Add the rates service with cached history fan-out" -- src/shell/concurrency.ts src/shell/concurrency.test.ts src/shell/rates-service.ts src/shell/rates-service.test.ts
```


### Task 10: MCP server, binary and end-to-end test

**Files:**
- Create: `src/shell/tool-schemas.ts`, `src/shell/server.ts`, `src/shell/server.test.ts`, `src/bin.ts`, `test/e2e/stdio.test.ts`

**Interfaces:**
- Consumes: `RatesService` (Task 9), `createNbgClient` (Task 7), `createSnapshotCache` (Task 8), core parsing functions (Task 2), `convertAmount` (Task 5), `GEL`.
- Produces:
  - `describeError(error: RatesError): string`
  - `createServer(deps: { service: RatesService; now: () => Date; version: string }): McpServer`
  - `dist/bin.js`, the executable the package's `bin` points at.

- [ ] **Step 1: Write `src/shell/tool-schemas.ts`**

```ts
import * as z from 'zod';

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const currencyCode = z.string().min(1).max(10);

export const languageInput = z
    .enum(['en', 'ka'])
    .describe('Language of currency names: en (default) or ka (Georgian). Codes, numbers and dates are identical in both.');

export const getRatesInput = z.object({
    date: calendarDate
        .optional()
        .describe('Calendar date YYYY-MM-DD. Defaults to today in Tbilisi. Tomorrow\'s rate exists after about 17:00 Tbilisi time.'),
    currencies: z
        .array(currencyCode)
        .optional()
        .describe('ISO 4217 codes to return, case-insensitive (for example ["USD", "EUR"]). Omit for all currencies.'),
    language: languageInput.optional(),
});

export const convertInput = z.object({
    amount: z.number().finite().describe('Amount in the "from" currency. May be negative.'),
    from: currencyCode.describe('ISO 4217 code, or GEL.'),
    to: currencyCode.describe('ISO 4217 code, or GEL.'),
    date: calendarDate.optional().describe('Calendar date YYYY-MM-DD whose official rate to apply. Defaults to today in Tbilisi.'),
});

export const listCurrenciesInput = z.object({
    language: languageInput.optional(),
});

export const rateHistoryInput = z.object({
    currency: currencyCode.describe('ISO 4217 code, for example USD.'),
    from: calendarDate.describe('First calendar day, inclusive.'),
    to: calendarDate.describe('Last calendar day, inclusive. At most 366 days after "from".'),
    language: languageInput.optional(),
});

const rateEntry = z.object({
    code: z.string(),
    name: z.string(),
    rate: z.number().describe('GEL per ONE unit of the currency'),
    diff: z.number().describe('Change versus the previous published rate, per one unit'),
    nbgQuantity: z.number().describe('Units NBG quotes the raw rate for (1, 10, 100, 1000 or 10000)'),
    nbgRate: z.number().describe('Raw rate as published by NBG, for nbgQuantity units'),
});

export const getRatesOutput = z.object({
    requestedDate: z.string(),
    effectiveDate: z.string().describe('Date the returned rates are valid from, as published by NBG'),
    isFallback: z.boolean().describe('true when NBG had no rate for requestedDate and returned the last published one'),
    publishedAt: z.string(),
    rates: z.array(rateEntry),
    unknownCodes: z.array(z.string()),
});

export const convertOutput = z.object({
    amount: z.number(),
    from: z.string(),
    to: z.string(),
    result: z.number().describe('Unrounded'),
    rate: z.number().describe('One unit of "from" expressed in "to"'),
    via: z.enum(['direct', 'GEL']),
    requestedDate: z.string(),
    effectiveDate: z.string(),
    isFallback: z.boolean(),
});

export const listCurrenciesOutput = z.object({
    effectiveDate: z.string(),
    currencies: z.array(z.object({ code: z.string(), name: z.string(), nbgQuantity: z.number() })),
});

export const rateHistoryOutput = z.object({
    currency: z.string(),
    from: z.string(),
    to: z.string(),
    days: z.array(
        z.object({
            date: z.string(),
            effectiveDate: z.string(),
            rate: z.number(),
            diff: z.number(),
            isFallback: z.boolean(),
        }),
    ),
});
```

- [ ] **Step 2: Write the failing unit test `src/shell/server.test.ts`** (covers `describeError` and the server's tool list through an in-memory transport)

```ts
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { parseCalendarDate } from '../core/dates.js';
import { err, ok, type CalendarDate, type RatesError } from '../core/types.js';
import type { RatesService } from './rates-service.js';
import { createServer, describeError } from './server.js';

function date(value: string): CalendarDate {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

const stubService: RatesService = {
    getSnapshot: () =>
        Promise.resolve(
            ok({
                requestedDate: date('2026-10-07'),
                effectiveDate: date('2026-10-07'),
                isFallback: false,
                publishedAt: '2026-10-06T17:01:10.327Z',
                rates: [],
                unknownCodes: [],
            }),
        ),
    getHistory: () => Promise.resolve(err({ kind: 'upstream_unavailable', detail: 'stub' })),
};

describe('describeError', () => {
    it('gives an actionable sentence for every variant', () => {
        const cases: ReadonlyArray<[RatesError, RegExp]> = [
            [{ kind: 'invalid_date', value: '2026-02-30', reason: 'not a real calendar date' }, /2026-02-30.*YYYY-MM-DD/],
            [{ kind: 'range_too_long', days: 400, max: 366 }, /400.*366/],
            [{ kind: 'unknown_currency', code: 'XXX' }, /XXX.*nbg_list_currencies/],
            [{ kind: 'no_data_for_date', date: date('1999-06-01') }, /1999-06-01.*2000/],
            [{ kind: 'upstream_unavailable', detail: 'HTTP 503' }, /503.*retried/],
            [{ kind: 'upstream_shape_changed', detail: 'currencies: expected array' }, /currencies.*issues/],
        ];
        for (const [error, pattern] of cases) {
            expect(describeError(error)).toMatch(pattern);
        }
    });
});

describe('createServer', () => {
    it('registers the four nbg_ tools and the rates resource', async () => {
        const server = createServer({ service: stubService, now: () => new Date('2026-10-08T06:00:00Z'), version: '0.0.0-test' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: 'test', version: '0.0.0' });
        await client.connect(clientTransport);

        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'nbg_convert',
            'nbg_get_rates',
            'nbg_list_currencies',
            'nbg_rate_history',
        ]);
        for (const tool of tools) {
            expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
            expect(tool.outputSchema).toBeDefined();
        }

        const { resourceTemplates } = await client.listResourceTemplates();
        expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual(['nbg://rates/{date}']);
        const { resources } = await client.listResources();
        expect(resources.map((resource) => resource.uri)).toEqual(['nbg://rates/today']);

        await client.close();
    });

    it('returns an isError result with the error sentence for an impossible date', async () => {
        const server = createServer({ service: stubService, now: () => new Date(), version: '0.0.0-test' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({ name: 'test', version: '0.0.0' });
        await client.connect(clientTransport);

        const result = await client.callTool({ name: 'nbg_get_rates', arguments: { date: '2026-02-30' } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('2026-02-30');
        await client.close();
    });
});
```

If `InMemoryTransport` is not exported from `@modelcontextprotocol/server` in the installed version, import it from `@modelcontextprotocol/core` (add it as a dev dependency with the same version). The export list of 2.3.1 includes it under the server package.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/shell/server.test.ts`
Expected: FAIL, cannot find module `./server.js`.

- [ ] **Step 4: Write `src/shell/server.ts`**

```ts
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { convertAmount } from '../core/convert.js';
import { GEL, parseCurrencyCode } from '../core/currency-code.js';
import { TBILISI_TIME_ZONE, parseCalendarDate, todayIn } from '../core/dates.js';
import { ok, type CalendarDate, type CurrencyCode, type RatesError, type RatesSnapshot, type Result } from '../core/types.js';
import type { RatesService } from './rates-service.js';
import {
    convertInput,
    convertOutput,
    getRatesInput,
    getRatesOutput,
    listCurrenciesInput,
    listCurrenciesOutput,
    rateHistoryInput,
    rateHistoryOutput,
} from './tool-schemas.js';

export interface ServerDeps {
    readonly service: RatesService;
    readonly now: () => Date;
    readonly version: string;
}

const ISSUES_URL = 'https://github.com/akalongman/nbg-rates-mcp/issues';

export function describeError(error: RatesError): string {
    switch (error.kind) {
        case 'invalid_date':
            return `${error.value} is not a valid calendar date (${error.reason}); use YYYY-MM-DD.`;
        case 'range_too_long':
            return `The range covers ${error.days} days; the maximum is ${error.max}. Split it into shorter ranges.`;
        case 'unknown_currency':
            return `Unknown currency ${error.code}; call nbg_list_currencies for the supported codes.`;
        case 'no_data_for_date':
            return `NBG has no rates for ${error.date}; the archive starts in 2000.`;
        case 'upstream_unavailable':
            return `NBG did not respond (${error.detail}). The request can be retried.`;
        case 'upstream_shape_changed':
            return `The NBG response did not match the expected shape (${error.detail}). Please report this at ${ISSUES_URL} with the package version; the NBG endpoint may have changed.`;
        default: {
            const exhaustive: never = error;
            return exhaustive;
        }
    }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function failure(error: RatesError) {
    return { content: [{ type: 'text' as const, text: describeError(error) }], isError: true };
}

function success<T extends Record<string, unknown>>(output: T) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
}

function resolveDate(input: string | undefined, now: Date): Result<CalendarDate, RatesError> {
    return input === undefined ? ok(todayIn(TBILISI_TIME_ZONE, now)) : parseCalendarDate(input);
}

function parseCodes(inputs: ReadonlyArray<string>): Result<CurrencyCode[], RatesError> {
    const codes: CurrencyCode[] = [];
    for (const input of inputs) {
        const parsed = parseCurrencyCode(input);
        if (!parsed.ok) {
            return parsed;
        }
        codes.push(parsed.value);
    }
    return ok(codes);
}

function snapshotOutput(snapshot: RatesSnapshot) {
    return {
        requestedDate: snapshot.requestedDate,
        effectiveDate: snapshot.effectiveDate,
        isFallback: snapshot.isFallback,
        publishedAt: snapshot.publishedAt,
        rates: snapshot.rates.map((entry) => ({ ...entry })),
        unknownCodes: [...snapshot.unknownCodes],
    };
}

export function createServer(deps: ServerDeps): McpServer {
    const server = new McpServer({ name: 'nbg-rates-mcp', version: deps.version });

    server.registerTool(
        'nbg_get_rates',
        {
            title: 'NBG rates for a date',
            description:
                'Official National Bank of Georgia (NBG) exchange rates of the Georgian lari (GEL) for one calendar date. ' +
                'Every rate is GEL per ONE unit of the currency (NBG itself quotes some currencies per 10, 100, 1000 or 10000 units; ' +
                'the raw pair is returned as nbgQuantity and nbgRate). Dates are calendar days in Tbilisi; the default is today. ' +
                'NBG publishes the next day\'s rate around 17:00 Tbilisi time, so tomorrow can be requested by date in the evening. ' +
                'Weekends, holidays and future dates have no rate of their own: the last published rate is returned with isFallback true ' +
                'and effectiveDate set to the day it was published for. Always quote effectiveDate when isFallback is true.',
            inputSchema: getRatesInput,
            outputSchema: getRatesOutput,
            annotations: READ_ONLY,
        },
        async ({ date, currencies, language }) => {
            const resolved = resolveDate(date, deps.now());
            if (!resolved.ok) {
                return failure(resolved.error);
            }
            const codes = currencies === undefined ? undefined : parseCodes(currencies);
            if (codes !== undefined && !codes.ok) {
                return failure(codes.error);
            }
            const snapshot = await deps.service.getSnapshot({
                date: resolved.value,
                language: language ?? 'en',
                ...(codes === undefined ? {} : { codes: codes.value }),
            });
            return snapshot.ok ? success(snapshotOutput(snapshot.value)) : failure(snapshot.error);
        },
    );

    server.registerTool(
        'nbg_convert',
        {
            title: 'Convert via NBG rate',
            description:
                'Converts an amount between two currencies using the official NBG rate for a calendar date (default today in Tbilisi). ' +
                'Either side may be GEL; a pair without GEL is converted through GEL (via: "GEL"). ' +
                'The result is unrounded: round it for display. Quote effectiveDate when isFallback is true.',
            inputSchema: convertInput,
            outputSchema: convertOutput,
            annotations: READ_ONLY,
        },
        async ({ amount, from, to, date }) => {
            const resolved = resolveDate(date, deps.now());
            if (!resolved.ok) {
                return failure(resolved.error);
            }
            const fromCode = parseCurrencyCode(from);
            if (!fromCode.ok) {
                return failure(fromCode.error);
            }
            const toCode = parseCurrencyCode(to);
            if (!toCode.ok) {
                return failure(toCode.error);
            }
            if (fromCode.value === GEL && toCode.value === GEL) {
                return success({
                    amount,
                    from: GEL,
                    to: GEL,
                    result: amount,
                    rate: 1,
                    via: 'direct' as const,
                    requestedDate: resolved.value,
                    effectiveDate: resolved.value,
                    isFallback: false,
                });
            }
            const snapshot = await deps.service.getSnapshot({ date: resolved.value, language: 'en' });
            if (!snapshot.ok) {
                return failure(snapshot.error);
            }
            const conversion = convertAmount(snapshot.value, amount, fromCode.value, toCode.value);
            return conversion.ok ? success({ ...conversion.value }) : failure(conversion.error);
        },
    );

    server.registerTool(
        'nbg_list_currencies',
        {
            title: 'NBG currency list',
            description:
                'Lists every currency NBG publishes a GEL rate for today, with its name and the unit quantity NBG quotes it in. ' +
                'Use it to check a code before calling the other tools.',
            inputSchema: listCurrenciesInput,
            outputSchema: listCurrenciesOutput,
            annotations: READ_ONLY,
        },
        async ({ language }) => {
            const snapshot = await deps.service.getSnapshot({
                date: todayIn(TBILISI_TIME_ZONE, deps.now()),
                language: language ?? 'en',
            });
            if (!snapshot.ok) {
                return failure(snapshot.error);
            }
            return success({
                effectiveDate: snapshot.value.effectiveDate,
                currencies: snapshot.value.rates.map(({ code, name, nbgQuantity }) => ({ code, name, nbgQuantity })),
            });
        },
    );

    server.registerTool(
        'nbg_rate_history',
        {
            title: 'NBG rate history',
            description:
                'Official NBG rate of one currency (GEL per one unit) for every calendar day in an inclusive range of at most 366 days. ' +
                'Weekend and holiday days carry the last published rate with isFallback true. ' +
                'The first call fetches one NBG table per day (about 100 to 350 ms each, six in parallel); repeated ranges are served from cache.',
            inputSchema: rateHistoryInput,
            outputSchema: rateHistoryOutput,
            annotations: READ_ONLY,
        },
        async ({ currency, from, to, language }) => {
            const code = parseCurrencyCode(currency);
            if (!code.ok) {
                return failure(code.error);
            }
            const fromDate = parseCalendarDate(from);
            if (!fromDate.ok) {
                return failure(fromDate.error);
            }
            const toDate = parseCalendarDate(to);
            if (!toDate.ok) {
                return failure(toDate.error);
            }
            const history = await deps.service.getHistory({
                currency: code.value,
                from: fromDate.value,
                to: toDate.value,
                language: language ?? 'en',
            });
            if (!history.ok) {
                return failure(history.error);
            }
            return success({ ...history.value, days: history.value.days.map((point) => ({ ...point })) });
        },
    );

    server.registerResource(
        'nbg-rates',
        new ResourceTemplate('nbg://rates/{date}', {
            list: () =>
                Promise.resolve({
                    resources: [{ uri: 'nbg://rates/today', name: "Today's NBG rates", mimeType: 'application/json' }],
                }),
        }),
        {
            title: 'NBG rates by date',
            description: 'Full official NBG rate table for a calendar date (YYYY-MM-DD) or "today", as JSON with per-unit rates.',
            mimeType: 'application/json',
        },
        async (uri, variables) => {
            const raw = String(variables['date'] ?? 'today');
            const resolved = raw === 'today' ? ok(todayIn(TBILISI_TIME_ZONE, deps.now())) : parseCalendarDate(raw);
            if (!resolved.ok) {
                throw new Error(describeError(resolved.error));
            }
            const snapshot = await deps.service.getSnapshot({ date: resolved.value, language: 'en' });
            if (!snapshot.ok) {
                throw new Error(describeError(snapshot.error));
            }
            return {
                contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(snapshotOutput(snapshot.value)) }],
            };
        },
    );

    return server;
}
```

If the type of `variables['date']` is `string | string[]`, `String(...)` handles both; if the SDK types `structuredContent` more narrowly than `Record<string, unknown>`, loosen `success` to accept `object`.

- [ ] **Step 5: Run the unit test**

Run: `npx vitest run src/shell/server.test.ts && npm run lint && npm run typecheck`
Expected: PASS (3 tests).

- [ ] **Step 6: Write `src/bin.ts`**

```ts
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createSnapshotCache } from './shell/cache.js';
import { createNbgClient } from './shell/nbg-client.js';
import { createRatesService } from './shell/rates-service.js';
import { createServer } from './shell/server.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const HELP = `nbg-rates-mcp ${version}
MCP server (stdio) for official National Bank of Georgia exchange rates.

Usage: nbg-rates-mcp [--version] [--help]

Environment:
  NBG_RATES_BASE_URL  Override the NBG host (default https://nbg.gov.ge)
  NBG_RATES_DEBUG=1   Log every upstream request to stderr
`;

function main(): void {
    const args = process.argv.slice(2);
    if (args.includes('--version') || args.includes('-v')) {
        process.stdout.write(`${version}\n`);
        return;
    }
    if (args.includes('--help') || args.includes('-h')) {
        process.stdout.write(HELP);
        return;
    }

    const baseUrl = (process.env['NBG_RATES_BASE_URL'] ?? 'https://nbg.gov.ge').replace(/\/+$/, '');
    const debug = process.env['NBG_RATES_DEBUG'] === '1';
    const client = createNbgClient({
        baseUrl,
        userAgent: `nbg-rates-mcp/${version} (+https://github.com/akalongman/nbg-rates-mcp)`,
        ...(debug ? { log: (message: string) => console.error(`[nbg-rates-mcp] ${message}`) } : {}),
    });
    const service = createRatesService({ client, cache: createSnapshotCache(), now: () => new Date() });

    void serveStdio(() => createServer({ service, now: () => new Date(), version }));
    console.error(`nbg-rates-mcp ${version} serving on stdio (upstream ${baseUrl})`);
}

main();
```

- [ ] **Step 7: Build and check the binary runs**

Run: `npm run build && node dist/bin.js --version && head -1 dist/bin.js`
Expected: prints `0.1.0`; the first line of `dist/bin.js` is the shebang (tsc preserves it).

- [ ] **Step 8: Write the end-to-end test `test/e2e/stdio.test.ts`**

```ts
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'bin.js');

function childEnv(baseUrl: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
            env[key] = value;
        }
    }
    env['NBG_RATES_BASE_URL'] = baseUrl;
    env['TZ'] = 'America/Los_Angeles';
    return env;
}

describe('nbg-rates-mcp over stdio', () => {
    let server: FixtureServer;
    let client: Client;

    beforeAll(async () => {
        server = await startFixtureServer();
        client = new Client({ name: 'e2e', version: '0.0.0' });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: childEnv(server.baseUrl) }));
    });

    afterAll(async () => {
        await client.close();
        await server.close();
    });

    it('lists the tools', async () => {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual(['nbg_convert', 'nbg_get_rates', 'nbg_list_currencies', 'nbg_rate_history']);
    });

    it('returns a Sunday request as a flagged fallback with per-unit rates, even in a US time zone', async () => {
        const result = await client.callTool({ name: 'nbg_get_rates', arguments: { date: '2026-10-04', currencies: ['usd', 'amd'] } });
        expect(result.isError).toBeFalsy();
        const output = result.structuredContent as {
            requestedDate: string;
            effectiveDate: string;
            isFallback: boolean;
            rates: Array<{ code: string; rate: number; nbgQuantity: number; nbgRate: number }>;
        };
        expect(output.requestedDate).toBe('2026-10-04');
        expect(output.effectiveDate).toBe('2026-10-03');
        expect(output.isFallback).toBe(true);
        const amd = output.rates.find((entry) => entry.code === 'AMD');
        expect(amd?.nbgQuantity).toBe(1000);
        expect(amd?.rate).toBe(Number((Number(amd?.nbgRate) / 1000).toFixed(7)));
    });

    it('never claims a rate for a far-future date', async () => {
        const result = await client.callTool({ name: 'nbg_get_rates', arguments: { date: '2099-01-01', currencies: ['USD'] } });
        const output = result.structuredContent as { effectiveDate: string; isFallback: boolean };
        expect(output.isFallback).toBe(true);
        expect(output.effectiveDate).toBe('2026-10-07');
    });

    it('converts USD to EUR through GEL', async () => {
        const result = await client.callTool({ name: 'nbg_convert', arguments: { amount: 100, from: 'USD', to: 'EUR', date: '2026-10-07' } });
        const output = result.structuredContent as { via: string; result: number; rate: number };
        expect(output.via).toBe('GEL');
        expect(output.result).toBeCloseTo(100 * output.rate, 9);
    });

    it('lists currencies', async () => {
        const result = await client.callTool({ name: 'nbg_list_currencies', arguments: {} });
        const output = result.structuredContent as { currencies: Array<{ code: string }> };
        expect(output.currencies.length).toBeGreaterThan(30);
        expect(output.currencies.some((entry) => entry.code === 'USD')).toBe(true);
    });

    it('returns one history point per calendar day', async () => {
        const result = await client.callTool({
            name: 'nbg_rate_history',
            arguments: { currency: 'USD', from: '2026-10-01', to: '2026-10-07' },
        });
        const output = result.structuredContent as { days: Array<{ date: string; isFallback: boolean }> };
        expect(output.days).toHaveLength(7);
        expect(output.days.filter((point) => point.isFallback).map((point) => point.date)).toEqual(['2026-10-04']);
    });

    it('converts GEL to GEL without calling NBG', async () => {
        const before = server.requests.length;
        const result = await client.callTool({ name: 'nbg_convert', arguments: { amount: 5, from: 'GEL', to: 'gel' } });
        expect(result.structuredContent).toMatchObject({ result: 5, rate: 1, via: 'direct', isFallback: false });
        expect(server.requests.length).toBe(before);
    });

    it('reports an impossible date as a tool error, without calling NBG', async () => {
        const before = server.requests.length;
        const result = await client.callTool({ name: 'nbg_convert', arguments: { amount: 1, from: 'USD', to: 'EUR', date: '2026-02-30' } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('2026-02-30');
        expect(server.requests.length).toBe(before);
    });

    it('serves the today resource', async () => {
        const { resources } = await client.listResources();
        expect(resources.map((resource) => resource.uri)).toEqual(['nbg://rates/today']);
        const { contents } = await client.readResource({ uri: 'nbg://rates/2026-10-07' });
        const text = contents[0] !== undefined && 'text' in contents[0] ? String(contents[0].text) : '';
        expect(JSON.parse(text)).toMatchObject({ effectiveDate: '2026-10-07', isFallback: false });
    });
});
```

- [ ] **Step 9: Run the end-to-end test and the full suite**

Run: `npm run test:e2e && npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all PASS. If a request appears in `server.requests` for the impossible-date case, date validation is happening after the fetch; fix `resolveDate` ordering in the handler.

- [ ] **Step 10: Commit and verify CI**

```bash
git add src/shell/tool-schemas.ts src/shell/server.ts src/shell/server.test.ts src/bin.ts test/e2e/stdio.test.ts
git commit -m "Add the MCP server, binary and end-to-end test" -- src/shell/tool-schemas.ts src/shell/server.ts src/shell/server.test.ts src/bin.ts test/e2e/stdio.test.ts
git push origin main
gh run watch --exit-status
```

Expected: the CI workflow from Task 1 is green on both Node versions. This is the exit criterion for this task.


### Task 11: Live contract test, scheduled drift alarm, Dependabot and issue template

**Files:**
- Create: `test/contract/nbg-live.test.ts`, `.github/workflows/contract.yml`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/bug_report.md`

**Interfaces:**
- Consumes: `createNbgClient` (Task 7), `createSnapshotCache` (Task 8), `createRatesService` (Task 9), `parseNbgResponse` (Task 3), core date helpers (Task 2).
- Produces: `npm run test:contract`, which is the only code path in CI that reaches nbg.gov.ge.

- [ ] **Step 1: Write `test/contract/nbg-live.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { parseCurrencyCode } from '../../src/core/currency-code.js';
import { TBILISI_TIME_ZONE, addDays, parseCalendarDate, todayIn } from '../../src/core/dates.js';
import type { CalendarDate, CurrencyCode } from '../../src/core/types.js';
import { createSnapshotCache } from '../../src/shell/cache.js';
import { createNbgClient } from '../../src/shell/nbg-client.js';
import { createRatesService } from '../../src/shell/rates-service.js';

const LIVE = process.env['NBG_LIVE'] === '1';

function date(value: string): CalendarDate {
    const parsed = parseCalendarDate(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

function code(value: string): CurrencyCode {
    const parsed = parseCurrencyCode(value);
    if (!parsed.ok) {
        throw new Error(value);
    }
    return parsed.value;
}

const statuses: number[] = [];
const client = createNbgClient({
    baseUrl: process.env['NBG_RATES_BASE_URL'] ?? 'https://nbg.gov.ge',
    userAgent: 'nbg-rates-mcp/contract-test (+https://github.com/akalongman/nbg-rates-mcp)',
    log: (line) => {
        const match = /-> (\d{3}) in/.exec(line);
        if (match !== null) {
            statuses.push(Number(match[1]));
        }
    },
});
const service = createRatesService({ client, cache: createSnapshotCache(), now: () => new Date() });

describe.skipIf(!LIVE)('nbg.gov.ge contract', () => {
    it('serves today with USD and power-of-ten quantities', async () => {
        const today = todayIn(TBILISI_TIME_ZONE, new Date());
        const result = await service.getSnapshot({ date: today, language: 'en' });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) {
            expect(result.value.rates.length).toBeGreaterThan(30);
            expect(result.value.rates.some((entry) => entry.code === 'USD')).toBe(true);
            for (const entry of result.value.rates) {
                expect([1, 10, 100, 1000, 10000], entry.code).toContain(entry.nbgQuantity);
                expect(Number.isFinite(entry.rate)).toBe(true);
            }
        }
    });

    it('flags a known Sunday as a fallback to the Saturday table', async () => {
        const result = await service.getSnapshot({ date: date('2026-10-04'), language: 'en', codes: [code('USD')] });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.isFallback).toBe(true);
            expect(result.value.effectiveDate).toBe('2026-10-03');
        }
    });

    it('serves the 2005 archive and parses rows without validFromDate', async () => {
        const result = await service.getSnapshot({ date: date('2005-03-15'), language: 'en', codes: [code('USD')] });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) {
            expect(result.value.effectiveDate).toBe('2005-03-15');
        }
    });

    it('reports no data before the archive', async () => {
        const result = await service.getSnapshot({ date: date('1995-01-01'), language: 'en' });
        expect(result).toEqual({ ok: false, error: { kind: 'no_data_for_date', date: '1995-01-01' } });
    });

    it('serves Georgian names', async () => {
        const result = await service.getSnapshot({ date: date('2026-10-07'), language: 'ka', codes: [code('USD')] });
        expect(result.ok && result.value.rates[0]?.name).not.toBe('US Dollar');
    });

    it('fetches a full year at concurrency 6 and records whether NBG ever answered 429', async () => {
        const to = addDays(todayIn(TBILISI_TIME_ZONE, new Date()), -1);
        const from = addDays(to, -365);
        const started = Date.now();
        const result = await service.getHistory({ currency: code('USD'), from, to, language: 'en' });
        const seconds = Math.round((Date.now() - started) / 1000);
        const throttled = statuses.filter((status) => status === 429).length;
        console.error(`[contract] 366-day history: ok=${result.ok} in ${seconds}s, HTTP 429 seen ${throttled} times`);
        expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(true);
        if (result.ok) {
            expect(result.value.days).toHaveLength(366);
        }
        expect(throttled, 'NBG throttled the fan-out; lower the concurrency cap').toBe(0);
    }, 120_000);
});
```

- [ ] **Step 2: Run it live once**

Run: `npm run test:contract`
Expected: PASS (6 tests). Note the printed duration and 429 count in the task report; the spec's maintenance section depends on these numbers. If the year fetch sees any 429, stop and report instead of lowering the cap silently.

- [ ] **Step 3: Write `.github/workflows/contract.yml`**

```yaml
name: NBG contract

on:
  schedule:
    - cron: '17 6 * * 1'
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  live:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - id: contract
        run: npm run test:contract
        continue-on-error: true
      - name: Open or update the drift issue
        if: steps.contract.outcome == 'failure'
        env:
          GH_TOKEN: ${{ github.token }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          title="NBG contract test failed"
          existing=$(gh issue list --state open --search "\"$title\" in:title" --json number --jq '.[0].number')
          body="The weekly live test against nbg.gov.ge failed on $(date -u +%F). Run: $RUN_URL. Check whether the endpoint shape or behaviour changed; refresh fixtures with npm run record-fixtures and compare."
          if [ -n "$existing" ]; then
            gh issue comment "$existing" --body "$body"
          else
            gh issue create --title "$title" --label upstream --body "$body"
          fi
      - name: Fail the job if the contract failed
        if: steps.contract.outcome == 'failure'
        run: exit 1
```

Create the `upstream` label once: `gh label create upstream --description "nbg.gov.ge changed" --color D93F0B`.

- [ ] **Step 4: Write `.github/dependabot.yml` and `.github/ISSUE_TEMPLATE/bug_report.md`**

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      minor-and-patch:
        update-types: [minor, patch]
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

`.github/ISSUE_TEMPLATE/bug_report.md`:

```markdown
---
name: Bug report
about: Something returned the wrong rate, an error, or nothing
---

**Package version** (`npx -y nbg-rates-mcp --version`):

**Client** (Claude Code, Claude Desktop, Cursor, other) and OS:

**What you asked and what came back**

**Debug log**

Run the server once with `NBG_RATES_DEBUG=1` in its environment, repeat the request, and paste the `[nbg-rates-mcp]` lines from the client's MCP log here.
```

- [ ] **Step 5: Validate the workflow files and commit**

Run: `npx prettier --check .github && npm run lint`
Expected: clean. Then:

```bash
git add test/contract/nbg-live.test.ts .github/workflows/contract.yml .github/dependabot.yml .github/ISSUE_TEMPLATE/bug_report.md
git commit -m "Add the live contract test, drift alarm and Dependabot" -- test/contract/nbg-live.test.ts .github/workflows/contract.yml .github/dependabot.yml .github/ISSUE_TEMPLATE/bug_report.md
git push origin main
gh workflow run contract.yml && sleep 20 && gh run list --workflow contract.yml --limit 1
```

Expected: the manual dispatch runs and finishes green. Watch it with `gh run watch --exit-status`.

### Task 12: README, changelog, registry manifest, MCPB bundle and release workflow

**Files:**
- Create: `README.md`, `CHANGELOG.md`, `server.json`, `manifest.json`, `.mcpbignore`, `.github/workflows/release.yml`, `scripts/build-bundle.sh`

**Interfaces:**
- Consumes: the built `dist/` from Task 10 and the tool names and descriptions it registers.
- Produces: the publishable 0.1.0 package, a registry manifest, and a bundle that installs in Claude Desktop.

- [ ] **Step 1: Write `README.md`**

The README is agent-neutral and contains no em or en dashes. Sections, in order, with this content:

1. **Title and one paragraph**: `nbg-rates-mcp` gives AI agents the official National Bank of Georgia (NBG) exchange rates of the lari (GEL). It runs locally over stdio, needs no account and no key, and encodes the rules a raw call gets wrong: per-unit values, Tbilisi calendar days, and an explicit flag when a weekend, holiday or future date is answered with the last published rate. Then a disclaimer: this is an independent open-source project, not affiliated with NBG; NBG's website is the source of truth; the endpoint is undocumented and may change.
2. **Install**. Three subsections.
   - Claude Code: `claude mcp add nbg-rates -- npx -y nbg-rates-mcp` and the `--scope user` variant.
   - Claude Desktop: on macOS and Windows, download `nbg-rates-mcp-<version>.mcpb` from the latest GitHub release and open it. Elsewhere, or by hand, add to `claude_desktop_config.json`:
     ```json
     { "mcpServers": { "nbg-rates": { "command": "npx", "args": ["-y", "nbg-rates-mcp"] } } }
     ```
   - Cursor and other clients: the same JSON under the client's MCP settings.
   - A "Node.js" note: `npx` needs Node 22 or later. Install commands for macOS (`brew install node`), Debian and Ubuntu (NodeSource setup script for Node 22, with the apt lines), another Linux fallback (nvm one-liner), Windows PowerShell (`winget install OpenJS.NodeJS.LTS`), and WSL (same as Debian and Ubuntu).
3. **Tools**. One subsection per tool with its inputs, output fields, and the Sunday worked example from the spec for `nbg_get_rates` (request date 2026-10-04 and currency AMD; show the JSON with `effectiveDate` 2026-10-03, `isFallback` true, `rate` 0.0071748, `nbgQuantity` 1000, `nbgRate` 7.1748). Also document the resource `nbg://rates/{date}`.
4. **Date rules**. Four bullets: rates are set around 17:00 Tbilisi and valid from the next calendar day; "today" means the calendar date in Tbilisi; weekends, holidays and future dates return the last published rate with `isFallback: true`; the archive starts in 2000.
5. **Environment variables**: `NBG_RATES_BASE_URL`, `NBG_RATES_DEBUG`.
6. **Development**: `npm install`, `npm test`, `npm run test:e2e`, `npm run test:contract` (live), `npm run record-fixtures` (refresh fixtures, then review the diff), and the layout `src/core` (pure) and `src/shell` (effects).
7. **License**: MIT.

- [ ] **Step 2: Write `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and the project uses semantic versioning.

## 0.1.0 - 2026-10-XX

Initial release: `nbg_get_rates`, `nbg_convert`, `nbg_list_currencies`, `nbg_rate_history`, the `nbg://rates/{date}` resource, per-unit normalisation, Tbilisi date semantics, fallback flag, in-memory cache, live contract test.
```

Replace `XX` with the actual release day when publishing.

- [ ] **Step 3: Write `server.json`** (registry manifest, npm package only)

```json
{
    "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    "name": "io.github.akalongman/nbg-rates",
    "title": "NBG Rates (National Bank of Georgia)",
    "description": "Official National Bank of Georgia GEL exchange rates with per-unit values and date semantics",
    "websiteUrl": "https://github.com/akalongman/nbg-rates-mcp",
    "repository": {
        "url": "https://github.com/akalongman/nbg-rates-mcp",
        "source": "github"
    },
    "version": "0.1.0",
    "packages": [
        {
            "registryType": "npm",
            "registryBaseUrl": "https://registry.npmjs.org",
            "identifier": "nbg-rates-mcp",
            "version": "0.1.0",
            "runtimeHint": "npx",
            "transport": { "type": "stdio" }
        }
    ]
}
```

The description must stay under 100 characters (the registry limit); the one above is 93.

- [ ] **Step 4: Write `manifest.json`, `.mcpbignore` and `scripts/build-bundle.sh`**

Before writing, open `https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md` and confirm the current `manifest_version` for a `node` server (0.3 at planning time) and the field names below. Adjust if the spec moved.

`manifest.json`:

```json
{
    "manifest_version": "0.3",
    "name": "nbg-rates-mcp",
    "display_name": "NBG Rates (National Bank of Georgia)",
    "version": "0.1.0",
    "description": "Official National Bank of Georgia GEL exchange rates with per-unit values and date semantics",
    "author": { "name": "Avtandil Kikabidze", "url": "https://github.com/akalongman" },
    "repository": { "type": "git", "url": "https://github.com/akalongman/nbg-rates-mcp" },
    "license": "MIT",
    "keywords": ["nbg", "georgia", "gel", "lari", "exchange-rates", "currency"],
    "server": {
        "type": "node",
        "entry_point": "dist/bin.js",
        "mcp_config": {
            "command": "node",
            "args": ["${__dirname}/dist/bin.js"],
            "env": {}
        }
    },
    "tools": [
        { "name": "nbg_get_rates", "description": "Official NBG rates for a calendar date, per one unit, with fallback flag" },
        { "name": "nbg_convert", "description": "Convert an amount using the official NBG rate for a date" },
        { "name": "nbg_list_currencies", "description": "Currencies NBG publishes a GEL rate for" },
        { "name": "nbg_rate_history", "description": "One currency's official rate for every calendar day in a range" }
    ],
    "compatibility": {
        "claude_desktop": ">=1.0.0",
        "platforms": ["darwin", "win32"],
        "runtimes": { "node": ">=22.0.0" }
    }
}
```

`.mcpbignore`:

```
src/
test/
scripts/
docs/
.github/
eslint.config.js
tsconfig*.json
vitest.config.ts
.prettierrc
.editorconfig
server.json
*.test.*
```

`scripts/build-bundle.sh` (builds into a clean `bundle/` directory so dev dependencies never enter the archive):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
rm -rf bundle
mkdir -p bundle
npm run build
cp -r dist package.json package-lock.json README.md LICENSE CHANGELOG.md manifest.json .mcpbignore bundle/
(cd bundle && npm ci --omit=dev --ignore-scripts)
npx --yes @anthropic-ai/mcpb validate bundle/manifest.json
npx --yes @anthropic-ai/mcpb pack bundle "nbg-rates-mcp-${version}.mcpb"
echo "built nbg-rates-mcp-${version}.mcpb"
```

Run: `chmod +x scripts/build-bundle.sh && bash -n scripts/build-bundle.sh && ./scripts/build-bundle.sh && unzip -l nbg-rates-mcp-0.1.0.mcpb | head -20`
Expected: validation passes; the listing shows `manifest.json`, `dist/bin.js`, `node_modules/@modelcontextprotocol/server/...` and `node_modules/zod/...`, and no `src/` or `test/`.

- [ ] **Step 5: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write
  id-token: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - run: npm run typecheck && npm run lint && npm test && npm run test:e2e
      - name: Check that the tag matches package.json, server.json and manifest.json
        run: |
          tag="${GITHUB_REF_NAME#v}"
          for file in package.json server.json manifest.json; do
            v=$(node -p "require('./$file').version")
            [ "$v" = "$tag" ] || { echo "$file has $v, tag is $tag"; exit 1; }
          done
      - name: Publish to npm (trusted publishing, provenance automatic)
        run: npm publish --access public
      - name: Build the MCPB bundle
        run: ./scripts/build-bundle.sh
      - name: Create the GitHub release with the bundle
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" nbg-rates-mcp-*.mcpb --title "$GITHUB_REF_NAME" --notes-file CHANGELOG.md
      - name: Publish to the MCP registry
        run: |
          curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
          ./mcp-publisher login github-oidc
          ./mcp-publisher publish
```

- [ ] **Step 6: Run the full local verification and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e && npm pack --dry-run`
Expected: all green; the pack listing contains only `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`.

```bash
git add README.md CHANGELOG.md server.json manifest.json .mcpbignore scripts/build-bundle.sh .github/workflows/release.yml
git commit -m "Add README, registry manifest, MCPB bundle and release workflow" -- README.md CHANGELOG.md server.json manifest.json .mcpbignore scripts/build-bundle.sh .github/workflows/release.yml
git push origin main
```

- [ ] **Step 7: First publish, by hand (trusted publishing cannot be configured before the package exists)**

These steps are run by the maintainer, not by an agent, because they need an npm OTP and account settings:

1. `npm login` if needed, then from a clean checkout on `main`: `npm publish --access public` (enter the OTP). Verify with `npm view nbg-rates-mcp version` printing `0.1.0`.
2. On npmjs.com, open the package, Settings, Trusted Publisher: GitHub Actions, repository `akalongman/nbg-rates-mcp`, workflow `release.yml`. The configuration expires if no publish happens within two days.
3. Publish 0.1.0 to the registry once by hand so the namespace is claimed: `brew install mcp-publisher` (or download the Linux binary with the curl line from `release.yml`), then `mcp-publisher login github` and `mcp-publisher publish`. Verify: `curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=nbg" | head -c 400`.
4. Smoke-test the published package in a client: `claude mcp add nbg-rates -- npx -y nbg-rates-mcp`, then ask for the USD rate on 2026-10-04 and confirm the answer mentions the fallback to 2026-10-03.
5. Bump to `0.1.1` in `package.json`, `server.json`, `manifest.json` and `CHANGELOG.md`, commit, tag `v0.1.1`, push the tag within two days of step 2, and watch `release.yml` publish through trusted publishing, build the bundle, create the GitHub release, and publish to the registry. Download the `.mcpb` from the release and open it in Claude Desktop on macOS or Windows to confirm it installs and answers.

