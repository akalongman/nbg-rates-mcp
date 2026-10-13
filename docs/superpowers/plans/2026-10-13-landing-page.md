# Landing Page and Directory Readiness (0.6.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `https://nbg-rates.env.ge` a landing page in English and Georgian, an icon set and a share card, the OpenAI domain verification route, the hosted server's icon in `serverInfo`, and the listing texts for both directories, and prepare release 0.6.0.

**Architecture:** A new `src/shell/site/` directory holds everything the host serves besides `/mcp`: the rasters as a generated module of base64 strings (so `dist` carries them into the npm package, the Lambda zip and the bundle with no build step), the page copy per language behind one `PageCopy` interface, a pure `renderPage` that inlines one style and one script pinned by hash in the page's Content Security Policy, and `createSiteResponder`, which `http.ts` asks after the Host check and before `/mcp`. Pages and assets are rendered and decoded once when the handler is created, never per request. The Lambda entry base64-encodes any body whose content type is not text.

**Tech Stack:** TypeScript 6 (strict, ESM), Node 22 and 24, `@modelcontextprotocol/server` 2.3 (`Icon` type), Vitest, bash, librsvg (`rsvg-convert`), ImageMagick 6 (`convert`, ICO only), Python fontTools 4.66.1 run through `uv` (glyph outlines only).

**Spec:** `docs/superpowers/specs/2026-10-13-landing-page-design.md`. The infrastructure half (alarms, saved queries, the token variable) is the separate plan `~/projects/personal/iac/docs/superpowers/plans/2026-10-13-nbg-rates-mcp-alarms.md`.

## Global Constraints

- ESM with `.js` import extensions, strict TypeScript, 4-space indentation, 120 columns, single quotes, no `any`, no non-null `!`, `function` keyword for named functions, `readonly` by default, return types on exported functions.
- No new runtime or dev dependency. fontTools runs only through `uv run --no-project --with fonttools==4.66.1`; `rsvg-convert` and `convert` are needed only by `scripts/render-icon.sh`, never by a build or a test.
- Host `nbg-rates.env.ge`, origin `https://nbg-rates.env.ge`, MCP URL `https://nbg-rates.env.ge/mcp`, repository `https://github.com/akalongman/nbg-rates-mcp`, issues `https://github.com/akalongman/nbg-rates-mcp/issues`, operator `Avtandil Kikabidze`. These come from `src/shell/site/hosted.ts` (Task 2) everywhere in `src/shell/site/`.
- Paths, methods, content types and cache headers exactly as the spec's "Paths and answers" table and header list. Every response from the site responder carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- The page loads nothing from another origin, has no `style=` attribute and no inline event handler, and names Claude and ChatGPT in text only (no logos, no imitation of either interface).
- Colours: navy `#1F3A5F`, white, light blue-grey surfaces (for example `#F4F7FB`). Font stack: `system-ui, "Segoe UI", "Noto Sans Georgian", Sylfaen, sans-serif`.
- Chat demo figures: 2,450 USD x 2.6025 = 6,376.13 GEL on 7 October 2026; EUR 2.9257 for Sunday 4 October 2026, set by NBG on Friday 2 October and in force from Saturday 3 October. Georgian numbers are written as `Intl.NumberFormat('ka-GE')` writes them (`6376,13`, `2,6025`).
- No em or en dashes anywhere (code, comments, copy in both languages, docs, commit messages). Repository prose is agent-neutral.
- Gates before every commit: `npm run format:check && npm run lint && npm run typecheck && npm test`; from Task 4 on also `npm run test:e2e`.
- Commits on `main`, path-limited (`git add <paths> && git commit -m "<title>" -- <paths>`), signed as configured, titles under 72 characters, no attribution trailers. Never push, never tag.

## Review Focus

1. An inline `style=` attribute or `onclick=` slipping into the page: browsers block it silently under a hash-based policy, so the page looks fine in tests and broken in a browser. Task 2 tests that neither page has one and that the policy's hashes match the inline blocks; Task 4's browser check reads the console for violations.
2. The hosted host with a port or a query string (`nbg-rates.env.ge:8443/?ref=x`) must still get the page, not today's text. Task 4 tests it.
3. A token pasted with a trailing newline or spaces must be served trimmed, as the token and nothing else. Task 4 tests `parseOpenAiChallenge` and the route's exact body.
4. The copy button where the Clipboard API is missing (a `--http` server opened over plain HTTP on a LAN address is not a secure context): it must select the URL instead and throw nothing. Task 4's browser check removes `navigator.clipboard` and clicks.
5. `HEAD` on a binary asset through Lambda: status 200, the asset's content type, an empty body, no crash in the base64 branch. Task 5 tests it.

---

### Task 1: The icon, the share card and the generated asset module

**Files:**

- Modify: `assets/icon.svg` (the lari sign as a path)
- Create: `assets/og.svg` (the 1200 by 630 share card, text as paths)
- Create: `scripts/glyph-paths.py`
- Modify: `scripts/render-icon.sh` (renders every raster and writes the module)
- Create (generated): `src/shell/site/assets.generated.ts`
- Modify (regenerated): `assets/icon.png`
- Modify: `.prettierignore`, `.mcpbignore`
- Test: `src/shell/site/assets.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces, in `src/shell/site/assets.generated.ts`, each an exported `const` string:
  - `ICON_SVG_SHA256`, `OG_SVG_SHA256`: lowercase hex SHA-256 of `assets/icon.svg` and `assets/og.svg` as rendered.
  - `ICON_PNG_BASE64` (512 by 512), `APPLE_TOUCH_ICON_PNG_BASE64` (180 by 180), `FAVICON_ICO_BASE64` (16, 32 and 48), `OG_PNG_BASE64` (1200 by 630).

- [ ] **Step 1: Write `scripts/glyph-paths.py`**

A command that prints one SVG `<path d="..."/>` for a run of text set in a TrueType font, so the SVGs need no installed font. Usage line (also its docstring): `uv run --no-project --with fonttools==4.66.1 python3 scripts/glyph-paths.py --font <ttf> --size <px> --x <px> --baseline <px> [--anchor start|middle] [--fill <colour>] <text>`. It maps each character through the font's best cmap, draws the glyph with `fontTools.pens.svgPathPen.SVGPathPen` through a `fontTools.pens.transformPen.TransformPen` with the transform `(scale, 0, 0, -scale, x, baseline)` where `scale = size / unitsPerEm`, advances `x` by the glyph's `hmtx` advance times `scale`, and for `--anchor middle` first shifts the start left by half the total advance. No kerning. Round coordinates to two decimals. Exit 2 with a message naming the character when the font has no glyph for it.

- [ ] **Step 2: Redraw `assets/icon.svg`**

Run, with the font the current file names:

```bash
uv run --no-project --with fonttools==4.66.1 python3 scripts/glyph-paths.py \
  --font /usr/share/fonts/truetype/noto/NotoSans-Bold.ttf --size 340 --x 256 --baseline 378 \
  --anchor middle --fill '#FFFFFF' '₾'
```

Replace the `<text>` element with the printed `<path>`. The rect (`width 512`, `rx 96`, `#1F3A5F`) stays. The file has no `<text>` and no `font-family` left.

- [ ] **Step 3: Write `assets/og.svg`**

`width="1200" height="630"`, background `#F4F7FB`. Left: the icon (its rect and path from Step 2 inside a `<g transform="translate(...) scale(...)">`, about 220 pixels square, vertically centred). Right of it, every line converted with `scripts/glyph-paths.py`: "NBG Rates" in `NotoSans-Bold.ttf` about 84 pixels, `#1F3A5F`; the headline "Official NBG exchange rates," and "inside Claude and ChatGPT" on two lines in `NotoSans-Regular.ttf` about 46 pixels, `#1B2430`; the URL "nbg-rates.env.ge/mcp" in `NotoSans-Bold.ttf` about 40 pixels, `#1F3A5F`. Exact positions are yours; nothing may run past 1140 pixels. Add a comment at the top of the file naming the command that produced the paths and the text of each line.

- [ ] **Step 4: Rewrite `scripts/render-icon.sh`**

Keep its header style and update the comment (needs `rsvg-convert` and ImageMagick's `convert`; the outputs are committed so a build needs neither). In a `mktemp -d` work directory removed on exit, render `assets/icon.svg` at 512, 180, 48, 32 and 16 pixels and `assets/og.svg` at 1200 by 630 with `rsvg-convert`, pack the 16, 32 and 48 pixel PNGs into `favicon.ico` with `convert`, copy the 512 pixel PNG to `assets/icon.png`, then write `src/shell/site/assets.generated.ts`:

```ts
// Generated by scripts/render-icon.sh from assets/icon.svg and assets/og.svg. Do not edit; run the script.
export const ICON_SVG_SHA256 = '<sha256 of assets/icon.svg>';
export const OG_SVG_SHA256 = '<sha256 of assets/og.svg>';
export const ICON_PNG_BASE64 = '<base64 -w0 of icon 512>';
export const APPLE_TOUCH_ICON_PNG_BASE64 = '<base64 -w0 of icon 180>';
export const FAVICON_ICO_BASE64 = '<base64 -w0 of favicon.ico>';
export const OG_PNG_BASE64 = '<base64 -w0 of og 1200x630>';
```

Add `src/shell/site/assets.generated.ts` to `.prettierignore` and `/assets/og.svg` to `.mcpbignore`.

- [ ] **Step 5: Write the failing test `src/shell/site/assets.test.ts`**

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    APPLE_TOUCH_ICON_PNG_BASE64,
    FAVICON_ICO_BASE64,
    ICON_PNG_BASE64,
    ICON_SVG_SHA256,
    OG_PNG_BASE64,
    OG_SVG_SHA256,
} from './assets.generated.js';

const ROOT = new URL('../../../', import.meta.url);

function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(new URL(path, ROOT))).digest('hex');
}

function bytes(base64: string): Buffer {
    return Buffer.from(base64, 'base64');
}

/** Width and height from a PNG's IHDR chunk, after checking the signature. */
function pngSize(png: Buffer): { width: number; height: number } {
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The square sizes listed in an ICO directory (a 0 byte means 256). */
function icoSizes(ico: Buffer): number[] {
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico.readUInt8(6 + 16 * index) || 256);
}

describe('the generated assets', () => {
    it('were rendered from the committed SVG sources', () => {
        expect(ICON_SVG_SHA256).toBe(sha256('assets/icon.svg'));
        expect(OG_SVG_SHA256).toBe(sha256('assets/og.svg'));
    });

    it('carry the same 512 pixel icon as the Claude Desktop bundle', () => {
        expect(bytes(ICON_PNG_BASE64).equals(readFileSync(new URL('assets/icon.png', ROOT)))).toBe(true);
    });

    it('have the sizes the paths table names', () => {
        expect(pngSize(bytes(ICON_PNG_BASE64))).toEqual({ width: 512, height: 512 });
        expect(pngSize(bytes(APPLE_TOUCH_ICON_PNG_BASE64))).toEqual({ width: 180, height: 180 });
        expect(pngSize(bytes(OG_PNG_BASE64))).toEqual({ width: 1200, height: 630 });
        expect(icoSizes(bytes(FAVICON_ICO_BASE64)).sort((a, b) => a - b)).toEqual([16, 32, 48]);
    });

    it('draw every glyph as a path, so no font is needed to render them', () => {
        for (const source of ['assets/icon.svg', 'assets/og.svg']) {
            const svg = readFileSync(new URL(source, ROOT), 'utf8');
            expect(svg).not.toMatch(/<text\b|font-family/);
        }
    });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `npx vitest run src/shell/site/assets.test.ts`
Expected: FAIL, cannot resolve `./assets.generated.js` (the module does not exist yet).

- [ ] **Step 7: Render**

Run: `bash scripts/render-icon.sh`
Expected: it prints what it rendered; `git status --short` shows `assets/icon.png`, `assets/icon.svg`, `assets/og.svg`, the generated module and the two ignore files.

- [ ] **Step 8: Look at the renders**

Write the 512 pixel icon and the share card from the module to a temporary directory outside the repository and open both images. The sign must look like the current `assets/icon.png` (compare with `git show HEAD:assets/icon.png`), and every line of the card must be legible, inside the canvas and not overlapping. Fix the SVGs and re-render until they are.

- [ ] **Step 9: Run the test and the gates**

Run: `npx vitest run src/shell/site/assets.test.ts`, then the gates.
Expected: PASS; gates exit 0.

- [ ] **Step 10: Commit**

```bash
git add assets/icon.svg assets/og.svg assets/icon.png scripts/glyph-paths.py scripts/render-icon.sh src/shell/site/assets.generated.ts src/shell/site/assets.test.ts .prettierignore .mcpbignore
git commit -m "Draw the icon as a path and render the site's rasters" -- assets/icon.svg assets/og.svg assets/icon.png scripts/glyph-paths.py scripts/render-icon.sh src/shell/site/assets.generated.ts src/shell/site/assets.test.ts .prettierignore .mcpbignore
```

---

### Task 2: The page template and the English copy

**Files:**

- Create: `src/shell/site/hosted.ts`, `src/shell/site/copy.ts`, `src/shell/site/copy-en.ts`, `src/shell/site/page.ts`
- Test: `src/shell/site/page.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces:
  - `hosted.ts`: `SITE_HOST = 'nbg-rates.env.ge'`, `SITE_ORIGIN = 'https://nbg-rates.env.ge'`, `MCP_URL = 'https://nbg-rates.env.ge/mcp'`, `REPOSITORY_URL`, `ISSUES_URL`, `OPERATOR = 'Avtandil Kikabidze'`, and `HOSTED_SERVER_ICONS: readonly Icon[] = [{ src: 'https://nbg-rates.env.ge/icon.png', mimeType: 'image/png', sizes: ['512x512'] }]` (`import type { Icon } from '@modelcontextprotocol/server'`). Build the URLs from `SITE_ORIGIN` and `REPOSITORY_URL`.
  - `copy.ts`: the types below, verbatim.
  - `copy-en.ts`: `export const COPY_EN: PageCopy`.
  - `page.ts`: `export function renderPage(copy: PageCopy, version: string): string`, `export function escapeHtml(text: string): string`, `export const PAGE_CONTENT_SECURITY_POLICY: string`.

`src/shell/site/copy.ts`:

```ts
/** The page's text in one language. The template owns the markup, the URLs and the product names. */
export type Language = 'en' | 'ka';

export interface ChatExchange {
    readonly question: string;
    /** The line naming the tool the assistant used, for example "Using NBG Rates: Convert via NBG rate". */
    readonly toolLine: string;
    readonly answer: string;
}

export interface ToolCard {
    readonly title: string;
    readonly example: string;
}

export interface PageCopy {
    readonly language: Language;
    /** The `<title>`, og:title and twitter:title. */
    readonly title: string;
    /** The meta description, og:description and twitter:description. */
    readonly description: string;
    readonly ogImageAlt: string;
    /** The label of the link to the other language: "ქართული" on the English page, "English" on the Georgian. */
    readonly otherLanguage: string;
    /** "Independent project. Not affiliated with the National Bank of Georgia." */
    readonly independence: string;
    readonly headline: string;
    readonly intro: string;
    readonly copyButton: string;
    /** Shown after a copy; the script reads it from a data attribute, so the script is the same for both pages. */
    readonly copied: string;
    readonly setupLabel: string;
    readonly setup: {
        readonly claudeAi: readonly string[];
        readonly chatGpt: readonly string[];
        readonly claudeDesktop: readonly string[];
        /** Steps around the `claude mcp add` command, which the template prints after them. */
        readonly claudeCode: readonly string[];
    };
    /** The chat window's label: an AI assistant, never Claude or ChatGPT. */
    readonly chatLabel: string;
    readonly chat: readonly [ChatExchange, ChatExchange];
    readonly askHeading: string;
    readonly cards: readonly [ToolCard, ToolCard, ToolCard, ToolCard, ToolCard];
    readonly rulesHeading: string;
    readonly rules: readonly [string, string, string, string];
    readonly selfHostHeading: string;
    readonly selfHost: string;
    readonly selfHostLink: string;
    readonly privacyHeading: string;
    readonly privacy: readonly string[];
    readonly termsHeading: string;
    readonly terms: readonly string[];
    readonly footer: {
        readonly privacy: string;
        readonly terms: string;
        readonly support: string;
        readonly source: string;
        /** Names the operator; contains OPERATOR in Latin letters on both pages. */
        readonly operatedBy: string;
    };
}
```

- [ ] **Step 1: Write the failing test `src/shell/site/page.test.ts`**

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { COPY_EN } from './copy-en.js';
import type { PageCopy } from './copy.js';
import { PAGE_CONTENT_SECURITY_POLICY, escapeHtml, renderPage } from './page.js';

interface PageCase {
    readonly copy: PageCopy;
    readonly canonical: string;
    readonly locale: string;
}

// Task 3 adds the Georgian case.
const PAGES: readonly PageCase[] = [{ copy: COPY_EN, canonical: 'https://nbg-rates.env.ge/', locale: 'en_US' }];

function blocks(html: string, tag: 'style' | 'script'): string[] {
    return [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => match[1] ?? '');
}

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('base64');
}

describe('escapeHtml', () => {
    it('escapes the five characters that matter in text and attributes', () => {
        expect(escapeHtml(`<a & "b" 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &#39;c&#39;&gt;');
    });
});

describe.each(PAGES)('the $copy.language page', ({ copy, canonical, locale }) => {
    const html = renderPage(copy, '9.9.9-test');

    it('declares UTF-8 first, its language, title and description', () => {
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain(`<html lang="${copy.language}">`);
        expect(html.indexOf('<meta charset="utf-8">')).toBeGreaterThan(0);
        expect(html.indexOf('<meta charset="utf-8">')).toBeLessThan(200);
        expect(html).toContain(`<title>${escapeHtml(copy.title)}</title>`);
        expect(html).toContain(`<meta name="description" content="${escapeHtml(copy.description)}">`);
    });

    it('links both languages, x-default and its canonical URL', () => {
        expect(html).toContain('<link rel="alternate" hreflang="en" href="https://nbg-rates.env.ge/">');
        expect(html).toContain('<link rel="alternate" hreflang="ka" href="https://nbg-rates.env.ge/ka">');
        expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://nbg-rates.env.ge/">');
        expect(html).toContain(`<link rel="canonical" href="${canonical}">`);
    });

    it('carries the share card tags with absolute URLs', () => {
        expect(html).toContain('<meta property="og:image" content="https://nbg-rates.env.ge/og.png">');
        expect(html).toContain('<meta property="og:image:width" content="1200">');
        expect(html).toContain('<meta property="og:image:height" content="630">');
        expect(html).toContain(`<meta property="og:url" content="${canonical}">`);
        expect(html).toContain(`<meta property="og:locale" content="${locale}">`);
        expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    });

    it('has the privacy and terms anchors, the URL, the operator, the support link and the version', () => {
        expect(html).toContain('id="privacy"');
        expect(html).toContain('id="terms"');
        expect(html).toContain('https://nbg-rates.env.ge/mcp');
        expect(html).toContain('Avtandil Kikabidze');
        expect(html).toContain('https://github.com/akalongman/nbg-rates-mcp/issues');
        expect(html).toContain(escapeHtml(copy.independence));
        expect(html).toContain('nbg-rates-mcp 9.9.9-test');
    });

    it('shows the four apps, the Claude Code command and both chat exchanges', () => {
        for (const app of ['claude.ai', 'ChatGPT', 'Claude Desktop', 'Claude Code']) {
            expect(html).toContain(app);
        }
        expect(html).toContain('claude mcp add --transport http nbg-rates https://nbg-rates.env.ge/mcp');
        for (const exchange of copy.chat) {
            expect(html).toContain(escapeHtml(exchange.question));
            expect(html).toContain(escapeHtml(exchange.answer));
        }
        expect(html.match(/<input type="radio" name="app"/g)).toHaveLength(4);
        expect(html).toMatch(/<input type="radio" name="app"[^>]*checked/);
    });

    it('loads nothing from another origin', () => {
        for (const [, value] of html.matchAll(/\ssrc="([^"]*)"/g)) {
            expect(value).toMatch(/^\/(?!\/)/);
        }
        for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
            if (!/rel="(canonical|alternate)"/.test(tag)) {
                expect(tag).toMatch(/href="\/(?!\/)/);
            }
        }
        expect(html).not.toMatch(/url\(|@import|<iframe|<object|<embed/i);
    });

    it('has no style attribute or inline event handler, which its policy would block', () => {
        expect(html).not.toMatch(/\sstyle=/i);
        expect(html).not.toMatch(/\son[a-z]+=/i);
    });

    it('pins its one style block and one script block by hash', () => {
        const [style, ...moreStyles] = blocks(html, 'style');
        const [script, ...moreScripts] = blocks(html, 'script');
        expect(moreStyles).toEqual([]);
        expect(moreScripts).toEqual([]);
        expect(PAGE_CONTENT_SECURITY_POLICY).toBe(
            `default-src 'none'; img-src 'self'; style-src 'sha256-${sha256(style ?? '')}'; ` +
                `script-src 'sha256-${sha256(script ?? '')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
    });
});

describe('the English copy', () => {
    it('quotes the demo figures', () => {
        expect(COPY_EN.chat[0].answer).toContain('6,376.13');
        expect(COPY_EN.chat[0].answer).toContain('2.6025');
        expect(COPY_EN.chat[1].answer).toContain('2.9257');
    });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/shell/site/page.test.ts`
Expected: FAIL, cannot resolve `./copy-en.js`.

- [ ] **Step 3: Write `hosted.ts` and `copy.ts`**

As in Interfaces. `hosted.ts` has a header comment saying these are facts about the maintainer's hosted copy, not about the server.

- [ ] **Step 4: Write `copy-en.ts`**

The English text of every field, following the spec's sections 1 to 8 and its drafts where it gives them (headline "Official NBG exchange rates, inside Claude and ChatGPT"; the intro paragraph; the first exchange's question, tool line and answer word for word; the second exchange as the spec describes it). Values the spec pins:

- `title`: `NBG Rates: official lari exchange rates in Claude and ChatGPT`; `description`: one sentence of at most 160 characters naming NBG, the lari, Claude and ChatGPT, and "free, no account".
- `otherLanguage`: `ქართული`.
- `setup.claudeAi`: the README's path (Customize, then Connectors; "+ Add", then "Add custom connector"; paste the URL and click "Add"), plus that it then also appears in the Claude mobile apps and Claude Desktop under the same account, and that on a Team or Enterprise plan an owner adds it under Organization settings, then Connectors.
- `setup.chatGpt` (checked against `https://developers.openai.com/apps-sdk/deploy/connect-chatgpt` on 2026-10-13; recheck before writing and follow the page if the labels moved): open `chatgpt.com/plugins`; select the plus button, then "Add custom MCP server"; enter a name ("NBG Rates") and the URL; leave authentication off, confirm the risk warning, then "Create as a plugin"; a workspace admin may need to allow custom MCP servers first.
- `setup.claudeDesktop`: add the connector once on claude.ai (the claude.ai tab) and it appears in Claude Desktop under the same account; to run it on the computer instead, see "Prefer to run it yourself?" below.
- `setup.claudeCode`: one step before the command ("Run this in a terminal:") and one after ("Start a new session and ask about a rate.").
- `cards`, `rules`: the spec's five tools and four rules, in that order.
- `privacy`: the spec's section 6, every claim in it; `terms`: the spec's section 7.
- `footer.operatedBy`: `Operated by Avtandil Kikabidze`; `footer.support`: `Support`; `footer.source`: `GitHub`.

- [ ] **Step 5: Write `page.ts`**

`renderPage(copy, version)` returns the whole document as one string: `<!doctype html>`, `<html lang="…">`, a `<head>` whose first child is `<meta charset="utf-8">`, then the viewport meta, `theme-color` `#1F3A5F`, title, description, the three `hreflang` links, the canonical link (`https://nbg-rates.env.ge/` for `en`, `https://nbg-rates.env.ge/ka` for `ka`), `<link rel="icon" href="/favicon.ico" sizes="any">`, `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`, the Open Graph tags (`og:type` `website`, `og:site_name` `NBG Rates`, `og:title`, `og:description`, `og:url`, `og:locale` `en_US` or `ka_GE`, `og:image` with width, height and `og:image:alt`) and the Twitter card tags, then one `<style>` with `PAGE_STYLE`. The `<body>` holds the eight sections of the spec in order, then one `<script>` with `PAGE_SCRIPT` as its last child. Every copy string goes through `escapeHtml`; URLs come from `hosted.ts` (section 5's link is `${REPOSITORY_URL}#install`, the README's install section; the language link is `/ka` on the English page and `/` on the Georgian); the header icon is the icon's SVG inline (the rect and the path from `assets/icon.svg`), not an image request.

Markup rules the tests and the policy depend on: the four app tabs are `<input type="radio" name="app" id="…">` plus `<label for="…">` with the panels selected by CSS (`:checked`), the first input `checked`, so tabs work without script; the copy button is `<button type="button" … hidden data-copied="…">` and the script removes `hidden`; the URL sits in a `<code>` the script can select; the chat is in its final state in the markup; no `style=` attribute, no `on…=` attribute, no `<img>` or `src` pointing elsewhere.

`PAGE_STYLE` and `PAGE_SCRIPT` are module constants shared by both languages. The style: the font stack and colours of the Global Constraints, a layout that works from phone width up (the hero's two columns stack below about 760 pixels, with the chat after the setup steps), visible focus outlines, and the radio inputs visually hidden but focusable. The script: reveals the copy button; on click calls `navigator.clipboard.writeText` when `navigator.clipboard` exists, and when it does not or the promise rejects, selects the URL text with a `Range`; then shows the button's `data-copied` text in a status element with `aria-live="polite"`; unless `matchMedia('(prefers-reduced-motion: reduce)').matches`, hides the chat's messages and shows them again one by one, typing each question character by character, once, then stops. The script uses `textContent`, never `innerHTML`.

`PAGE_CONTENT_SECURITY_POLICY` is built once from `createHash('sha256')` of the exact `PAGE_STYLE` and `PAGE_SCRIPT` strings, in the format the test asserts.

- [ ] **Step 6: Run the test and the gates**

Run: `npx vitest run src/shell/site/page.test.ts`, then the gates.
Expected: PASS; gates exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/shell/site/hosted.ts src/shell/site/copy.ts src/shell/site/copy-en.ts src/shell/site/page.ts src/shell/site/page.test.ts
git commit -m "Render the landing page from its English copy" -- src/shell/site/hosted.ts src/shell/site/copy.ts src/shell/site/copy-en.ts src/shell/site/page.ts src/shell/site/page.test.ts
```

---

### Task 3: The Georgian copy

**Files:**

- Create: `src/shell/site/copy-ka.ts`
- Modify: `src/shell/site/page.test.ts`

**Interfaces:**

- Consumes: `PageCopy` (Task 2), `COPY_EN` as the source text.
- Produces: `export const COPY_KA: PageCopy` with `language: 'ka'`.

- [ ] **Step 1: Add the Georgian case to the test**

In `page.test.ts` import `COPY_KA` and add to `PAGES`: `{ copy: COPY_KA, canonical: 'https://nbg-rates.env.ge/ka', locale: 'ka_GE' }`. Add:

```ts
describe('the Georgian copy', () => {
    it('writes the demo figures the Georgian way', () => {
        const amount = new Intl.NumberFormat('ka-GE', { minimumFractionDigits: 2 }).format(6376.13);
        const rate = new Intl.NumberFormat('ka-GE', { minimumFractionDigits: 4 }).format(2.6025);
        const euro = new Intl.NumberFormat('ka-GE', { minimumFractionDigits: 4 }).format(2.9257);
        expect(COPY_KA.chat[0].answer).toContain(amount);
        expect(COPY_KA.chat[0].answer).toContain(rate);
        expect(COPY_KA.chat[1].answer).toContain(euro);
    });

    it('links back to English and names the operator in Latin letters too', () => {
        expect(COPY_KA.otherLanguage).toBe('English');
        expect(COPY_KA.footer.operatedBy).toContain('Avtandil Kikabidze');
    });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/shell/site/page.test.ts`
Expected: FAIL, cannot resolve `./copy-ka.js`.

- [ ] **Step 3: Write `copy-ka.ts`**

A Georgian rendering of every field of `COPY_EN`, written for a Georgian accountant: plain, polite register, the lari as "ლარი", NBG as "საქართველოს ეროვნული ბანკი" on first mention and "ეროვნული ბანკი" after, dates as "7 ოქტომბერი 2026", numbers as `Intl.NumberFormat('ka-GE')` writes them. Product and UI names stay in Latin letters exactly as the apps show them (claude.ai, ChatGPT, Claude Desktop, Claude Code, "Add custom connector", "Add custom MCP server", "Create as a plugin"), because Georgian users see those labels in English. `footer.operatedBy` names the operator as "ავთანდილ კიკაბიძე (Avtandil Kikabidze)" after a Georgian label. The file's header comment says the text awaits the maintainer's review before release.

- [ ] **Step 4: Run the test and the gates**

Run: `npx vitest run src/shell/site/page.test.ts`, then the gates.
Expected: PASS; gates exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/shell/site/copy-ka.ts src/shell/site/page.test.ts
git commit -m "Add the Georgian landing page copy" -- src/shell/site/copy-ka.ts src/shell/site/page.test.ts
```

---

### Task 4: Serving the site, the OpenAI challenge and the browser check

**Files:**

- Create: `src/shell/site/routes.ts`
- Modify: `src/shell/http.ts`, `src/bin.ts`, `src/lambda.ts`
- Test: `src/shell/http.test.ts`, `test/e2e/http.test.ts`, `src/lambda.test.ts` (one existing test)

**Interfaces:**

- Consumes: the base64 constants (Task 1), `renderPage`, `PAGE_CONTENT_SECURITY_POLICY`, `SITE_HOST` (Task 2), `COPY_EN`, `COPY_KA` (Tasks 2, 3).
- Produces:
  - `routes.ts`: `export interface SiteOptions { readonly version: string; readonly openAiChallenge: string }` and `export function createSiteResponder(options: SiteOptions): (method: string, url: URL) => Response | undefined`. `undefined` means "not a site path here": the caller goes on to `/` text, `/mcp` or 404.
  - `http.ts`: `HttpDeps` gains `readonly openAiChallenge: string` (documented: served at `/.well-known/openai-apps-challenge`; empty leaves that path a 404); `export function parseOpenAiChallenge(value: string | undefined): string` (trimmed; undefined gives `''`).

Responder behaviour, all decided once in `createSiteResponder` (both pages rendered and encoded, the four rasters decoded, before it returns):

| Path | Host | `GET`, `HEAD` | Other methods |
| ---- | ---- | ------------- | ------------- |
| `/` | `SITE_HOST` (hostname lower-cased) | English page | 405 |
| `/ka`, `/ka/` | `SITE_HOST` | Georgian page | 405 |
| `/`, `/ka`, `/ka/` | any other | `undefined` | `undefined` |
| `/favicon.ico`, `/icon.png`, `/apple-touch-icon.png`, `/og.png`, `/robots.txt` | any | the asset | 405 |
| `/.well-known/openai-apps-challenge` | any | the token, when not empty | 405 when not empty |
| the challenge path with an empty token, anything else | any | `undefined` | `undefined` |

Headers: pages `content-type: text/html; charset=utf-8`, `content-security-policy` `PAGE_CONTENT_SECURITY_POLICY`, `cache-control: public, max-age=300`; ICO `image/x-icon`, PNGs `image/png`, robots `text/plain; charset=utf-8`, all three `cache-control: public, max-age=86400`; challenge `text/plain; charset=utf-8`, `cache-control: no-store`; 405 `allow: GET, HEAD`, `content-type: text/plain; charset=utf-8`, body `Method not allowed.`; every one of them `x-content-type-options: nosniff` and `referrer-policy: no-referrer`. `HEAD` answers the same status and headers with a null body. `robots.txt` is exactly `User-agent: *\nDisallow: /mcp\n`. The challenge body is exactly the token.

- [ ] **Step 1: Write the failing tests in `src/shell/http.test.ts`**

`handlerWith` gains `openAiChallenge: ''` in its defaults. The existing test "answers GET / with the version and the endpoint path" now uses `handlerWith({ allowedHosts: [] })` and `https://localhost/`, since the hosted host gets the page. Add:

```ts
import { FAVICON_ICO_BASE64 } from './site/assets.generated.js';
import { PAGE_CONTENT_SECURITY_POLICY } from './site/page.js';

function get(path: string, options: { host?: string; method?: string } = {}): Request {
    return new Request(`https://${options.host ?? 'nbg-rates.env.ge'}${path}`, { method: options.method ?? 'GET' });
}

describe('site paths', () => {
    it.each([
        ['/', 'text/html; charset=utf-8', 'public, max-age=300'],
        ['/ka', 'text/html; charset=utf-8', 'public, max-age=300'],
        ['/ka/', 'text/html; charset=utf-8', 'public, max-age=300'],
        ['/favicon.ico', 'image/x-icon', 'public, max-age=86400'],
        ['/icon.png', 'image/png', 'public, max-age=86400'],
        ['/apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
        ['/og.png', 'image/png', 'public, max-age=86400'],
        ['/robots.txt', 'text/plain; charset=utf-8', 'public, max-age=86400'],
    ])('answers GET %s with %s, its cache header and no log line', async (path, contentType, cacheControl) => {
        const { handler, lines } = handlerWith();
        const response = await handler(get(path));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(contentType);
        expect(response.headers.get('cache-control')).toBe(cacheControl);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(lines).toEqual([]);
    });

    it('serves the English page at / and the Georgian one at /ka, with a port and a query', async () => {
        const { handler } = handlerWith();
        const english = await handler(get('/?ref=x', { host: 'nbg-rates.env.ge:8443' }));
        expect(english.headers.get('content-security-policy')).toBe(PAGE_CONTENT_SECURITY_POLICY);
        const englishHtml = await english.text();
        expect(englishHtml).toContain('<html lang="en">');
        expect(englishHtml).toContain('nbg-rates-mcp 0.0.0-test');
        expect(await (await handler(get('/ka/'))).text()).toContain('<html lang="ka">');
    });

    it('keeps the one-line text at / and a 404 at /ka on any other host, and serves the icons there', async () => {
        const { handler } = handlerWith({ allowedHosts: [] });
        const root = await handler(get('/', { host: 'localhost:3000' }));
        expect(root.headers.get('content-type')).toMatch(/^text\/plain/);
        expect(await root.text()).toContain('MCP endpoint: POST /mcp');
        expect((await handler(get('/ka', { host: 'localhost:3000' }))).status).toBe(404);
        expect((await handler(get('/favicon.ico', { host: 'localhost:3000' }))).status).toBe(200);
    });

    it('answers HEAD with the headers and no body', async () => {
        const { handler } = handlerWith();
        for (const path of ['/', '/favicon.ico']) {
            const response = await handler(get(path, { method: 'HEAD' }));
            expect(response.status).toBe(200);
            expect(response.headers.get('cache-control')).not.toBeNull();
            expect(await response.text()).toBe('');
        }
    });

    it.each(['POST', 'PUT', 'DELETE'])('answers %s on a site path with 405 and Allow: GET, HEAD', async (method) => {
        const { handler, lines } = handlerWith();
        for (const path of ['/', '/ka', '/favicon.ico', '/robots.txt']) {
            const response = await handler(get(path, { method }));
            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('GET, HEAD');
            expect(await response.text()).toBe('Method not allowed.');
        }
        expect(lines).toEqual([]);
    });

    it('serves the favicon bytes and a robots.txt that keeps crawlers off /mcp', async () => {
        const { handler } = handlerWith();
        const favicon = new Uint8Array(await (await handler(get('/favicon.ico'))).arrayBuffer());
        expect(Buffer.from(favicon).equals(Buffer.from(FAVICON_ICO_BASE64, 'base64'))).toBe(true);
        expect(await (await handler(get('/robots.txt'))).text()).toBe('User-agent: *\nDisallow: /mcp\n');
    });

    it('answers the OpenAI challenge with the token alone, uncached, once one is set', async () => {
        const { handler } = handlerWith({ openAiChallenge: 'token-123' });
        const response = await handler(get('/.well-known/openai-apps-challenge'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe('token-123');
    });

    it('answers the challenge path 404 while no token is set', async () => {
        const { handler } = handlerWith();
        expect((await handler(get('/.well-known/openai-apps-challenge'))).status).toBe(404);
    });

    it('checks the host before any site path', async () => {
        const { handler } = handlerWith();
        expect((await handler(get('/favicon.ico', { host: 'evil.example' }))).status).toBe(421);
    });
});

describe('parseOpenAiChallenge', () => {
    it('trims a pasted token and reads unset as empty', () => {
        expect(parseOpenAiChallenge('  token-123\n')).toBe('token-123');
        expect(parseOpenAiChallenge(undefined)).toBe('');
        expect(parseOpenAiChallenge(' \n')).toBe('');
    });
});
```

In `src/lambda.test.ts`, the test "answers GET / with the text" becomes "answers GET / on the hosted host with the page": `content-type` `text/html; charset=utf-8` and a body containing `<html lang="en">`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/shell/http.test.ts src/lambda.test.ts`
Expected: FAIL (typecheck of `openAiChallenge`, missing `parseOpenAiChallenge`, and the site paths answering 404).

- [ ] **Step 3: Write `routes.ts` and wire it into `http.ts`**

`createHttpHandler` calls `createSiteResponder({ version: deps.version, openAiChallenge: deps.openAiChallenge })` once, outside the per-request function. In `handle`, right after the Host check, a defined answer from the responder is returned as is; the existing `/` text, `/mcp` and 404 code follows unchanged. Update the file's header comment to mention the site paths.

- [ ] **Step 4: Wire the entries**

`src/bin.ts` (the `--http` branch) and `src/lambda.ts` pass `openAiChallenge: parseOpenAiChallenge(process.env['NBG_RATES_OPENAI_CHALLENGE'])`. Add to the `Environment:` block of `HELP` in `bin.ts`, aligned with the lines above it:

```text
  NBG_RATES_OPENAI_CHALLENGE  Token served at /.well-known/openai-apps-challenge for OpenAI's domain check (unset or empty: 404)
```

(Widen the existing three lines' padding so all four align.)

- [ ] **Step 5: Run the unit tests**

Run: `npx vitest run src/shell/http.test.ts src/lambda.test.ts`
Expected: PASS.

- [ ] **Step 6: Extend the end-to-end test**

In `test/e2e/http.test.ts`, `startHttpChild` sets `NBG_RATES_HTTP_HOSTS` to `127.0.0.1,nbg-rates.env.ge`. Add a raw-request helper beside the existing foreign-host request (a `fetch` drops a `Host` header) that returns status, headers and body for a path and a host, and this test:

```ts
it('serves the page for the hosted host, the text for 127.0.0.1 and the favicon', async () => {
    const origin = new URL(child.url).origin;
    const page = await rawGet(origin, '/', 'nbg-rates.env.ge');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body.toString('utf8')).toContain(`nbg-rates-mcp ${version}`);
    expect(await (await fetch(`${origin}/`)).text()).toContain('MCP endpoint: POST /mcp');
    const favicon = await fetch(`${origin}/favicon.ico`);
    expect(favicon.headers.get('content-type')).toBe('image/x-icon');
    expect(Buffer.from(await favicon.arrayBuffer()).subarray(0, 4).toString('hex')).toBe('00000100');
});
```

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 7: Check the page in a real browser**

Write a throwaway preview server outside the repository (for example in the system temp directory, run with `npx tsx <file>` from the repository root): it imports `createSiteResponder` from `src/shell/site/routes.ts`, listens on `127.0.0.1`, and answers every request with the responder's answer for `new URL(request.url, 'https://nbg-rates.env.ge')`, writing the response's status, headers and bytes. Then, with the `agent-browser` skill (or the Chrome extension tools):

1. Open `/` and `/ka` at 1280 pixels wide and at 390 pixels wide and look at each: nothing overlaps or overflows horizontally, the hero stacks on the phone width, the Georgian text renders, the tabs switch.
2. Read the console on both pages: no Content Security Policy violation and no error.
3. Click "Copy URL": the confirmation text appears.
4. Run `Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })` on the page, click again: the URL text is selected, the confirmation appears and the console stays clean.
5. Reload with reduced motion emulated (or check the code path): the chat shows its final state at once.

Fix what the check finds (in Tasks 2 and 3's files if needed), rerun the unit tests, and delete the preview server.

- [ ] **Step 8: Gates and commit**

Run the gates including `npm run test:e2e`.

```bash
git add src/shell/site/routes.ts src/shell/http.ts src/shell/http.test.ts src/bin.ts src/lambda.ts src/lambda.test.ts test/e2e/http.test.ts
git commit -m "Serve the landing page, the icons and the OpenAI challenge" -- src/shell/site/routes.ts src/shell/http.ts src/shell/http.test.ts src/bin.ts src/lambda.ts src/lambda.test.ts test/e2e/http.test.ts
```

Add any Task 2 or 3 file the browser check changed to both path lists.

---

### Task 5: Binary bodies on Lambda

**Files:**

- Modify: `src/lambda.ts`, `src/shell/http-adapter.ts` (header comment only)
- Test: `src/lambda.test.ts`

**Interfaces:**

- Consumes: the site paths (Task 4).
- Produces: `ApiGatewayV2Result` unchanged in shape; `isBase64Encoded` now follows the content type.

The rule: a body is text, returned as UTF-8 with `isBase64Encoded: false`, when the response's `content-type` starts with `text/`, `application/json` or `application/javascript`, or contains `charset=` (case-insensitive); every other body, including one with no content type, is returned as base64 with `isBase64Encoded: true`.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns the favicon base64 encoded', async () => {
    const result = await handler({ ...event('apigw-get-root'), rawPath: '/favicon.ico' });
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toBe('image/x-icon');
    expect(result.isBase64Encoded).toBe(true);
    expect(result.body).toBe(FAVICON_ICO_BASE64);
});

it('answers HEAD on a binary asset with its headers and an empty body', async () => {
    const head = { ...event('apigw-get-root'), rawPath: '/og.png', requestContext: { http: { method: 'HEAD' } } };
    const result = await handler(head);
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toBe('image/png');
    expect(result.body).toBe('');
});

it('keeps text bodies as text', async () => {
    const robots = await handler({ ...event('apigw-get-root'), rawPath: '/robots.txt' });
    expect(robots.isBase64Encoded).toBe(false);
    expect(robots.body).toBe('User-agent: *\nDisallow: /mcp\n');
});
```

(`FAVICON_ICO_BASE64` imported from `./shell/site/assets.generated.js`. The existing initialize test already asserts `isBase64Encoded: false` for an MCP answer.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lambda.test.ts`
Expected: FAIL on the favicon test (`isBase64Encoded` false, body mangled by UTF-8 decoding).

- [ ] **Step 3: Implement the rule in `src/lambda.ts`**

A local `function isTextContentType(contentType: string | undefined): boolean` and the two branches in `handler`. Replace the comment "Every response this server produces is text." with one naming the rule. In `src/shell/http-adapter.ts`, the header comment's list of bodies becomes "a single JSON body, a short SSE stream, a page or a small image".

- [ ] **Step 4: Run the tests and the gates, commit**

Run: `npx vitest run src/lambda.test.ts`, then the gates including `npm run test:e2e`.

```bash
git add src/lambda.ts src/lambda.test.ts src/shell/http-adapter.ts
git commit -m "Return binary bodies base64 encoded from Lambda" -- src/lambda.ts src/lambda.test.ts src/shell/http-adapter.ts
```

---

### Task 6: The hosted server's icon and the website in the identity

**Files:**

- Modify: `src/shell/server.ts`, `src/shell/http.ts`, `src/bin.ts`, `src/lambda.ts`, `server.json`, `package.json`
- Test: `src/shell/server.test.ts`, `src/shell/http.test.ts`, `src/lambda.test.ts`

**Interfaces:**

- Consumes: `HOSTED_SERVER_ICONS`, `SITE_ORIGIN` (Task 2).
- Produces: `ServerDeps` gains `readonly icons?: readonly Icon[]`; `HttpDeps` gains `readonly serverIcons: readonly Icon[]`, handed to `createServer` as `icons`. An absent or empty list sends no `icons` key at all.

- [ ] **Step 1: Write the failing tests**

`src/shell/server.test.ts`: the registry entry schema in "identifies itself with the title, description and website of server.json" stays as is (the stdio identity, with no `icons` key, must still equal it exactly). Add:

```ts
it('sends the hosted icon only when given it, the same one server.json lists', async () => {
    const registry = z
        .object({ icons: z.array(z.object({ src: z.string(), mimeType: z.string(), sizes: z.array(z.string()) })) })
        .parse(JSON.parse(readFileSync(new URL('../../server.json', import.meta.url), 'utf8')));
    expect(registry.icons).toEqual(HOSTED_SERVER_ICONS);

    const hosted = await connectedClient({ icons: HOSTED_SERVER_ICONS });
    expect(hosted.getServerVersion()?.icons).toEqual(HOSTED_SERVER_ICONS);
    await hosted.close();

    const local = await connectedClient();
    expect(local.getServerVersion()).not.toHaveProperty('icons');
    await local.close();
});

it('names the landing page as its website, as server.json and package.json do', async () => {
    const client = await connectedClient();
    expect(client.getServerVersion()?.websiteUrl).toBe('https://nbg-rates.env.ge');
    const { homepage } = z
        .object({ homepage: z.string() })
        .parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')));
    expect(homepage).toBe('https://nbg-rates.env.ge');
    await client.close();
});
```

(`connectedClient(deps: { service?: RatesService; now?: () => Date } = {})` at line 80 gains `icons?: readonly Icon[]` in that parameter and passes it on to `createServer`; read it first and keep its current defaults.)

`src/shell/http.test.ts`: `handlerWith` defaults gain `serverIcons: []`; extend "initializes and logs the client, the protocol version and the method" or add a test that `handlerWith({ serverIcons: HOSTED_SERVER_ICONS })` answers initialize with `result.serverInfo.icons` equal to `HOSTED_SERVER_ICONS`, and the default handler with no `icons` key.

`src/lambda.test.ts`, "answers an initialize carried as a plain body": also `expect(firstMessage(result.body)).toMatchObject({ result: { serverInfo: { icons: HOSTED_SERVER_ICONS } } })`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/shell/server.test.ts src/shell/http.test.ts src/lambda.test.ts`
Expected: FAIL (no `icons` in `server.json`, the GitHub website, the missing deps fields).

- [ ] **Step 3: Implement**

- `server.ts`: `ServerDeps.icons`; `createServer` adds `icons` (a mutable copy) to the implementation info only when the list is not empty; `SERVER_IDENTITY.websiteUrl` becomes `'https://nbg-rates.env.ge'` (keep the identity's comment, which says a test keeps it equal to `server.json`).
- `http.ts`: `HttpDeps.serverIcons`, passed by `defaultMcpFetch` to `createServer`.
- `lambda.ts`: `serverIcons: HOSTED_SERVER_ICONS`. `bin.ts` (`--http`): `serverIcons: []`; the stdio `createServer` call stays without icons.
- `server.json`: `"websiteUrl": "https://nbg-rates.env.ge"` and, after it, `"icons": [{ "src": "https://nbg-rates.env.ge/icon.png", "mimeType": "image/png", "sizes": ["512x512"] }]`.
- `package.json`: `"homepage": "https://nbg-rates.env.ge"`; `bugs` and `repository` unchanged. Run `npm install --package-lock-only` only if `npm` complains; `homepage` is not in the lock file.

- [ ] **Step 4: Run the tests and the gates, commit**

Run: `npx vitest run src/shell/server.test.ts src/shell/http.test.ts src/lambda.test.ts`, then the gates including `npm run test:e2e`.

```bash
git add src/shell/server.ts src/shell/server.test.ts src/shell/http.ts src/shell/http.test.ts src/bin.ts src/lambda.ts src/lambda.test.ts server.json package.json
git commit -m "Send the hosted icon and name the landing page as website" -- src/shell/server.ts src/shell/server.test.ts src/shell/http.ts src/shell/http.test.ts src/bin.ts src/lambda.ts src/lambda.test.ts server.json package.json
```

---

### Task 7: The release smoke test checks the favicon

**Files:**

- Modify: `scripts/smoke-http.ts`

**Interfaces:**

- Consumes: `/favicon.ico` (Task 4).
- Produces: one more check, between `GET /` and `initialize`.

`scripts/smoke-http.ts` runs under plain `node` (erasable TypeScript only, no imports from the package). After the `GET /` check add: `GET /favicon.ico` must answer 200 with `content-type` `image/x-icon`; otherwise `fail(\`GET /favicon.ico answered ${status} ${contentType}\`)`. Update the header comment's list of checks.

- [ ] **Step 1: Prove the new check fails on a server without the route**

Start the published 0.5.1 server, which has no favicon route: `npx -y nbg-rates-mcp@0.5.1 --http --port 3901 &`, wait for its ready line on stderr (`serving HTTP on ...`), and run `node scripts/smoke-http.ts http://127.0.0.1:3901/mcp 0.5.1` after the edit of Step 2.
Expected: exit 1 with `GET /favicon.ico answered 404 text/plain; charset=utf-8`. Stop that server.

- [ ] **Step 2: Add the check**

As described above.

- [ ] **Step 3: Prove it passes on this build**

Run: `npm run build && node dist/bin.js --http --port 3902 &`, wait for the ready line, then `node scripts/smoke-http.ts http://127.0.0.1:3902/mcp "$(node -p "require('./package.json').version")"`, then stop the server. (The conversion check calls NBG for real.)
Expected: exit 0.

- [ ] **Step 4: Gates and commit**

```bash
git add scripts/smoke-http.ts
git commit -m "Check the favicon in the release smoke test" -- scripts/smoke-http.ts
```

---

### Task 8: Directory listings and the hosted spec's amendment

**Files:**

- Create: `docs/directory-listings.md`
- Modify: `docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md`

**Interfaces:**

- Consumes: the URLs and anchors of Tasks 2 and 4, the tool names in `src/shell/server.ts`.
- Produces: the texts the maintainer pastes into both portals.

- [ ] **Step 1: Write `docs/directory-listings.md`**

English, agent-neutral, no em or en dashes. Sections:

1. **What only the maintainer can do**, in order: verify the OpenAI developer identity as the individual Avtandil Kikabidze; record the demo video; create the plugin in OpenAI's portal and copy the domain token; set it in the iac repository (variable `nbg_rates_mcp_openai_challenge`, procedure in its `docs/aws.md`), apply and promote the version; run OpenAI's domain verification; build and upload OpenAI's plugin ZIP; submit to both directories.
2. **Anthropic Connectors Directory**: name `NBG Rates`; a one-liner (at most 200 characters); a description (at most 2,000) drawn from the page and the README; categories (your choice of the portal's list, named as such); documentation URL `https://nbg-rates.env.ge`; privacy policy URL `https://nbg-rates.env.ge/#privacy`; support `https://github.com/akalongman/nbg-rates-mcp/issues`; icon `assets/icon.png`; the MCP URL; authentication none.
3. **OpenAI app directory**: display name `NBG Rates`; short description of at most 30 characters (count it in the file, for example `Official NBG lari rates`, 23); long description (at most 4,000); website `https://nbg-rates.env.ge`, support `https://github.com/akalongman/nbg-rates-mcp/issues`, privacy `https://nbg-rates.env.ge/#privacy`, terms `https://nbg-rates.env.ge/#terms`; logo and composer icon `assets/icon.png` (512 by 512 PNG, square, within OpenAI's 48 to 4096 pixel and 5 MiB limits); then the test cases in OpenAI's fields (description, prompt, tools triggered, expected behaviour), exactly five positive and three negative:

   | Kind | Prompt | Tools | Expected behaviour |
   | ---- | ------ | ----- | ------------------ |
   | positive | What were the official NBG rates for USD and EUR on 1 March 2026? | `nbg_get_rates` | Both rates in GEL per one unit, with the date they took effect |
   | positive | Convert 1,200 GBP to GEL at today's NBG rate. | `nbg_convert` | The amount in GEL rounded half up to the tetri, the rate and its effective date |
   | positive | Convert these invoices to GEL, each at the NBG rate of its own date: 500 USD on 2 October 2026 and 300 EUR on 5 October 2026. | `nbg_convert_many` | Each amount at its own date's rate, and the total |
   | positive | How did the US dollar move against the lari in September 2026? | `nbg_rate_history` | First, last, change, lowest and highest with dates, and the average |
   | positive | Which currencies does the National Bank of Georgia quote? | `nbg_list_currencies` | The codes with NBG's units (for example JPY per 100) |
   | negative | What will NBG's USD rate be next Friday? | `nbg_get_rates` | No rate: NBG has not published it; the answer says when NBG publishes and gives the latest rate |
   | negative | Convert 100 XYZ to GEL. | `nbg_convert` | No conversion: XYZ is not a currency NBG quotes; the answer suggests listing the currencies |
   | negative | What is TBC Bank's dollar buying rate today? | none | The connector is not used for a commercial bank's rate; the answer says it covers NBG's official rates only |

   Before writing the negative rows' expected behaviour, read `describeError` in `src/shell/server.ts` for what the server actually answers, and match it.
4. **Where the texts live**: the page copy is `src/shell/site/copy-en.ts` and `copy-ka.ts`; a wording change there is a release.

- [ ] **Step 2: Amend the hosted endpoint spec**

Extend its amendment paragraph near the top with one sentence: amended again for 0.6.0, whose landing page, icons and binary Lambda bodies are specified in `2026-10-13-landing-page-design.md`, which wins where the two differ. Then correct the two statements that no longer hold: the step that says `GET /` answers 200 `text/plain` (line 172 at the time of writing) gains "on any host but `nbg-rates.env.ge`, which serves the landing page (see the 0.6.0 design)"; and the sentence that every response this server produces is text (line 321) says instead that the Lambda entry returns a non-text body base64 encoded. Leave every other line as it is.

- [ ] **Step 3: Check and commit**

Run: `grep -nP '[\x{2013}\x{2014}]' docs/directory-listings.md` and `git diff --stat -- docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md`.
Expected: no dash found; the spec's diff is the amendment sentence and the two corrected statements only. (`docs/` is outside Prettier's scope by `.prettierignore`; keep the files' existing 80-column wrapping by hand.)

```bash
git add docs/directory-listings.md docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md
git commit -m "Write the directory listings and amend the hosted spec" -- docs/directory-listings.md docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md
```

---

### Task 9: README, changelog and the 0.6.0 release commit

**Files:**

- Modify: `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, `manifest.json`, `server.json`, `.github/repository.json`

**Interfaces:**

- Consumes: everything above.
- Produces: the release commit for `v0.6.0` (the Georgian review and the tag are the maintainer's; see "After the tasks").

- [ ] **Step 1: README**

- After the first paragraph, one line linking the landing page: `**[nbg-rates.env.ge](https://nbg-rates.env.ge)**: what it does and how to add it, in English and Georgian.`
- In "claude.ai, Claude mobile and ChatGPT (nothing to install)": keep the URL block and the claude.ai sentence; replace the ChatGPT sentence with the plugin path of Task 2 in one sentence (open `chatgpt.com/plugins`, the plus button, "Add custom MCP server", the URL, no authentication, "Create as a plugin"; workspace policies may hide the option) and point to the landing page for step-by-step instructions per app. Keep the privacy paragraph in step with the page: the same two logs, the same 30 days, and one more sentence that the landing page sets no cookies and loads nothing from anyone else.
- Environment variables table: add `| NBG_RATES_OPENAI_CHALLENGE | The token OpenAI's domain verification expects at /.well-known/openai-apps-challenge, served as plain text. Unset or empty: that path is a 404. |` and run `npx prettier --write README.md`.

In `.github/repository.json`, `homepage` becomes `https://nbg-rates.env.ge` (the maintainer applies it to GitHub after the push; see "After the tasks").

- [ ] **Step 2: CHANGELOG and versions**

After the intro paragraph and before `## 0.5.1 - 2026-10-13`, with the date of the day the release commit is made:

```markdown
## 0.6.0 - YYYY-MM-DD

Added: a landing page at https://nbg-rates.env.ge, in English and in Georgian at `/ka`, with setup steps for claude.ai, ChatGPT, Claude Desktop and Claude Code, a short demo conversation, and the privacy and terms sections the Anthropic and OpenAI directories ask for; an icon redrawn without a font dependency, served as a favicon, a touch icon and a 1200 by 630 share card; the hosted server's icon in `serverInfo.icons` and in `server.json`; `/.well-known/openai-apps-challenge` and the `NBG_RATES_OPENAI_CHALLENGE` variable for OpenAI's domain verification; `docs/directory-listings.md` with the listing texts and test cases.

Changed: `server.json`, the server identity, `package.json` and the GitHub repository's homepage name https://nbg-rates.env.ge as the website; the Lambda entry returns non-text bodies base64 encoded; the release smoke test also checks `/favicon.ico`.

Fixed: a `GET` or `DELETE` to `/mcp` is answered 405 with the `Allow: POST` header a 405 must carry.
```

Run:

```bash
npm version 0.6.0 --no-git-tag-version
sed -i 's/"version": "0.5.1"/"version": "0.6.0"/' manifest.json server.json
grep -rn '0\.5\.1' package.json manifest.json server.json
```

Expected: `npm version` prints `v0.6.0`; the grep prints nothing.

- [ ] **Step 3: Gates and release checks**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`
Expected: all exit 0.

Run: `bash scripts/build-bundle.sh && npx tsx scripts/check-release.ts 0.6.0`
Expected: the bundle builds and validates, the check prints nothing, exit 0 (if it complains only about npm's version, rerun with Node 24's npm first on `PATH`).

Run: `npm pack --dry-run 2>&1 | grep -c 'dist/shell/site/'`
Expected: at least 7 (the site's compiled modules are in the package, so the Lambda zip built from it has them).

Run: `grep -rnP '[\x{2013}\x{2014}]' README.md CHANGELOG.md src scripts assets/og.svg docs/directory-listings.md`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md package.json package-lock.json manifest.json server.json .github/repository.json
git commit -m "Release 0.6.0" -- README.md CHANGELOG.md package.json package-lock.json manifest.json server.json .github/repository.json
```

---

## After the tasks (maintainer)

1. Review the Georgian copy in `src/shell/site/copy-ka.ts` (and, if wanted, the English in `copy-en.ts`) on a local preview; any change is a commit before the tag.
2. Push `main` and tag `v0.6.0`. The release workflow deploys to Lambda, and its smoke test now reads the page's footer and the favicon. Then run `scripts/apply-repo-settings.sh` to move the GitHub homepage to the landing page.
3. Check `https://nbg-rates.env.ge`, `/ka` and a link preview (for example by pasting the URL into a chat that unfurls links).
4. The OpenAI token, after the iac plan has run: the order in the iac repository's `docs/aws.md`.
