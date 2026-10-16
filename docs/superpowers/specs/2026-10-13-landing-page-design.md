# nbg-rates-mcp 0.6.0: a landing page, an icon and directory readiness

Date: 2026-10-13. Amends `2026-10-12-hosted-endpoint-design.md` (the
hosted endpoint spec) where it describes `GET /`, the paths the handler
answers and the Lambda result; everything else there stands. The
arithmetic spec of 2026-10-12 is unchanged.

## Purpose

The hosted connector at `https://nbg-rates.env.ge/mcp` works, but
nothing around it looks like a product. Opening the host in a browser
shows one line of plain text, there is no icon anywhere, and neither
Anthropic's Connectors Directory nor OpenAI's app directory would accept
a submission today, because both ask for a website, an icon and privacy,
terms and support links.

This change gives the host a landing page in English and Georgian that
shows the connector at work and tells a visitor how to add it, an icon
the page, browsers and MCP clients can show, and every piece a directory
submission needs that lives in code or infrastructure. The submissions
themselves stay with the maintainer.

Success: a person who opens `https://nbg-rates.env.ge` understands what
the connector does within seconds and can copy the URL and follow the
steps for their app; the icon shows in browser tabs, on link previews and
in any client that reads an MCP server icon; both directory submissions
can be made without further code changes.

## What the maintainer decided

These were decided in conversation on 2026-10-13 and are not open to the
builder:

1. One page on `nbg-rates.env.ge`, in the "chat demo" direction: a
   headline, the connector URL with a copy button and setup steps per
   app, beside a chat that shows a real conversion. Chosen over a
   video-first page and a plain card.
2. English and Georgian.
3. The favicon and every other branding asset live on
   `nbg-rates.env.ge`. Nothing is added to, or served from, the `env.ge`
   apex, even though claude.ai is reported to take a custom connector's
   icon from it (see Background).
4. The name stays "NBG Rates" on the page and in both listings, with a
   line saying the project is independent of and not affiliated with the
   National Bank of Georgia right under the name. The listing is renamed
   only if a reviewer objects.
5. Privacy and terms are short sections at the bottom of the page, not
   separate pages. The listings link to them by fragment.
6. The server sends an icon to MCP clients and `server.json` lists one
   for the MCP Registry.
7. Directory requirements for Anthropic and OpenAI are covered now.
8. The publisher is the maintainer as an individual, Avtandil Kikabidze,
   not an organisation: OpenAI verifies the maintainer as an individual
   developer, and the operator line, the privacy section and both
   listings name the same person.

## Background (checked 2026-10-13)

- claude.ai's custom connector icon. Developers report, in open issues
  `anthropics/claude-ai-mcp#838` and `#152` (April to October 2026), that
  claude.ai ignores `serverInfo.icons` and a favicon on the MCP host, and
  instead asks Google's favicon service for the last two labels of the
  host (`env.ge` here). Anthropic documents none of this. Google currently
  answers `url=http://env.ge` with its default globe, because `env.ge`
  has no address records. Per decision 3 this is accepted: the page and
  icon do not promise an icon in claude.ai's connector list.
- Anthropic's directory, from `claude.com/docs/connectors/building/`
  (`submission`, `review-criteria`) and the Software Directory Policy:
  no-auth servers are accepted for public data; every tool needs a
  `title` and the applicable `readOnlyHint` or `destructiveHint` (all five
  tools already carry a title and all four hints); the listing asks for a
  name (up to 100 characters), a one-liner (up to 200), a description (up
  to 2,000), categories, a documentation URL, a privacy policy URL that
  explains "data collection, usage, and retention", a support contact and
  an icon (no format or size documented). Tool descriptions are rejected
  for five prompt-injection patterns: instructing calls to tools the user
  did not request, interfering with other tools, pulling instructions
  from external sources, hidden or encoded instructions, and behaviour
  unrelated to the tool's function. The display and amount sentences in
  the current descriptions (`DISPLAY_RULE`, `AMOUNT_RULE`) describe how to
  present the tool's own result and match none of the five, so the
  descriptions stay as they are. Submissions are listed as Community
  connectors after an automated scan.
- OpenAI's directory, from `developers.openai.com/apps-sdk/deploy/submission`
  and the app submission guidelines: display name and short description
  up to 30 characters each, long description up to 4,000; website,
  support, privacy policy and terms of service URLs are all required, over
  HTTPS, and "must be accessible and identify the same publisher as the
  submission"; domain verification fetches
  `https://<host>/.well-known/openai-apps-challenge`, which must return
  only the token as plain text; review needs exactly five positive and
  three negative test cases (positive ones name the tools they trigger and
  the expected behaviour) and a demo video; the developer is verified as
  an individual or an organisation; the logo and the composer icon (both
  required) are each square, at least 48 by 48, PNG, JPEG, WebP or SVG, at
  most 5 MiB and at most 4096 pixels a side, so `assets/icon.png` serves
  as both; names must not end in "MCP", and the guidelines
  say "Only use intellectual property that you own or have permission to
  use" (decision 4 accepts that risk).
- MCP specification 2025-11-25, `icons`: `src` is an HTTPS or `data:` URI;
  clients that render icons must support PNG and JPEG; clients should
  check that an icon URL has the server's origin, fetch it without
  credentials and treat SVG with care. The MCP Registry's `server.json`
  schema (2025-12-11) accepts `icons` with an HTTPS `src` of at most 255
  characters, no `data:`. The SDK (2.3.1) copies the whole `serverInfo`,
  icons included, into the `_meta` of every result it sends a client on
  the 2026-07-28 revision (`stampServerInfoMeta`), not only into the
  `initialize` result, so an icon in `serverInfo` travels with every
  tool call.
- The hosted endpoint today: `GET /` answers 200 `text/plain` with
  `nbg-rates-mcp <version>. MCP endpoint: POST /mcp ...`, which the
  release smoke test checks; the Lambda result is always text
  (`isBase64Encoded: false`); the npm package ships only `dist`,
  `README.md`, `LICENSE` and `CHANGELOG.md`, and the Lambda zip is built
  from that tarball, so anything the page needs must end up inside
  `dist`; the stage throttle (10 requests a second, burst 10) and the
  reserved concurrency (10) are shared by every path.
- Traffic in the 24 hours before this design: 742 requests, mostly
  connector calls, internet scanners (`/.env`, `/.git/config`) and 92
  requests for `/favicon.ico`. Every 503 in that window came from the
  placeholder code before 0.5.0 went live. Nothing alerts on errors or
  throttling; the only alarms in the account are the billing alarm and
  the budgets.

## Settled in review

A builder's read of the first draft raised these; they were settled by
the designer, not the maintainer, and the maintainer may overturn them:

1. Only the hosted server sends an icon in `serverInfo`, as an HTTPS
   URL on its own origin; stdio and `--http` send none (see The icon).
2. The page is served only on the host `nbg-rates.env.ge`; any other
   host keeps today's one-line text (see Paths).
3. The Claude Desktop tab describes the connector, which syncs from
   claude.ai; the extension stays in section 5 of the page.
4. `assets/icon.png` serves as both of OpenAI's required images, the
   logo and the composer icon.

## Goals

- The landing page, in English at `/` and Georgian at `/ka`.
- One icon, redrawn so it does not depend on an installed font, served as
  a favicon and as PNGs, sent in `serverInfo.icons` by the hosted server
  and listed in `server.json`.
- A share card (Open Graph and Twitter card tags with a 1200 by 630
  image), so a link posted anywhere previews with the icon and the
  headline. This is the builder's addition to the maintainer's request
  for marketing improvements, small enough to include.
- The OpenAI domain verification route.
- Alarms that tell the maintainer when the endpoint fails or turns
  callers away, and a saved query that splits traffic by path and status.
- The listing texts and the OpenAI test cases, written down in the
  repository, ready to paste.

## Non-goals

- Submitting to either directory, verifying the developer identity with
  OpenAI, recording the demo video and building OpenAI's plugin ZIP: the
  maintainer does these, with the texts from `docs/directory-listings.md`.
- Anything on the `env.ge` apex.
- Rewording the tool descriptions (see Background).
- A content delivery network in front of the API. The page is small and
  cached by browsers; a CDN is reconsidered only if the throttle alarm
  shows page traffic crowding out connector calls.
- Removing the Claude Desktop extension (MCPB). It stays as the route for
  people whose Team or Enterprise owner has not added the connector, for
  people who want their questions to go straight from their computer to
  NBG, and as a fallback if the hosted copy stops. This is the builder's
  recommendation; the maintainer raised the question and did not ask for
  removal.

## Anti-goals

The change fails, even if it works, if:

- the page loads anything from another origin (fonts, scripts, styles,
  images, analytics, video embeds). The privacy section can then truly
  say the page sets no cookies and tells nobody else about the visit;
- the page imitates Claude's or ChatGPT's interface or uses Anthropic's
  or OpenAI's logos. The apps are named in text only, and the demo chat
  is a neutral chat window;
- the page or the icon routes make connector calls slower or less
  available in normal traffic (heavy responses, uncached assets, work at
  request time that the connector path does not do);
- the Georgian text goes live without the maintainer's review.

## Change 1: the server (this repository)

### Paths and answers

The Host check (421 for a host not in `NBG_RATES_HTTP_HOSTS`) still runs
first, for every path. The page is the maintainer's: it names the
operator, describes the hosted copy's logs and offers its URL, so it is
served only when the request's host (port stripped, lower-cased) is
`nbg-rates.env.ge`, a constant in the code. On any other host, which
means a local `--http` server or someone else's deployment, `GET /`
keeps today's one-line `text/plain` answer and `/ka` is a 404; the icon
files, `robots.txt` and the challenge route answer on every host. Then:

| Path | Methods | Answer |
| ---- | ------- | ------ |
| `/` | `GET`, `HEAD` | 200 `text/html; charset=utf-8`, the English page (other hosts: today's text) |
| `/ka` and `/ka/` | `GET`, `HEAD` | 200 `text/html; charset=utf-8`, the Georgian page (other hosts: 404) |
| `/favicon.ico` | `GET`, `HEAD` | 200 `image/x-icon`, 16, 32 and 48 pixel images |
| `/icon.png` | `GET`, `HEAD` | 200 `image/png`, 512 by 512 |
| `/apple-touch-icon.png` | `GET`, `HEAD` | 200 `image/png`, 180 by 180 |
| `/og.png` | `GET`, `HEAD` | 200 `image/png`, 1200 by 630 share card |
| `/robots.txt` | `GET`, `HEAD` | 200 `text/plain`, allows everything except `/mcp` |
| `/.well-known/openai-apps-challenge` | `GET`, `HEAD` | 200 `text/plain; charset=utf-8`, the token and nothing else, when `NBG_RATES_OPENAI_CHALLENGE` is set and not empty; otherwise the usual 404 |
| `/mcp`, `/mcp/` | as today | unchanged |
| anything else | any | 404 as today |

Another method on a page or asset path answers 405 with
`Allow: GET, HEAD` and a short `text/plain` body. The forbidden-method
405 of 0.5.1 is unchanged.

Headers on every page and asset response:

- `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- Pages: a `Content-Security-Policy` that allows nothing from another
  origin and nothing inline except the page's own style and script,
  pinned by hash or by `'self'` files, the builder's choice: at least
  `default-src 'none'`, `img-src 'self'`, `style-src` and `script-src`
  limited to the page's own, `base-uri 'none'`, `form-action 'none'`,
  `frame-ancestors 'none'`. `Cache-Control: public, max-age=300`.
- Icons, the share card and `robots.txt`: `Cache-Control: public,
  max-age=86400`.
- The challenge token: `Cache-Control: no-store`.

None of these paths writes a usage log line; the access log already
records them. `HEAD` answers the same headers with no body.

### The page

One HTML document per language, with its CSS and its script inside it or
served from this host only. It works without JavaScript: the copy button
and the chat animation are the only scripted parts, and without script
the chat shows its final state and the URL stays selectable. The layout
works from phone width up; on a phone the hero's two columns stack, with
the chat below the setup steps. Fonts are the system's own; the font
stack covers Georgian (for example `system-ui`, `"Segoe UI"`,
`"Noto Sans Georgian"`, `Sylfaen`, `sans-serif`). Colours come from the
icon: navy `#1F3A5F` on white, with light blue-grey surfaces. Light
theme only is acceptable.

Every page carries, in its HTML: `<html lang="en">` or `lang="ka"`, a
title and a meta description in its language, each saying near its start
that the project is independent
(`2026-10-16-browser-redirect-and-share-text-design.md`), `<link
rel="alternate" hreflang>` entries for both languages and `x-default`
(English), a canonical URL, the favicon and touch icon links, and the Open
Graph and Twitter card tags pointing at `https://nbg-rates.env.ge/og.png`
(absolute URLs, since crawlers fetch them).

Sections, top to bottom (the mockup of 2026-10-13 shows them):

1. Header: the icon, "NBG Rates", a link to the other language
   ("ქართული" on the English page, "English" on the Georgian one) and a
   link to the GitHub repository. Under the name, small: "Independent
   project. Not affiliated with the National Bank of Georgia." (and its
   Georgian equivalent).
2. Hero, two columns.
   - Left: a headline (English draft: "Official NBG exchange rates,
     inside Claude and ChatGPT"), one paragraph ("Ask in plain words for
     the lari rate on any date, convert an amount or a list of invoices,
     or see how a currency moved. Free, no account, no key."), the URL
     `https://nbg-rates.env.ge/mcp` with a copy button that confirms the
     copy in text, and tabs for claude.ai, ChatGPT, Claude Desktop and
     Claude Code, each showing that app's numbered steps. The claude.ai
     steps are the README's. The Claude Desktop tab is about the
     connector, not the extension: once added on claude.ai it appears in
     Claude Desktop and the mobile apps under the same account, and the
     tab says so and points to section 5 for a local install. The
     ChatGPT steps are
     the current developer mode path (checked against OpenAI's help
     pages when written, since the labels move); the Claude Code tab
     shows the `claude mcp add` command for the remote URL
     (`claude mcp add --transport http nbg-rates https://nbg-rates.env.ge/mcp`).
   - Right: a neutral chat window labelled as an AI assistant, not as
     Claude or ChatGPT. It plays a short exchange: the question "How much
     is 2,450 USD in GEL at the NBG rate on 7 October 2026?", a line
     naming the tool used ("Using NBG Rates: Convert via NBG rate"), and
     the answer "2,450 USD is 6,376.13 GEL, at the official NBG rate of
     2.6025 GEL per dollar in force on 7 October 2026." A second exchange
     asks for the EUR rate on Sunday 4 October 2026 and answers that
     Sunday has no rate of its own, so the rate in force is 2.9257 GEL per
     euro, set by NBG on Friday 2 October and in force from Saturday 3
     October. Both figures are NBG's published rates, as held in
     `test/fixtures/en-2026-10-07.json` and `en-2026-10-04.json`
     (2,450 x 2.6025 = 6,376.125, rounded half up to 6,376.13). The
     animation types the messages once and stops; with
     `prefers-reduced-motion` it shows the final state at once.
3. "What you can ask": five cards, one per tool, each with a plain name
   and an example question: the rate on a date (USD and EUR on 1 March
   2026), convert an amount ("Convert 1,200 GBP to GEL at today's
   rate", rounded half up to the tetri), convert a list (invoices, each
   at its own date, with a total), a rate's history (a month of USD, up
   to a year, with low, high, change and average), and which currencies
   NBG quotes (with NBG's units, JPY per 100).
4. "Gets the details right": the four rules the README states: data
   straight from NBG; Tbilisi calendar days, and a weekend or holiday
   says which day's rate applies; a date NBG has not published yet is an
   error, never a guess; per-unit rates beside NBG's quoted form (1.6452
   GEL per 100 JPY).
5. "Prefer to run it yourself?": one paragraph pointing to the Claude
   Desktop extension and to npm for Claude Code, Cursor and other MCP
   clients, with a link to the README's install section, and the note
   that questions then go from the user's computer straight to NBG.
6. Privacy (`id="privacy"`): the README's paragraph, made true for the
   page as well: the connector needs no account and never records the
   amounts, dates or currencies asked; it keeps two logs for 30 days
   (which tool was called from which client and whether NBG answered;
   the gateway's access log with time, path, status, the caller's IP
   address and user agent, where for claude.ai and ChatGPT the caller is
   Anthropic's or OpenAI's server); the page sets no cookies, loads
   nothing from anyone else and is logged like any other request; the
   operator is named as in section 8.
7. Terms (`id="terms"`): free to use, provided as is without warranty;
   rates are NBG's published rates, and anyone who needs them for an
   official or legal purpose checks them on nbg.gov.ge; the service may
   change, be limited or stop; independent project, not affiliated with
   the National Bank of Georgia.
8. Footer: links to Privacy, Terms, Support (the GitHub issues page),
   GitHub, the other language; "Operated by Avtandil Kikabidze"; and the
   text `nbg-rates-mcp <version>`, which the release smoke test reads.

The Georgian page has the same structure and content. The builder drafts
the Georgian text; the maintainer reviews it before the release is
tagged, and the plan carries that review as its own step.

### The icon

`assets/icon.svg` is redrawn with the lari sign as a path, converted
once from the Noto Sans Bold glyph the current file names, so it renders
the same without the font. The design is otherwise unchanged: a white
sign on a navy `#1F3A5F` rounded square. `scripts/render-icon.sh` renders
from it every raster the server and the bundle need (`icon.png` 512,
`apple-touch-icon.png` 180, the 16, 32 and 48 pixel images inside
`favicon.ico`) and the share card
from its own SVG (`assets/og.svg`: the icon, the name, the headline and
the URL on the page's colours, with text converted to paths for the same
reason). The rasters are committed, as `icon.png` is today, so a build
needs no renderer.

Everything the server serves ships inside `dist`, so the npm tarball, the
Lambda zip and the MCPB bundle carry it. Whether the builder embeds the
bytes in a generated module or copies the files into `dist` during the
build is the builder's call; the release must not need a renderer, and a
test fails if a committed raster is missing or was rendered from a
different version of its SVG source (a recorded hash of each source,
since a checkout gives every file the same modification time).

Only the Lambda entry sends an icon: `serverInfo.icons` carries one
entry, `https://nbg-rates.env.ge/icon.png`, `mimeType` `image/png`,
`sizes` `["512x512"]`, passed to `createServer` through its deps by
`src/lambda.ts`. It is a few dozen bytes on every result (see
Background) and has the hosted server's own origin. Over stdio and with
`--http` the server sends no icon: a link to the maintainer's host would
be another origin there, a strict client would drop it, and a lenient
one would contact the maintainer's host from a copy whose point is that
questions go straight to NBG; a `data:` URI would add about two
kilobytes to every result instead. The Claude Desktop extension keeps
its own icon in `manifest.json`.

`server.json` gains `icons` with one entry,
`https://nbg-rates.env.ge/icon.png`, `mimeType` `image/png`, `sizes`
`["512x512"]`, and `websiteUrl` becomes `https://nbg-rates.env.ge`. The
server identity (`SERVER_IDENTITY` in `src/shell/server.ts`) changes
`websiteUrl` to match, and the test that keeps the two equal also checks
that the Lambda entry's icon equals the `server.json` entry and that the
stdio identity has none.

`package.json` `homepage` becomes `https://nbg-rates.env.ge`; `bugs` and
`repository` stay on GitHub.

### Binary responses on Lambda

`src/lambda.ts` returns a body as UTF-8 text with `isBase64Encoded:
false` when the response's content type is text (`text/*`,
`application/json`, `application/javascript`, or anything with a
`charset`), and as base64 with `isBase64Encoded: true` otherwise. The
spec sentence "every response this server produces is text" no longer
holds and is amended. The local server (`http-node.ts`) already writes
bytes and needs no change beyond tests.

### The OpenAI challenge

`NBG_RATES_OPENAI_CHALLENGE` is read where the other environment
variables are (`src/shell/environment.ts` or the HTTP wiring that both
entries share), trimmed, and handed to `createHttpHandler`. It is not a
secret (the route publishes it), but it is also not logged. `bin.ts`'s
help text and the README's environment table list it.

### Version and changelog

The release is 0.6.0. The changelog entry lists, under Added, the landing
page in English and Georgian, the icon in the hosted server's
`serverInfo` and in `server.json`,
the share card and the OpenAI verification route with its variable; under
Fixed, the `Allow: POST` header on the 405 the SDK gives to a non-POST
`/mcp` (commit `9e2f506`, already on `main` and not yet released).

## Change 2: infrastructure (`personal/iac`, `terraform/aws/nbg-rates-mcp.tf`)

The Personal IaC session is moving Terraform state into S3 and has asked
to be told before anything touches `terraform/aws`; the plan's
infrastructure step starts by coordinating with it.

1. A variable for the OpenAI token (empty by default) feeds
   `NBG_RATES_OPENAI_CHALLENGE` in the function's environment, beside
   `NBG_RATES_HTTP_HOSTS`. An empty value leaves the route answering 404.
   Setting the token means committing it as the variable's default, as
   the repository's other variables are set, so a later plain apply
   keeps it.
2. Three CloudWatch alarms, each sending to the existing `NotifyMe` SNS
   topic in `billing.tf`, with missing data treated as not breaching:
   - the API's `5xx` metric for the `$default` stage, any in five
     minutes (this would have caught the TRACK crash of 0.5.0, and also
     catches the function's own throttle, which reaches callers as 500);
   - requests the stage refused with 429, any in five minutes, counted by
     a metric filter on the access log group (`$.status = "429"`), since
     HTTP APIs publish no separate 429 metric;
   - the function's `Throttles` metric, any in five minutes.
   Thresholds and periods may be tuned by the builder if the first week
   proves them noisy; scanners alone do not reach the throttle at today's
   volumes.
3. A saved CloudWatch Logs Insights query, "nbg-rates-mcp traffic by path
   and status", on the access log group, and a second one, "nbg-rates-mcp
   tool calls by client", on the function's log group (the usage lines).
4. `docs/aws.md` gains the alarms, the queries and the token's
   procedure, and the new resources get import blocks in the file's
   import section, as the repository does for every resource.

The token goes live in this order, which `docs/aws.md` records: 0.6.0 is
released (the route exists, answering 404); the maintainer creates the
plugin in OpenAI's portal and copies the token; the token is set in
Terraform and applied, which publishes a new function version from the
live code; that version is promoted with the documented `CodeSha256`
check and `update-alias`, or goes live with the next release; then the
maintainer runs OpenAI's verification.

## Change 3: documents

- `README.md`: the landing page linked near the top; the hosted section
  points to the page for the steps and keeps its privacy paragraph in
  step with the page's; the environment table gains
  `NBG_RATES_OPENAI_CHALLENGE`.
- `docs/directory-listings.md` (new): everything to paste, in English.
  For Anthropic: name, one-liner, description, categories, documentation
  URL (the page), privacy URL (`https://nbg-rates.env.ge/#privacy`),
  support contact (the GitHub issues URL), icon file. For OpenAI:
  display name "NBG Rates", a short description of at most 30
  characters, the long description, the four URLs (website the page,
  support the GitHub issues URL, privacy `#privacy`, terms `#terms`), the
  logo and composer icon files, and exactly five positive and three
  negative test cases in OpenAI's fields (description, prompt, tools
  triggered, expected behaviour). Positive cases cover each tool at least
  once; negative cases cover a date NBG has not published, an unknown
  currency code and a question the connector should not answer (for
  example a commercial bank's rate). The file notes the steps only the
  maintainer can do.
- The hosted endpoint spec gets an amendment note pointing here, and its
  `GET /` and "every response is text" sentences are corrected.

## Testing

- `src/shell/http.test.ts`: every row of the paths table (status,
  content type, cache and security headers, `HEAD` with no body, 405 with
  `Allow: GET, HEAD` for another method, the Host check still first, the
  challenge set and unset), the page only on `nbg-rates.env.ge` and the
  one-line text on another host, and no usage log line for any of them.
- Page content, for both languages: `lang`, title, the `hreflang` and
  canonical links, the Open Graph tags, the anchors `privacy` and
  `terms`, the URL `https://nbg-rates.env.ge/mcp`, the operator line, and
  `nbg-rates-mcp <version>`. A test fails if either page contains an
  `src` or `href` to another origin that the page would load (scripts,
  styles, images, fonts, frames); plain links to GitHub, nbg.gov.ge and
  the apps are allowed.
- Assets: each served file's first bytes match its type (PNG signature,
  ICO header), and the PNGs have the sizes the table names.
- `src/lambda.test.ts`: a text response keeps `isBase64Encoded: false`;
  `/favicon.ico` comes back base64 with `isBase64Encoded: true` and
  decodes to the served bytes.
- `src/shell/server.test.ts`: the identity test covers `websiteUrl` and
  the icon rules above.
- `test/e2e/http.test.ts`: `dist/bin.js --http` serves the page for a
  request whose `Host` is `nbg-rates.env.ge` (a raw `node:http` request,
  since `fetch` drops a `Host` header), the one-line text for
  `127.0.0.1`, and `/favicon.ico`.
- The release smoke test keeps its check that `GET /` is 200 and contains
  `nbg-rates-mcp <version>`, and adds that `/favicon.ico` is 200
  `image/x-icon`.
- Infrastructure: `terraform plan` shows exactly the variable, the
  environment entry, the metric filter, three alarms and two query
  definitions; after apply, an untargeted plan shows no changes.

## Operations

- Page traffic shares the stage throttle and the reserved concurrency
  with connector calls. A page view is one HTML request plus icons the
  browser caches for a day. The 429 and throttle alarms say when this
  stops being enough; the remedy then is a CDN in front, designed
  separately.
- The page's copy is in the code, so a wording change is a release.
- The share card is cached by every site that showed the link; a changed
  card needs a new file name to reach them.

## Left to the builder

Copy wording within the outline above, in both languages (the Georgian
text reviewed by the maintainer); CSS and the animation's details; how
the assets reach `dist`; the tool that builds `favicon.ico`; inline style
and script with hashes versus files served from the host; alarm
thresholds within the limits above; the categories chosen for the
listings.
