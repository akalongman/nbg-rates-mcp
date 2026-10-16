# Browser Redirect at /mcp and Independent Share Text (0.6.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser that opens `https://nbg-rates.env.ge/mcp` lands on the landing page while MCP clients keep today's answers, and the page title and share description say the project is independent; released as 0.6.3.

**Architecture:** The site responder in `src/shell/site/routes.ts` gains the request's `Accept` header and answers a browser visit to `/mcp` on the site host with a 302 to `/`; every other `/mcp` request falls through to the MCP handler unchanged. The title and description are copy in `copy-en.ts` and `copy-ka.ts`.

**Tech Stack:** TypeScript on Node 22 and 24, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-browser-redirect-and-share-text-design.md`

## Global Constraints

- Browser visit, all of: host is `SITE_HOST` (`nbg-rates.env.ge`); path `/mcp` or `/mcp/`, any query; method `GET` or `HEAD`; `Accept` contains `text/html` and not `text/event-stream`, case-insensitive; no `Accept` is not a browser visit.
- Its answer: status 302, `location: /`, `cache-control: no-store`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, no body. It writes no MCP request log line.
- Every other `/mcp` request reaches the MCP handler exactly as today (a `GET` with `Accept: text/event-stream` answers 405 with `Allow: POST`).
- English title, verbatim: `NBG Rates (independent): official lari exchange rates in Claude and ChatGPT`
- Georgian title, verbatim (owner confirms before the tag): `NBG Rates (დამოუკიდებელი პროექტი): ლარის ოფიციალური კურსები Claude-სა და ChatGPT-ში`
- English description, verbatim: `Official National Bank of Georgia (NBG) lari rates in Claude and ChatGPT, from an independent project not affiliated with the bank: any date, exact conversions, free, no account.`
- Georgian description, verbatim (owner confirms before the tag): `საქართველოს ეროვნული ბანკის ოფიციალური კურსები Claude-სა და ChatGPT-ში, დამოუკიდებელი პროექტისგან, რომელიც ბანკთან არ არის დაკავშირებული: ლარის კურსი ნებისმიერი თარიღისთვის და ზუსტი კონვერტაცია, უფასოდ და რეგისტრაციის გარეშე.`
- Gates: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`; for the release, `bash scripts/build-bundle.sh && npx tsx scripts/check-release.ts 0.6.3`.
- No em or en dashes anywhere. Repository prose is agent-neutral. Commits on `main`, path-limited (`git add <paths> && git commit -m "<title>" -- <paths>`), signed as configured, titles under 72 characters, no trailers. Never push or tag.

## Review Focus

1. An MCP client's `GET /mcp` with `Accept: text/event-stream`, alone or beside `text/html`, must never be redirected. Task 1 tests both.
2. A browser `HEAD /mcp` gets the same 302 and no body. Task 1 tests it.
3. The Lambda adapter must carry a bodiless 302 and its `location` header through API Gateway. Task 1 tests it in `src/lambda.test.ts`.
4. Other hosts (a local `--http` server, the API Gateway default domain) keep today's 405. Task 1 tests a foreign host.
5. Browsers send `Accept` in any case and with parameters (`text/html;q=0.9`). Task 1 tests an upper-case value.

---

### Task 1: Send a browser at /mcp to the landing page

**Files:**
- Modify: `src/shell/site/routes.ts` (`createSiteResponder` and its returned `respond`), `src/shell/http.ts:175` (the `site(...)` call)
- Test: `src/shell/http.test.ts` (the `site paths` describe block and the `get` helper), `src/lambda.test.ts`

**Interfaces:**
- Produces: `createSiteResponder(options: SiteOptions): (method: string, url: URL, accept: string | null) => Response | undefined`. `http.ts` passes `request.headers.get('accept')`.

- [ ] **Step 1: Write the failing tests**

In `src/shell/http.test.ts`, extend the `get` helper with an optional `accept` (sent as the `accept` header when given), and add under `site paths`, with `BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'`:

- `sends a browser that opens %s to the landing page`, `it.each(['/mcp', '/mcp/', '/mcp?ref=card'])`: status 302, `location` `/`, `cache-control` `no-store`, `x-content-type-options` `nosniff`, `referrer-policy` `no-referrer`, `await response.text()` is `''`, and `lines` is `[]`.
- `answers a browser HEAD /mcp with the same redirect and no body`: status 302, `location` `/`, body `''`.
- `reads the Accept header without regard to case`: `accept: 'TEXT/HTML'` gives 302.
- `keeps MCP clients on 405 at /mcp`, `it.each(['text/event-stream', 'text/html, text/event-stream', 'application/json, text/event-stream'])`: status 405, `allow` `POST`, and one log line with `method: null`, `status: 405`.
- `keeps the 405 on any other host`: `handlerWith({ allowedHosts: [] })`, `get('/mcp', { host: 'example.test', accept: BROWSER_ACCEPT })`: status 405, `allow` `POST`.

The existing `answers %s /mcp with 405 and Allow: POST` (no `Accept`) stays as it is.

In `src/lambda.test.ts`, `redirects a browser at /mcp through API Gateway`: `{ ...event('apigw-get-root'), rawPath: '/mcp', headers: { host: 'nbg-rates.env.ge', accept: BROWSER_ACCEPT } }` gives `statusCode` 302, `headers.location` `/`, `body` `''`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit src/shell/http.test.ts src/lambda.test.ts`
Expected: FAIL on the redirect cases (405 instead of 302); the 405 cases already pass.

- [ ] **Step 3: Implement the rule in `routes.ts` and pass the header in `http.ts`**

The browser-visit check of Global Constraints runs before the page and file lookups; a match returns the 302, anything else at `/mcp` returns `undefined` so the caller's MCP routing runs. Update the module comment and the `respond` comment to name the redirect.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/shell/http.test.ts src/lambda.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gates and commit**

```bash
git add src/shell/site/routes.ts src/shell/http.ts src/shell/http.test.ts src/lambda.test.ts
git commit -m "Send a browser that opens /mcp to the landing page" -- src/shell/site/routes.ts src/shell/http.ts src/shell/http.test.ts src/lambda.test.ts
```

---

### Task 2: Say "independent" in the title and the share description

**Files:**
- Modify: `src/shell/site/copy-en.ts:8-11`, `src/shell/site/copy-ka.ts:13-16`, `docs/superpowers/specs/2026-10-13-landing-page-design.md:247`
- Test: `src/shell/site/page.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: nothing code depends on.

- [ ] **Step 1: Write the failing test**

In `src/shell/site/page.test.ts`, `names the project independent near the start of each title and description`:
- `COPY_EN.title.indexOf('independent') + 'independent'.length` and `COPY_KA.title.indexOf('დამოუკიდებელი') + 'დამოუკიდებელი'.length` are each at most 30, and each `indexOf` is not -1;
- `COPY_EN.description.indexOf('not affiliated with the bank') + 'not affiliated with the bank'.length` and `COPY_KA.description.indexOf('არ არის დაკავშირებული') + 'არ არის დაკავშირებული'.length` are each at most 140, and each `indexOf` is not -1.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/shell/site/page.test.ts`
Expected: FAIL (no title says "independent" today).

- [ ] **Step 3: Set the four texts of Global Constraints**

`title` and `description` in both copy files, verbatim. In the landing-page spec, line 247's "a title and a meta description in its language" becomes "a title and a meta description in its language, each saying near its start that the project is independent (`2026-10-16-browser-redirect-and-share-text-design.md`)", rewrapped.

- [ ] **Step 4: Run the gates and commit**

Run: the gates, then `grep -cP '[\x{2013}\x{2014}]' src/shell/site/copy-en.ts src/shell/site/copy-ka.ts docs/superpowers/specs/2026-10-13-landing-page-design.md`
Expected: all pass; every count `0`.

```bash
git add src/shell/site/copy-en.ts src/shell/site/copy-ka.ts src/shell/site/page.test.ts docs/superpowers/specs/2026-10-13-landing-page-design.md
git commit -m "Say in the page title and description that NBG Rates is independent" -- src/shell/site/copy-en.ts src/shell/site/copy-ka.ts src/shell/site/page.test.ts docs/superpowers/specs/2026-10-13-landing-page-design.md
```

---

### Task 3: Release 0.6.3

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `package-lock.json` (the two root `version` fields), `manifest.json`, `server.json` (both `version` fields)

**Interfaces:**
- Consumes: Tasks 1 and 2 committed.
- Produces: the commit the owner tags `v0.6.3`.

- [ ] **Step 1: Write the CHANGELOG entry**

Above `## 0.6.2`, with the commit's date:

```markdown
## 0.6.3 - <YYYY-MM-DD>

Changed: the landing page's title and share description say, near their start and in English and Georgian, that NBG Rates is an independent project not affiliated with the National Bank of Georgia, so link previews say it too; a browser that opens https://nbg-rates.env.ge/mcp is sent to the landing page instead of an error, while MCP clients get the same answers as before.
```

- [ ] **Step 2: Bump the version to 0.6.3 in the five places**

Run: `grep -n '"version"' package.json manifest.json server.json && sed -n '1,12p' package-lock.json | grep -n version`
Expected: every listed field reads `0.6.3`.

- [ ] **Step 3: Run the gates and the release checks, then commit**

Run: the gates, then `bash scripts/build-bundle.sh && npx tsx scripts/check-release.ts 0.6.3`, then `grep -cP '[\x{2013}\x{2014}]' CHANGELOG.md`
Expected: all pass; count `0`.

```bash
git add CHANGELOG.md package.json package-lock.json manifest.json server.json
git commit -m "Release 0.6.3" -- CHANGELOG.md package.json package-lock.json manifest.json server.json
```

---

## After the run (the driver, with the owner's go-ahead)

1. The owner confirms the Georgian title and description.
2. Push `main`, watch CI on the pushed commit to its end.
3. Right before the tag, a hosted conversion succeeds: `node scripts/smoke-http.ts https://nbg-rates.env.ge/mcp 0.6.2`.
4. Tag `v0.6.3` (signed, annotated, message `v0.6.3`), push it, watch the release run to its end.
5. Check live: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'accept: text/html' https://nbg-rates.env.ge/mcp` prints `302 https://nbg-rates.env.ge/`; the same with `-H 'accept: text/event-stream'` prints `405` and the `allow` header is `POST`; the `/` and `/ka` pages carry the new `og:title` and `og:description`.
