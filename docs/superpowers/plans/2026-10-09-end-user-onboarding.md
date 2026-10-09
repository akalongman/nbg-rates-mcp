# nbg-rates-mcp 0.3.0 End-User Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 0.3.0 with four server prompts, an icon and long description in the Claude Desktop bundle, a stable bundle download link with install steps in every release, repository topics and homepage defined in git, and a README that leads with what to ask and which rate applies.

**Architecture:** Prompts are data: `src/shell/prompts.ts` holds the four definitions (name, title, description, arguments, text with MCPB `${arguments.<name>}` placeholders) and a pure `renderPrompt`; `createServer` registers them in a loop, and `manifest.json` lists the same definitions verbatim, held equal by a test. Release plumbing is shell (`scripts/publish-release.sh`, new `scripts/apply-repo-settings.sh`) tested through stubbed `gh` on `PATH`, the pattern `test/scripts/publish-release.test.ts` already uses. The README is reordered, not rewritten: three new sections above Install, everything else kept.

**Tech Stack:** TypeScript 6.0, Node 22+, ESM, `@modelcontextprotocol/server` 2.3 and `@modelcontextprotocol/client` 2.3, Zod 4, Vitest 5, bash with shellcheck, `gh`, `jq`, `rsvg-convert` (librsvg) for the icon.

**Spec:** `docs/superpowers/specs/2026-10-09-end-user-onboarding-design.md` (amends `docs/superpowers/specs/2026-10-08-nbg-rates-mcp-design.md` and `docs/superpowers/specs/2026-10-09-context-efficiency-design.md`).

## Global Constraints

- Prompt names, titles, descriptions, argument lists and texts exactly as in the spec's Change 4 tables and quotations; the placeholder syntax is `${arguments.<name>}` in both `src/shell/prompts.ts` and `manifest.json`.
- Prompts pass arguments through as typed; no date or code parsing in a prompt. An absent optional argument renders as the empty string.
- Stable asset name `nbg-rates-mcp-latest.mcpb`, byte-identical to `nbg-rates-mcp-<version>.mcpb`, both on every release. The README links `https://github.com/akalongman/nbg-rates-mcp/releases/latest/download/nbg-rates-mcp-latest.mcpb`; release notes link `https://github.com/akalongman/nbg-rates-mcp/releases/download/v<version>/nbg-rates-mcp-<version>.mcpb`.
- Icon: 512x512 PNG at `assets/icon.png`, rendered from `assets/icon.svg`: rounded square `#1F3A5F`, white lari sign U+20BE in Noto Sans Bold. No flag colours, no NBG mark. Deviation from the spec, agreed with the maintainer at plan review: the renderer is `rsvg-convert` in `scripts/render-icon.sh`, not a `sharp` script, because the repository's eslint config type-checks every JavaScript file through the TypeScript project service and a loose `.mjs` under `scripts/` fails `npm run lint`. The PNG is committed; builds need no renderer.
- Repository settings: `.github/repository.json` with the description, homepage and eleven topics of the spec's Change 3, applied by `scripts/apply-repo-settings.sh`, never by hand in the GitHub UI.
- Version 0.3.0 in `package.json`, `package-lock.json` (both places `npm version` writes), `manifest.json`, both fields of `server.json`; `CHANGELOG.md` section `## 0.3.0 - 2026-10-09` with the spec's entry.
- `src/core/**` does not change. Tool inputs and outputs do not change.
- Repository rules: ESM with `.js` import extensions; strict tsconfig; 4-space indent, 120 columns, single quotes; no `any`, no `!`, `as` only at validated JSON boundaries; prose agent-neutral; no em or en dashes anywhere, including the README, the manifest and prompt texts.
- Shell: `set -euo pipefail`, `bash -n` and `shellcheck` clean.
- Commit with explicit paths in one command: `git add <paths> && git commit -m "<title>" -- <paths>`. Commits are signed by the repository's configured signing; never bypass it. Commit on `main`; never push and never tag (the maintainer tags the release).
- Gates for every task: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e && shellcheck scripts/*.sh`.

## Review Focus

1. An argument value containing `$&`, `$1` or a backslash (an amount typed as `$1,500`): `String.prototype.replace` with a string replacement would expand it. `renderPrompt` uses a replacer function. Pinned in Task 1, Step 1.
2. A client sending an omitted optional argument as an empty string instead of leaving it out (clients differ): both must render identically, and the text must still read as a sentence. Pinned in Task 1, Step 1 and Task 2, Step 1.
3. The manifest `prompts` drifting from the server after an edit to one side (Claude Desktop shows the manifest, the model gets the server's): the equality test. Pinned in Task 3, Step 1.
4. A release run interrupted after `gh release create` uploaded only one of the two assets: the completeness check must count both assets, so a re-run uploads the missing one instead of reporting the release done. Pinned in Task 4, Step 1.
5. `apply-repo-settings.sh` sending the topics payload in the wrong shape (GitHub's PUT wants `{ "names": [...] }`, not the array) or a pretty-printed multi-line body that breaks the single-line stub log: the test pins the exact compact payloads. Pinned in Task 5, Step 1.

---

### Task 1: Prompt definitions and renderer

**Files:**
- Create: `src/shell/prompts.ts`
- Create: `src/shell/prompts.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `PromptArgument { name: string; description: string; required: boolean }`, `PromptDefinition { name; title; description; arguments: ReadonlyArray<PromptArgument>; text }`, `PROMPTS: ReadonlyArray<PromptDefinition>` (four entries, in the order `nbg_rates_today`, `nbg_rate_on_date`, `nbg_convert_amount`, `nbg_monthly_rates`), `renderPrompt(text: string, args: Readonly<Record<string, string | undefined>>): string`, `promptArgsSchema(prompt: PromptDefinition): z.ZodObject<Record<string, z.ZodString | z.ZodOptional<z.ZodString>>>`.

- [ ] **Step 1: Write the failing tests**

Create `src/shell/prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PROMPTS, promptArgsSchema, renderPrompt, type PromptDefinition } from './prompts.js';

const PLACEHOLDER = /\$\{arguments\.([A-Za-z_]+)\}/g;

function placeholders(prompt: PromptDefinition): string[] {
    return [...prompt.text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

describe('renderPrompt', () => {
    it('replaces every placeholder with its argument', () => {
        expect(renderPrompt('Convert ${arguments.amount} ${arguments.from} to ${arguments.to}.', {
            amount: '1500',
            from: 'USD',
            to: 'GEL',
        })).toBe('Convert 1500 USD to GEL.');
    });

    it('renders an absent or empty optional argument as nothing, identically', () => {
        const text = 'in force on ${arguments.date} (today when no date is given)';
        expect(renderPrompt(text, {})).toBe('in force on  (today when no date is given)');
        expect(renderPrompt(text, { date: '' })).toBe('in force on  (today when no date is given)');
        expect(renderPrompt(text, { date: undefined })).toBe('in force on  (today when no date is given)');
    });

    it('inserts replacement patterns and backslashes literally', () => {
        // String.prototype.replace with a string replacement would expand $& and $1.
        expect(renderPrompt('Convert ${arguments.amount} ${arguments.from}', { amount: '$1,500 $& \\', from: 'USD' })).toBe(
            'Convert $1,500 $& \\ USD',
        );
    });
});

describe('PROMPTS', () => {
    it('defines the four prompts in menu order', () => {
        expect(PROMPTS.map((prompt) => prompt.name)).toEqual([
            'nbg_rates_today',
            'nbg_rate_on_date',
            'nbg_convert_amount',
            'nbg_monthly_rates',
        ]);
    });

    it('uses every declared argument in its text and declares every placeholder it uses', () => {
        for (const prompt of PROMPTS) {
            const declared = prompt.arguments.map((argument) => argument.name);
            expect(new Set(placeholders(prompt)), prompt.name).toEqual(new Set(declared));
        }
    });

    it('renders each text with no placeholder left when every argument is given', () => {
        for (const prompt of PROMPTS) {
            const args = Object.fromEntries(prompt.arguments.map((argument) => [argument.name, 'X']));
            expect(renderPrompt(prompt.text, args), prompt.name).not.toContain('${arguments.');
        }
    });

    it('names each tool it asks the model to call', () => {
        const tools: Record<string, string> = {
            nbg_rates_today: 'nbg_get_rates',
            nbg_rate_on_date: 'nbg_get_rates',
            nbg_convert_amount: 'nbg_convert',
            nbg_monthly_rates: 'nbg_rate_history',
        };
        for (const prompt of PROMPTS) {
            expect(prompt.text, prompt.name).toContain(tools[prompt.name] ?? 'missing');
        }
    });

    it('marks only the optional arguments optional', () => {
        const optional = PROMPTS.flatMap((prompt) =>
            prompt.arguments.filter((argument) => !argument.required).map((argument) => `${prompt.name}.${argument.name}`),
        );
        expect(optional).toEqual(['nbg_rates_today.currencies', 'nbg_convert_amount.date']);
    });
});

describe('promptArgsSchema', () => {
    it('requires exactly the required arguments and describes each one', () => {
        const convert = PROMPTS.find((prompt) => prompt.name === 'nbg_convert_amount');
        if (convert === undefined) {
            throw new Error('nbg_convert_amount missing');
        }
        const schema = promptArgsSchema(convert);
        expect(schema.safeParse({ amount: '1500', from: 'USD', to: 'GEL' }).success).toBe(true);
        expect(schema.safeParse({ amount: '1500', from: 'USD' }).success).toBe(false);
        expect(schema.shape['date']?.description).toBe('Calendar date, YYYY-MM-DD; today when empty');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/shell/prompts.test.ts`
Expected: FAIL, "Cannot find module './prompts.js'" (or equivalent import failure).

- [ ] **Step 3: Write the module**

Create `src/shell/prompts.ts`:

```ts
import * as z from 'zod';

export interface PromptArgument {
    readonly name: string;
    readonly description: string;
    readonly required: boolean;
}

export interface PromptDefinition {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly arguments: ReadonlyArray<PromptArgument>;
    /** The user message, with `${arguments.<name>}` placeholders; manifest.json lists the same text verbatim. */
    readonly text: string;
}

/**
 * Ready-made questions a client such as Claude Desktop shows in its prompt menu. Each text handles an empty
 * optional argument in words, so the server and the manifest copy (which cannot run code) behave the same.
 */
export const PROMPTS: ReadonlyArray<PromptDefinition> = [
    {
        name: 'nbg_rates_today',
        title: "Today's NBG rates",
        description: "Today's official NBG rates of the lari for a few currencies",
        arguments: [
            { name: 'currencies', description: 'Comma-separated ISO codes; USD, EUR and GBP when empty', required: false },
        ],
        text:
            "Give me today's official National Bank of Georgia rates for ${arguments.currencies} (USD, EUR and GBP when " +
            'none are named) with nbg_get_rates. For each currency report the rate in GEL per one unit and the change ' +
            'versus the previous rate, then the date the rates took effect and whether they are carried over from an ' +
            'earlier day.',
    },
    {
        name: 'nbg_rate_on_date',
        title: 'Rate on a date',
        description: 'The official NBG rate of one currency in force on a date',
        arguments: [
            { name: 'currency', description: 'ISO code such as USD', required: true },
            { name: 'date', description: 'Calendar date, YYYY-MM-DD', required: true },
        ],
        text:
            'What was the official National Bank of Georgia rate of ${arguments.currency} in force on ' +
            '${arguments.date}? Use nbg_get_rates. Report the rate in GEL per one unit, the date it took effect, and ' +
            'whether it is carried over from an earlier day.',
    },
    {
        name: 'nbg_convert_amount',
        title: 'Convert an amount',
        description: 'Convert an amount at the official NBG rate in force on a date',
        arguments: [
            { name: 'amount', description: 'Number in the from currency', required: true },
            { name: 'from', description: 'ISO code or GEL', required: true },
            { name: 'to', description: 'ISO code or GEL', required: true },
            { name: 'date', description: 'Calendar date, YYYY-MM-DD; today when empty', required: false },
        ],
        text:
            'Convert ${arguments.amount} ${arguments.from} to ${arguments.to} at the official National Bank of Georgia ' +
            'rate in force on ${arguments.date} (today when no date is given) with nbg_convert. Show the rate used, ' +
            'the date it took effect, whether it is carried over, and the result rounded to 2 decimal places.',
    },
    {
        name: 'nbg_monthly_rates',
        title: 'Rates table for a month',
        description: 'The official NBG rate of one currency for every day of a month, as a table',
        arguments: [
            { name: 'currency', description: 'ISO code such as EUR', required: true },
            { name: 'month', description: 'Month, YYYY-MM', required: true },
        ],
        text:
            'Using nbg_rate_history from the first to the last day of ${arguments.month}, give me a table of the ' +
            'official National Bank of Georgia rate of ${arguments.currency} for every day of the month, in GEL per ' +
            'one unit, marking the days whose rate is carried over from an earlier day. Below the table give the ' +
            'first, last, lowest and highest rate of the month.',
    },
];

const PLACEHOLDER = /\$\{arguments\.([A-Za-z_]+)\}/g;

/** Replaces each placeholder with its argument, or with nothing when the argument is absent or empty. */
export function renderPrompt(text: string, args: Readonly<Record<string, string | undefined>>): string {
    // A replacer function inserts the value as is; a replacement string would expand $& and $1 in it.
    return text.replace(PLACEHOLDER, (_match, name: string) => args[name] ?? '');
}

/** The zod schema the SDK advertises as the prompt's arguments: every argument a string, optional ones optional. */
export function promptArgsSchema(
    prompt: PromptDefinition,
): z.ZodObject<Record<string, z.ZodString | z.ZodOptional<z.ZodString>>> {
    const shape: Record<string, z.ZodString | z.ZodOptional<z.ZodString>> = {};
    for (const argument of prompt.arguments) {
        const field = z.string().describe(argument.description);
        shape[argument.name] = argument.required ? field : field.optional();
    }
    return z.object(shape);
}
```

Note the texts are built with `+` from single-quoted or double-quoted plain strings, never template literals, so `${arguments.x}` stays literal. Keep each text exactly equal to the spec's quotation once joined (one space between the pieces; check with the test in Task 3 against the manifest you will write there).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/shell/prompts.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test`
Expected: all pass (run `npm run format` first if prettier reports the new files).

```bash
git add src/shell/prompts.ts src/shell/prompts.test.ts && git commit -m "Define the four prompts and their renderer" -- src/shell/prompts.ts src/shell/prompts.test.ts
```

---

### Task 2: Register the prompts on the server

**Files:**
- Modify: `src/shell/server.ts` (imports at the top; a loop before `server.registerResource(` inside `createServer`)
- Modify: `src/shell/server.test.ts` (imports; new `describe('prompts'` block after the `describe('createServer'` block)
- Modify: `test/e2e/stdio.test.ts` (one new `it` after `'lists the tools'`)

**Interfaces:**
- Consumes: `PROMPTS`, `renderPrompt`, `promptArgsSchema` from Task 1.
- Produces: `prompts/list` and `prompts/get` on the server; nothing new for later tasks.

- [ ] **Step 1: Write the failing in-memory tests**

In `src/shell/server.test.ts`, add to the imports:

```ts
import { PROMPTS, renderPrompt } from './prompts.js';
```

Append after the `describe('createServer'` block:

```ts
describe('prompts', () => {
    it('lists the four prompts with their titles, descriptions and arguments', async () => {
        const client = await connectedClient();
        const { prompts } = await client.listPrompts();

        expect(
            prompts.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })),
        ).toEqual(
            PROMPTS.map((prompt) => ({
                name: prompt.name,
                title: prompt.title,
                description: prompt.description,
                arguments: prompt.arguments.map(({ name, description, required }) => ({ name, description, required })),
            })),
        );

        await client.close();
    });

    it('renders a prompt as one user message with the arguments inserted', async () => {
        const client = await connectedClient();
        const args = { amount: '1500', from: 'USD', to: 'GEL' };
        const convert = PROMPTS.find((prompt) => prompt.name === 'nbg_convert_amount');
        if (convert === undefined) {
            throw new Error('nbg_convert_amount missing');
        }

        const result = await client.getPrompt({ name: 'nbg_convert_amount', arguments: args });

        expect(result.messages).toEqual([
            { role: 'user', content: { type: 'text', text: renderPrompt(convert.text, args) } },
        ]);
        const text = result.messages[0]?.content.type === 'text' ? result.messages[0].content.text : '';
        expect(text).toContain('Convert 1500 USD to GEL');
        expect(text).toContain('in force on  (today when no date is given)');

        await client.close();
    });

    it('renders an omitted and an empty optional argument the same way', async () => {
        const client = await connectedClient();

        const omitted = await client.getPrompt({ name: 'nbg_rates_today', arguments: {} });
        const empty = await client.getPrompt({ name: 'nbg_rates_today', arguments: { currencies: '' } });

        expect(empty.messages).toEqual(omitted.messages);

        await client.close();
    });

    it('rejects a prompt call that lacks a required argument', async () => {
        const client = await connectedClient();

        await expect(client.getPrompt({ name: 'nbg_rate_on_date', arguments: { currency: 'USD' } })).rejects.toThrow();

        await client.close();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/shell/server.test.ts -t prompts`
Expected: FAIL; `listPrompts` rejects because the server declares no prompts capability.

- [ ] **Step 3: Register the prompts**

In `src/shell/server.ts`, add to the imports:

```ts
import { PROMPTS, promptArgsSchema, renderPrompt } from './prompts.js';
```

Inside `createServer`, before `server.registerResource(`, add:

```ts
    for (const prompt of PROMPTS) {
        server.registerPrompt(
            prompt.name,
            { title: prompt.title, description: prompt.description, argsSchema: promptArgsSchema(prompt) },
            (args) => ({
                messages: [{ role: 'user', content: { type: 'text', text: renderPrompt(prompt.text, args) } }],
            }),
        );
    }
```

If the SDK's inferred `args` type does not satisfy `Readonly<Record<string, string | undefined>>`, widen `renderPrompt`'s parameter type in `src/shell/prompts.ts` to `Readonly<Record<string, string | undefined>>` compatible with what the SDK infers (it infers the zod object's output, `{ [k: string]: string | undefined }`), rather than casting at the call site.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/shell/server.test.ts`
Expected: PASS, including the four new tests.

- [ ] **Step 5: Add the e2e check**

In `test/e2e/stdio.test.ts`, after the `'lists the tools'` test, add:

```ts
    it('lists the prompts', async () => {
        const { prompts } = await client.listPrompts();
        expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
            'nbg_convert_amount',
            'nbg_monthly_rates',
            'nbg_rate_on_date',
            'nbg_rates_today',
        ]);
    });
```

Run: `npm run test:e2e`
Expected: PASS (the run builds `dist/` first).

- [ ] **Step 6: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: all pass.

```bash
git add src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts && git commit -m "Serve the four prompts over MCP" -- src/shell/server.ts src/shell/server.test.ts test/e2e/stdio.test.ts
```

---

### Task 3: Manifest prompts, icon and long description

**Files:**
- Modify: `manifest.json` (new `long_description` after `description`; new `icon` after `license`; new `prompts` after `tools`)
- Create: `assets/icon.svg`, `assets/icon.png`, `scripts/render-icon.sh`
- Modify: `scripts/build-bundle.sh` (the `cp -r` line)
- Modify: `.mcpbignore` (one line)
- Modify: `src/shell/prompts.test.ts` (new `describe('manifest.json'` block)

**Interfaces:**
- Consumes: `PROMPTS` from Task 1.
- Produces: `manifest.json` fields `prompts`, `icon`, `long_description`; `assets/icon.png` inside the bundle.

- [ ] **Step 1: Write the failing drift test**

Append to `src/shell/prompts.test.ts` (add `import { existsSync, readFileSync } from 'node:fs';` and `import * as z from 'zod';` to its imports):

```ts
describe('manifest.json', () => {
    const manifest = z
        .object({
            icon: z.string(),
            long_description: z.string(),
            prompts: z.array(
                z.object({
                    name: z.string(),
                    description: z.string(),
                    arguments: z.array(z.string()),
                    text: z.string(),
                }),
            ),
        })
        .parse(JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8')));

    it('lists the same prompts the server serves: names, descriptions, argument names in order, and texts', () => {
        // Claude Desktop shows the manifest's prompts; the model gets the server's. The two must not drift.
        expect(manifest.prompts).toEqual(
            PROMPTS.map((prompt) => ({
                name: prompt.name,
                description: prompt.description,
                arguments: prompt.arguments.map((argument) => argument.name),
                text: prompt.text,
            })),
        );
    });

    it('names an icon file that exists and a long description with the example questions', () => {
        expect(manifest.icon).toBe('assets/icon.png');
        expect(existsSync(new URL(`../../${manifest.icon}`, import.meta.url))).toBe(true);
        expect(manifest.long_description).toContain('What was the USD rate on 30 September 2026?');
        expect(manifest.long_description).toContain('Not affiliated');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/shell/prompts.test.ts -t manifest`
Expected: FAIL, the zod parse rejects the manifest (no `icon`, `long_description`, `prompts`).

- [ ] **Step 3: Extend the manifest**

In `manifest.json`, after the `"description"` line add:

```json
    "long_description": "Ask Claude for the official National Bank of Georgia (NBG) rate of the lari (GEL) on any date, or to convert an amount at that rate. The server runs on your machine, needs no account and no key, and reads the rates from nbg.gov.ge.\n\nWhat you can ask:\n\n- What was the USD rate on 30 September 2026?\n- Convert 1,500 USD to GEL at the NBG rate of 27 September 2026.\n- Give me the EUR rate for every day of September 2026 as a table.\n- How many US dollars is 1 euro today, at NBG rates?\n\nGeorgian accounting and tax reporting use the official NBG rate in force on the date of the transaction. This server returns exactly that rate, the one shown on nbg.gov.ge for the day you name, and says when a Sunday, a Monday or a holiday carries the rate set earlier. A date NBG has not published yet is answered with an error, never a guess.\n\nThis is an independent open-source project. Not affiliated with the National Bank of Georgia.",
```

After the `"license": "MIT",` line add:

```json
    "icon": "assets/icon.png",
```

After the `"tools": [...]` array add:

```json
    "prompts": [
        {
            "name": "nbg_rates_today",
            "description": "Today's official NBG rates of the lari for a few currencies",
            "arguments": ["currencies"],
            "text": "Give me today's official National Bank of Georgia rates for ${arguments.currencies} (USD, EUR and GBP when none are named) with nbg_get_rates. For each currency report the rate in GEL per one unit and the change versus the previous rate, then the date the rates took effect and whether they are carried over from an earlier day."
        },
        {
            "name": "nbg_rate_on_date",
            "description": "The official NBG rate of one currency in force on a date",
            "arguments": ["currency", "date"],
            "text": "What was the official National Bank of Georgia rate of ${arguments.currency} in force on ${arguments.date}? Use nbg_get_rates. Report the rate in GEL per one unit, the date it took effect, and whether it is carried over from an earlier day."
        },
        {
            "name": "nbg_convert_amount",
            "description": "Convert an amount at the official NBG rate in force on a date",
            "arguments": ["amount", "from", "to", "date"],
            "text": "Convert ${arguments.amount} ${arguments.from} to ${arguments.to} at the official National Bank of Georgia rate in force on ${arguments.date} (today when no date is given) with nbg_convert. Show the rate used, the date it took effect, whether it is carried over, and the result rounded to 2 decimal places."
        },
        {
            "name": "nbg_monthly_rates",
            "description": "The official NBG rate of one currency for every day of a month, as a table",
            "arguments": ["currency", "month"],
            "text": "Using nbg_rate_history from the first to the last day of ${arguments.month}, give me a table of the official National Bank of Georgia rate of ${arguments.currency} for every day of the month, in GEL per one unit, marking the days whose rate is carried over from an earlier day. Below the table give the first, last, lowest and highest rate of the month."
        }
    ],
```

Run `npx prettier --write manifest.json` afterwards; prettier may reflow the short arrays.

- [ ] **Step 4: Create the icon source and renderer**

Create `assets/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#1F3A5F"/>
  <text x="256" y="378" fill="#FFFFFF" font-family="Noto Sans" font-weight="700" font-size="340" text-anchor="middle">₾</text>
</svg>
```

Create `scripts/render-icon.sh` (then `chmod +x scripts/render-icon.sh`):

```bash
#!/usr/bin/env bash
# Renders assets/icon.png (512x512, the Claude Desktop extension icon) from
# assets/icon.svg with librsvg. The PNG is committed, so a build needs no
# renderer; run this after editing the SVG. Needs rsvg-convert and the Noto
# Sans font (Debian and Ubuntu: librsvg2-bin, fonts-noto-core).
set -euo pipefail
cd "$(dirname "$0")/.."
rsvg-convert --width 512 --height 512 --output assets/icon.png assets/icon.svg
echo "rendered assets/icon.png"
```

Run: `scripts/render-icon.sh`, then open `assets/icon.png` and check it: a dark blue rounded square with a white lari sign roughly centred, the glyph neither clipped nor touching the edges. If the glyph sits too high or too low, adjust the `y` of the `<text>` element (larger `y` moves it down) and re-render; if the font is missing, the glyph renders as a box and `fc-list ':charset=20be' family` must list Noto Sans before trying again.

Add `/assets/icon.svg` as the last line of `.mcpbignore`, so the bundle carries the PNG only.

In `scripts/build-bundle.sh`, change the copy line to:

```bash
cp -r dist assets package.json package-lock.json README.md LICENSE CHANGELOG.md manifest.json .mcpbignore bundle/
```

- [ ] **Step 5: Run the tests and the bundle build**

Run: `npx vitest run --project unit src/shell/prompts.test.ts`
Expected: PASS. If the text equality test fails, the difference is in the joining of the string pieces in `src/shell/prompts.ts` (a missing or doubled space); fix the TypeScript side so it equals the manifest text, which is copied from the spec.

Run: `./scripts/build-bundle.sh && unzip -l nbg-rates-mcp-*.mcpb | grep -E 'assets/|manifest.json'`
Expected: `mcpb validate` passes; the listing shows `assets/icon.png` and no `assets/icon.svg`. Afterwards remove the build outputs, which are git-ignored: `rm -rf bundle nbg-rates-mcp-*.mcpb` (the stale `nbg-rates-mcp-0.1.0.mcpb` in the root is an untracked local file and may go with them).

- [ ] **Step 6: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e && shellcheck scripts/*.sh`
Expected: all pass.

```bash
git add manifest.json assets/icon.svg assets/icon.png scripts/render-icon.sh scripts/build-bundle.sh .mcpbignore src/shell/prompts.test.ts && git commit -m "List the prompts, an icon and a long description in the bundle manifest" -- manifest.json assets/icon.svg assets/icon.png scripts/render-icon.sh scripts/build-bundle.sh .mcpbignore src/shell/prompts.test.ts
```

---

### Task 4: Stable bundle asset and install block in release notes

**Files:**
- Modify: `scripts/publish-release.sh` (`release_notes` and `publish_github` functions, lines 25-56 as of this plan)
- Modify: `test/scripts/publish-release.test.ts` (a `gh` stub, `runStep` accepting `'github'`, three new tests)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: every release carries `nbg-rates-mcp-<version>.mcpb` and `nbg-rates-mcp-latest.mcpb`; release notes start with the install block.

- [ ] **Step 1: Write the failing tests**

In `test/scripts/publish-release.test.ts`, add after `NPM_STUB`:

```ts
// Stands in for gh: `release view` answers per GH_VIEW (missing: exit 1; false or true: the --jq result), and
// `release create` logs its arguments without the notes and writes the notes to a file, since they span lines.
const GH_STUB = `#!/usr/bin/env bash
if [ "$1 $2" = "release view" ]; then
    echo "gh release view $3" >> "$STUB_LOG"
    if [ "$GH_VIEW" = missing ]; then exit 1; fi
    printf '%s' "$GH_VIEW"
    exit 0
fi
if [ "$1 $2" = "release create" ]; then
    printf '%s' "\${@: -1}" > "$STUB_DIR/notes"
    set -- "\${@:1:$#-1}"
fi
echo "gh $*" >> "$STUB_LOG"
`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(ROOT, 'nbg-rates-mcp-0.2.0.mcpb');
const LATEST = join(ROOT, 'nbg-rates-mcp-latest.mcpb');
const INSTALL_BLOCK =
    'Install: on Claude Desktop (macOS, Windows) download [nbg-rates-mcp-0.2.0.mcpb](https://github.com/akalongman/nbg-rates-mcp/releases/download/v0.2.0/nbg-rates-mcp-0.2.0.mcpb) and open it. In Claude Code run `claude mcp add nbg-rates -- npx -y nbg-rates-mcp@0.2.0`. Other clients: see the [README](https://github.com/akalongman/nbg-rates-mcp#install).';
```

Add `['gh', GH_STUB]` to the stub list in `beforeEach`, and extend `afterEach` to remove the bundle files:

```ts
    afterEach(() => {
        rmSync(stubDir, { recursive: true, force: true });
        rmSync(BUNDLE, { force: true });
        rmSync(LATEST, { force: true });
    });
```

Change `runStep`'s signature to `step: 'npm' | 'registry' | 'github', npm404s = 0, ghView = 'missing'` and add `GH_VIEW: ghView` to its `env`. Then add a `describe` block:

```ts
describe('publish-release.sh github', () => {
    function withBundle(): void {
        // The build job's artifact: the versioned bundle in the repository root, where the publish job runs.
        writeFileSync(BUNDLE, 'bundle bytes');
    }

    it('creates the release with both bundle names and notes that start with the install block', () => {
        withBundle();

        const { status, calls } = runStep('github');

        expect(status).toBe(0);
        expect(calls).toEqual([
            'gh release view v0.2.0',
            'gh release create v0.2.0 nbg-rates-mcp-0.2.0.mcpb nbg-rates-mcp-latest.mcpb --title v0.2.0 --notes',
        ]);
        expect(readFileSync(LATEST, 'utf8')).toBe('bundle bytes');
        const notes = readFileSync(join(stubDir, 'notes'), 'utf8');
        expect(notes.startsWith(`${INSTALL_BLOCK}\n\n`)).toBe(true);
        expect(notes).toContain('Breaking: `nbg_rate_history` days are now');
    });

    it('finishes a release that lacks one of the assets by uploading both and publishing it', () => {
        withBundle();

        const { status, calls } = runStep('github', 0, 'false');

        expect(status).toBe(0);
        expect(calls).toEqual([
            'gh release view v0.2.0',
            'gh release upload v0.2.0 nbg-rates-mcp-0.2.0.mcpb nbg-rates-mcp-latest.mcpb --clobber',
            'gh release edit v0.2.0 --draft=false',
        ]);
    });

    it('leaves a complete release alone', () => {
        withBundle();

        const { status, calls } = runStep('github', 0, 'true');

        expect(status).toBe(0);
        expect(calls).toEqual(['gh release view v0.2.0']);
    });
});
```

The notes assertion `'Breaking: \`nbg_rate_history\` days are now'` relies on the 0.2.0 section of `CHANGELOG.md`, which does not change.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit test/scripts/publish-release.test.ts`
Expected: the three new tests FAIL (the `create` call lacks the `-latest` asset; the notes do not start with the install block; the `false` case uploads one asset).

- [ ] **Step 3: Change the script**

In `scripts/publish-release.sh`, replace the `release_notes` and `publish_github` functions with:

```bash
# The body of this version's "## <version> - <date>" section in CHANGELOG.md.
changelog_section() {
    awk -v heading="## $version - " '
        index($0, heading) == 1 { found = 1; next }
        found && /^## / { exit }
        found { print }
    ' CHANGELOG.md
}

# How to install this version, then its changelog section. The release page links its own bundle, not the
# "latest" alias, so an old release page stays truthful.
release_notes() {
    local bundle="$package-$version.mcpb" section
    section=$(changelog_section)
    if [ -z "${section//[[:space:]]/}" ]; then
        echo "CHANGELOG.md has no notes under ## $version" >&2
        return 1
    fi
    printf 'Install: on Claude Desktop (macOS, Windows) download [%s](https://github.com/akalongman/nbg-rates-mcp/releases/download/v%s/%s) and open it. In Claude Code run `claude mcp add nbg-rates -- npx -y nbg-rates-mcp@%s`. Other clients: see the [README](https://github.com/akalongman/nbg-rates-mcp#install).\n\n%s\n' \
        "$bundle" "$version" "$bundle" "$version" "$section"
}

publish_github() {
    local bundle="$package-$version.mcpb" latest="$package-latest.mcpb" complete notes
    # The same bytes under a fixed name, so releases/latest/download/<latest> always fetches the newest release.
    cp "$bundle" "$latest"
    if ! complete=$(gh release view "v$version" --json isDraft,assets \
        --jq "(.isDraft | not) and any(.assets[]; .name == \"$bundle\") and any(.assets[]; .name == \"$latest\")" 2> /dev/null); then
        notes=$(release_notes) || exit 1
        gh release create "v$version" "$bundle" "$latest" --title "v$version" --notes "$notes"
        return
    fi
    if [ "$complete" = true ]; then
        echo "GitHub release v$version already exists with $bundle and $latest"
        return
    fi
    # gh creates a release as a draft and publishes it after the upload, so a
    # cancelled run leaves a draft or a release missing an asset: finish it.
    gh release upload "v$version" "$bundle" "$latest" --clobber
    gh release edit "v$version" --draft=false
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit test/scripts/publish-release.test.ts && bash -n scripts/publish-release.sh && shellcheck scripts/publish-release.sh`
Expected: PASS, 6 tests; no shellcheck findings. Confirm `git status --short` shows no `.mcpb` leftovers in the root (they are git-ignored, but the `afterEach` must have removed them).

- [ ] **Step 5: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && shellcheck scripts/*.sh`
Expected: all pass.

```bash
git add scripts/publish-release.sh test/scripts/publish-release.test.ts && git commit -m "Publish a latest-named bundle and start release notes with install steps" -- scripts/publish-release.sh test/scripts/publish-release.test.ts
```

---

### Task 5: Repository settings in git

**Files:**
- Create: `.github/repository.json`
- Create: `scripts/apply-repo-settings.sh`
- Create: `test/scripts/apply-repo-settings.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the script the maintainer runs once after the release; the README sentence that names it is written in Task 6.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/apply-repo-settings.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'apply-repo-settings.sh');

// Stands in for gh: logs each call with its stdin on one line, answers `repo view` with fixed JSON fields.
const GH_STUB = `#!/usr/bin/env bash
body=$(cat)
echo "gh $* <<< $body" >> "$STUB_LOG"
if [ "$1 $2" = "repo view" ]; then
    printf 'description: d\\nhomepage: h\\ntopics: t\\n'
fi
`;

describe('apply-repo-settings.sh', () => {
    let stubDir: string;

    beforeEach(() => {
        stubDir = mkdtempSync(join(tmpdir(), 'apply-repo-settings-'));
        writeFileSync(join(stubDir, 'gh'), GH_STUB);
        chmodSync(join(stubDir, 'gh'), 0o755);
    });

    afterEach(() => {
        rmSync(stubDir, { recursive: true, force: true });
    });

    it('sends the description, homepage and topics of .github/repository.json, then reads them back', () => {
        const log = join(stubDir, 'calls.log');
        writeFileSync(log, '');
        const settings = JSON.parse(readFileSync(join(ROOT, '.github', 'repository.json'), 'utf8')) as {
            description: string;
            homepage: string;
            topics: string[];
        };

        const result = spawnSync('bash', [SCRIPT], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${stubDir}:${process.env['PATH'] ?? ''}`, STUB_LOG: log },
        });

        expect(result.status).toBe(0);
        expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
            `gh api --method PATCH repos/{owner}/{repo} --input - <<< ${JSON.stringify({
                description: settings.description,
                homepage: settings.homepage,
            })}`,
            `gh api --method PUT repos/{owner}/{repo}/topics --input - <<< ${JSON.stringify({ names: settings.topics })}`,
            // The log is trimmed, so the empty stdin of the last call leaves no trailing space.
            'gh repo view --json description,homepageUrl,repositoryTopics --jq "description: \\(.description)\\nhomepage: \\(.homepageUrl)\\ntopics: \\((.repositoryTopics // []) | map(.name) | join(", "))" <<<',
        ]);
        expect(result.stdout).toBe('description: d\nhomepage: h\ntopics: t\n');
    });

    it('defines lowercase hyphenated topics only, as GitHub requires', () => {
        const { topics } = JSON.parse(readFileSync(join(ROOT, '.github', 'repository.json'), 'utf8')) as {
            topics: string[];
        };
        expect(topics.length).toBeGreaterThan(0);
        expect(topics.length).toBeLessThanOrEqual(20);
        for (const topic of topics) {
            expect(topic).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        }
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit test/scripts/apply-repo-settings.test.ts`
Expected: FAIL (no `.github/repository.json`, no script).

- [ ] **Step 3: Create the settings file and the script**

Create `.github/repository.json`:

```json
{
    "description": "GEL exchange rates from the National Bank of Georgia (NBG) for AI agents (MCP server). Not affiliated with NBG.",
    "homepage": "https://www.npmjs.com/package/nbg-rates-mcp",
    "topics": [
        "mcp",
        "mcp-server",
        "model-context-protocol",
        "exchange-rates",
        "currency",
        "georgia",
        "national-bank-of-georgia",
        "nbg",
        "gel",
        "lari",
        "claude"
    ]
}
```

Create `scripts/apply-repo-settings.sh` (then `chmod +x scripts/apply-repo-settings.sh`):

```bash
#!/usr/bin/env bash
# Applies .github/repository.json (description, homepage, topics) to this
# repository's GitHub remote and prints what GitHub holds afterwards, so these
# settings live in git like the rulesets. Needs gh with repository
# administration on the remote. Usage: scripts/apply-repo-settings.sh
set -euo pipefail
cd "$(dirname "$0")/.."

settings=.github/repository.json
jq -c '{description, homepage}' "$settings" | gh api --method PATCH 'repos/{owner}/{repo}' --input - > /dev/null
jq -c '{names: .topics}' "$settings" | gh api --method PUT 'repos/{owner}/{repo}/topics' --input - > /dev/null
gh repo view --json description,homepageUrl,repositoryTopics \
    --jq '"description: \(.description)\nhomepage: \(.homepageUrl)\ntopics: \((.repositoryTopics // []) | map(.name) | join(", "))"'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit test/scripts/apply-repo-settings.test.ts && bash -n scripts/apply-repo-settings.sh && shellcheck scripts/apply-repo-settings.sh`
Expected: PASS, 2 tests; no shellcheck findings. If the third logged line differs only in how the stub rendered the `--jq` argument's quotes, align the expectation with the stub's actual output rather than changing the script's jq program.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && shellcheck scripts/*.sh`
Expected: all pass. Do not run the script against GitHub in this task; the maintainer runs it after the release.

```bash
git add .github/repository.json scripts/apply-repo-settings.sh test/scripts/apply-repo-settings.test.ts && git commit -m "Define the repository description, homepage and topics in git" -- .github/repository.json scripts/apply-repo-settings.sh test/scripts/apply-repo-settings.test.ts
```

---

### Task 6: README for the accountant first

**Files:**
- Modify: `README.md` (everything above `## Tools`; the Development paragraph that names `apply-rulesets.sh`)

**Interfaces:**
- Consumes: the `-latest` asset name from Task 4, the script name from Task 5.
- Produces: nothing for later tasks.

- [ ] **Step 1: Replace the top of the README**

Replace everything from the first line down to, but not including, the `## Tools` heading with the text below. The Node.js subsection is the current text, moved under Install unchanged; copy it from the existing file rather than retyping it.

````markdown
# nbg-rates-mcp

Ask Claude, or any other MCP client, for the official National Bank of Georgia (NBG) rate of the lari (GEL) on any date, or to convert an amount at that rate. `nbg-rates-mcp` runs on your machine, needs no account and no key, and encodes the rules a raw lookup gets wrong: per-unit values, Tbilisi calendar days, an explicit flag when a day has no rate of its own, and an error, never a stale rate, for a date NBG has not published yet.

This is an independent open-source project, not affiliated with the National Bank of Georgia. NBG's website, [nbg.gov.ge](https://nbg.gov.ge), is the source of truth. The NBG endpoints this server reads are undocumented and may change.

## What you can ask

- What was the USD rate on 30 September 2026?
- Convert 1,500 USD to GEL at the NBG rate of 27 September 2026.
- Give me the EUR rate for every day of September 2026 as a table.
- How many US dollars is 1 euro today, at NBG rates?

For the second question the answer is: 27 September 2026 is a Sunday, so the rate in force is the one NBG set for Saturday 26 September, 2.6080 GEL per USD, still valid on Sunday; 1,500 USD = 3,912.00 GEL, and the answer says the rate is carried over from the 26th.

In Claude Desktop the "+" menu of a chat also lists four ready-made questions from this server: today's rates, the rate on a date, converting an amount, and a rates table for a month.

## Which rate you get

Georgian accounting and tax reporting use the official NBG rate in force on the date of the transaction. This server returns exactly that rate, the one shown on nbg.gov.ge for the day you name.

NBG sets rates on business days around 17:00 Tbilisi time, valid from the next calendar day. A Sunday, a Monday or the day after a public holiday has no rate of its own and keeps the last one set; the answer says so (`carriedOver`) and names the day that rate took effect. A date NBG has not published yet, including tomorrow before about 17:00 Tbilisi time, is answered with an error, never a guess.

## Install

### Claude Desktop (macOS, Windows)

Download [nbg-rates-mcp-latest.mcpb](https://github.com/akalongman/nbg-rates-mcp/releases/latest/download/nbg-rates-mcp-latest.mcpb) and open it. Claude Desktop installs the extension and runs it with its own Node.js, so nothing else is needed. The same file, under its version number, is attached to every [release](https://github.com/akalongman/nbg-rates-mcp/releases).

### Claude Desktop (Linux beta) and manual configuration

Add the server to `claude_desktop_config.json`. The file may not exist yet; create it with the snippet below as its whole content, then restart Claude Desktop.

| Platform | Location of `claude_desktop_config.json`     |
| -------- | -------------------------------------------- |
| macOS    | `~/Library/Application Support/Claude/`      |
| Windows  | `%APPDATA%\Claude\`                          |
| Linux    | `~/.config/Claude/`                          |

```json
{ "mcpServers": { "nbg-rates": { "command": "npx", "args": ["-y", "nbg-rates-mcp"] } } }
```

This needs Node.js 22 or later; see [Node.js](#nodejs) below.

### Claude Code

```bash
claude mcp add nbg-rates -- npx -y nbg-rates-mcp
```

To make the server available in every project, add it with user scope:

```bash
claude mcp add --scope user nbg-rates -- npx -y nbg-rates-mcp
```

### Cursor and other clients

Add the same `mcpServers` entry to the client's MCP settings. In Cursor that is `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` inside one project.

### Node.js

(the current Node.js subsection, unchanged)

The rest of this document is for developers and for people writing instructions for a model.

````

- [ ] **Step 2: Update the Development paragraph**

Replace the sentence that begins `The repository's rulesets` with:

```markdown
The repository's rulesets (protection of `main`, and release tags that only admins may create) are defined in `.github/rulesets/` and applied with `scripts/apply-rulesets.sh`; its description, homepage and topics are defined in `.github/repository.json` and applied with `scripts/apply-repo-settings.sh`. Both are run by a maintainer after a change, never edited in the GitHub UI.
```

- [ ] **Step 3: Check the facts in the new text**

Run: `npx prettier --write README.md && npx prettier --check README.md`
Expected: clean (prettier realigns the table).

Run: `grep -c "Node.js 22" README.md` and `grep -n "^## \|^### " README.md`
Expected: the Node.js subsection appears once, under Install; the heading order is What you can ask, Which rate you get, Install (with its five subsections), Tools, Resource, Errors, Date rules, Environment variables, Development, License.

Run: `grep -nE '—|–' README.md`
Expected: no output (no em or en dashes).

Confirm the worked answer against the live server, from the repository root:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"nbg_convert","arguments":{"amount":1500,"from":"USD","to":"GEL","date":"2026-09-27"}}}' | node dist/bin.js 2>/dev/null | tail -1
```

Expected: a result whose text holds `"result":3912`, `"rate":2.608`, `"effectiveDate":"2026-09-26"`, `"carriedOver":true` (run `npm run build` first if `dist/` is stale). If the live numbers differ (NBG revised the table), change the README's numbers to the live ones.

- [ ] **Step 4: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test`
Expected: all pass.

```bash
git add README.md && git commit -m "Lead the README with what to ask and which rate applies" -- README.md
```

---

### Task 7: Release 0.3.0

**Files:**
- Modify: `package.json`, `package-lock.json` (via `npm version`), `manifest.json`, `server.json` (both `version` fields), `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a tree `scripts/check-release.ts 0.3.0` accepts; the maintainer tags `v0.3.0`.

- [ ] **Step 1: Bump the versions**

Run: `npm version 0.3.0 --no-git-tag-version`
Expected: `package.json` and both version fields in `package-lock.json` read 0.3.0.

In `manifest.json` set `"version": "0.3.0"`. In `server.json` set the top-level `"version"` and `packages[0].version` to `"0.3.0"`.

- [ ] **Step 2: Add the changelog entry**

Insert above the `## 0.2.2 - 2026-10-09` heading in `CHANGELOG.md`:

```markdown
## 0.3.0 - 2026-10-09

Added: four prompts (today's rates, rate on a date, convert an amount, rates table for a month), shown by clients such as Claude Desktop as ready-made questions; an icon and a long description in the Claude Desktop bundle.

Changed: the README leads with what to ask and which rate applies, links the Claude Desktop bundle directly and lists where `claude_desktop_config.json` lives on each OS. Release notes start with install steps, and every release also carries the bundle as `nbg-rates-mcp-latest.mcpb` so one link always downloads the newest one.

Repository: topics and homepage are defined in `.github/repository.json` and applied with `scripts/apply-repo-settings.sh`.

```

- [ ] **Step 3: Check the release preconditions**

Run: `npx tsx scripts/check-release.ts 0.3.0 && npx prettier --check CHANGELOG.md manifest.json server.json package.json`
Expected: exit 0, no output from check-release.

- [ ] **Step 4: Run the gates and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e && shellcheck scripts/*.sh`
Expected: all pass (the e2e test reads the version from `package.json`, so it must see 0.3.0 in the built binary's user agent).

```bash
git add package.json package-lock.json manifest.json server.json CHANGELOG.md && git commit -m "Release 0.3.0" -- package.json package-lock.json manifest.json server.json CHANGELOG.md
```

Do not tag and do not push. After the run, the maintainer tags `v0.3.0` and pushes, waits for the Release workflow, checks that the release shows both bundle assets and the install block, that the `-latest` URL downloads a file with the same SHA-256 as the versioned one, and then runs `scripts/apply-repo-settings.sh` once.
