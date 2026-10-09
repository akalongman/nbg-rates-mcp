# nbg-rates-mcp 0.3.0: end-user onboarding

Date: 2026-10-09. Amends `2026-10-08-nbg-rates-mcp-design.md` (the main
spec) and `2026-10-09-context-efficiency-design.md`; where they disagree,
this document wins for the sections it names.

## Purpose

Five changes that lower the entry barrier for the non-developer half of the
audience (an accountant who installs the server in Claude Desktop and needs
to know what to ask) without changing how any rate is computed:

1. A stable download link for the Claude Desktop bundle, and release notes
   that start with how to install.
2. The README reordered for the accountant: what to ask and which rate is
   applied before the install section; the per-OS location of
   `claude_desktop_config.json`.
3. GitHub topics and homepage, defined in git and applied by script.
4. Prompts the server advertises, so Claude Desktop's "+" menu shows what the
   server is for; an icon and a long description in the bundle manifest.
5. Release 0.3.0.

The release is 0.3.0 because prompts are a new server capability
(`prompts/list` now answers); no tool input or output changes.

## Background (checked 2026-10-09 against 0.2.2)

- A cold `npx -y nbg-rates-mcp` from an empty npm cache connects in about
  2 seconds; the bundle is 2.2 MB and holds only the two runtime
  dependencies. Installation itself is not the problem.
- The README's Claude Desktop section links the release page, where the
  `.mcpb` sits in a collapsed "Assets" list under the changelog, next to two
  "Source code" archives. The release notes are the changelog section only.
- The README opens with per-unit values, Tbilisi calendar days and the
  `carriedOver` flag, which is the vocabulary of the tool reference, not of
  the person deciding whether to install. It names
  `claude_desktop_config.json` without its path.
- The repository has no topics and no homepage (`gh repo view`).
- The server registers no prompts; the manifest has no `icon`,
  `long_description` or `prompts`, so the extension card in Claude Desktop
  shows a generic icon and the two-line description.
- Verified contracts: `@modelcontextprotocol/server` 2.3 exposes
  `registerPrompt(name, { title, description, argsSchema }, callback)`,
  prompt arguments are strings and an optional zod field is advertised as
  not required. The MCPB manifest (anthropics/mcpb `MANIFEST.md`) takes
  `icon` (a PNG path inside the bundle), `long_description` (markdown) and
  `prompts: [{ name, description, arguments: [names], text }]` with
  `${arguments.<name>}` placeholders in `text`. GitHub serves
  `releases/latest/download/<asset>` for a fixed asset name of the newest
  non-draft, non-prerelease release.

## Change 1: stable bundle asset and install block in release notes

`scripts/publish-release.sh github` uploads two assets per release: the
existing `nbg-rates-mcp-<version>.mcpb` and a byte-identical copy named
`nbg-rates-mcp-latest.mcpb`, made with `cp` in the publish job (the build
artifact carries only the versioned file). The versioned name stays the one
a bug report cites; the `-latest` name exists so that one URL,
`https://github.com/akalongman/nbg-rates-mcp/releases/latest/download/nbg-rates-mcp-latest.mcpb`,
always downloads the newest release, and its filename tells the person
holding it that it is a moving target.

Idempotence: the release counts as complete only when it is not a draft and
both assets are present. An incomplete release gets both assets uploaded
with `--clobber` and is published, as today.

`release_notes()` prepends an install block to the version's changelog
section, separated by a blank line:

> Install: on Claude Desktop (macOS, Windows) download
> [nbg-rates-mcp-<version>.mcpb](https://github.com/akalongman/nbg-rates-mcp/releases/download/v<version>/nbg-rates-mcp-<version>.mcpb)
> and open it. In Claude Code run
> `claude mcp add nbg-rates -- npx -y nbg-rates-mcp@<version>`. Other
> clients: see the [README](https://github.com/akalongman/nbg-rates-mcp#install).

A release page links its own version, not `latest`, so an old release page
stays truthful.

Acceptance: `bash -n` and shellcheck pass on the script; the 0.3.0 release
shows both assets and the install block, and the `-latest` URL downloads a
file with the same SHA-256 as the versioned one.

## Change 2: README for the accountant first

The README keeps every current section and gains three before Install. New
order:

1. Title. Lead, two sentences in plain words: ask Claude for the official
   National Bank of Georgia rate of the lari on any date, or to convert an
   amount at that rate; the server runs on the user's machine, needs no
   account and no key. Then the existing non-affiliation paragraph.
2. **What you can ask**. Four example questions:
    - What was the USD rate on 30 September 2026?
    - Convert 1,500 USD to GEL at the NBG rate of 27 September 2026.
    - Give me the EUR rate for every day of September 2026 as a table.
    - How many US dollars is 1 euro today, at NBG rates?

    One worked answer, for the second question: 27 September 2026 is a
    Sunday; the rate in force is 2.6080 GEL per USD, set for Saturday
    26 September and still valid on Sunday, so 1,500 USD = 3,912.00 GEL, and
    the answer says the rate is carried over from the 26th. (Values from the
    live server on 2026-10-09.)
3. **Which rate you get**. Georgian accounting and tax reporting use the
   official NBG rate in force on the date of the transaction; this server
   returns exactly that rate, the one shown on nbg.gov.ge for the day named.
   NBG sets rates on business days, valid from the next calendar day, so a
   Sunday, a Monday or the day after a public holiday has no rate of its own
   and keeps the last one set; the answer says so (`carriedOver`) and names
   the day that rate took effect. A date NBG has not published yet, including
   tomorrow before about 17:00 Tbilisi time, is answered with an error, never
   a guess.
4. **Install**, in this order:
    - Claude Desktop (macOS, Windows): the direct `-latest` download link
      from Change 1, "open it, Claude Desktop installs the extension and runs
      it with its own Node.js".
    - Claude Desktop (Linux beta) and manual configuration: the existing
      JSON snippet, preceded by a table of where `claude_desktop_config.json`
      lives: macOS `~/Library/Application Support/Claude/`, Windows
      `%APPDATA%\Claude\`, Linux `~/.config/Claude/`. The file may not exist
      yet; create it with the snippet as its whole content.
    - Claude Code, Cursor and other clients, Node.js: the existing text.
5. A one-line lead-in, "The rest of this document is for developers and
   for people writing instructions for a model", then the existing Tools,
   Resource, Errors, Date rules, Environment variables, Development and
   License sections, unchanged except for the Development line that Change 3
   adds.

Acceptance: `prettier --check` passes; every install command in the README
has been run once against the published 0.3.0; the worked answer matches a
live `nbg_convert` call for 2026-09-27.

## Change 3: repository settings in git

New file `.github/repository.json`:

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

The description is the one the repository already has. The homepage is the
npm page because the README is the GitHub page itself and npm is where a
developer installs from.

New `scripts/apply-repo-settings.sh`, modelled on `apply-rulesets.sh`: reads
the file with `jq`, PATCHes `repos/{owner}/{repo}` with `description` and
`homepage`, PUTs `repos/{owner}/{repo}/topics` with `{ "names": [...] }`,
then reads description, homepage and topics back with `gh repo view` and
prints them. The README Development section mentions it in the sentence
that already names `apply-rulesets.sh`.

Acceptance: running the script leaves `gh repo view --json
description,homepageUrl,repositoryTopics` equal to the file; a second run
changes nothing.

## Change 4: prompts, icon, long description

### Prompts

Four prompts, defined once in `src/shell/prompts.ts` as a constant list of
`{ name, title, description, arguments: [{ name, description, required }],
text }`, where `text` uses the MCPB placeholder syntax `${arguments.<name>}`.
A pure `renderPrompt(text, args)` replaces each placeholder with the argument
value, or with the empty string when the argument is absent; the text of
each prompt handles the empty case in words, so no default logic lives in
code and the manifest copy of the text behaves the same. The server registers
each prompt with `registerPrompt` (zod `z.string()` for a required argument,
`.optional()` otherwise) and returns one `user` message holding the rendered
text.

| Name | Title | Arguments |
| --- | --- | --- |
| `nbg_rates_today` | Today's NBG rates | `currencies` (optional) |
| `nbg_rate_on_date` | Rate on a date | `currency`, `date` |
| `nbg_convert_amount` | Convert an amount | `amount`, `from`, `to`, `date` (optional) |
| `nbg_monthly_rates` | Rates table for a month | `currency`, `month` |

Texts, exactly:

`nbg_rates_today` (description: Today's official NBG rates of the lari for a
few currencies; `currencies`: comma-separated ISO codes, USD, EUR and GBP
when empty):

> Give me today's official National Bank of Georgia rates for
> ${arguments.currencies} (USD, EUR and GBP when none are named) with
> nbg_get_rates. For each currency report the rate in GEL per one unit and
> the change versus the previous rate, then the date the rates took effect
> and whether they are carried over from an earlier day.

`nbg_rate_on_date` (description: The official NBG rate of one currency in
force on a date; `currency`: ISO code such as USD; `date`: calendar date,
YYYY-MM-DD):

> What was the official National Bank of Georgia rate of
> ${arguments.currency} in force on ${arguments.date}? Use nbg_get_rates.
> Report the rate in GEL per one unit, the date it took effect, and whether
> it is carried over from an earlier day.

`nbg_convert_amount` (description: Convert an amount at the official NBG
rate in force on a date; `amount`: number in the from currency; `from`,
`to`: ISO codes or GEL; `date`: calendar date, YYYY-MM-DD, today when
empty):

> Convert ${arguments.amount} ${arguments.from} to ${arguments.to} at the
> official National Bank of Georgia rate in force on ${arguments.date}
> (today when no date is given) with nbg_convert. Show the rate used, the
> date it took effect, whether it is carried over, and the result rounded to
> 2 decimal places.

`nbg_monthly_rates` (description: The official NBG rate of one currency for
every day of a month, as a table; `currency`: ISO code such as EUR;
`month`: YYYY-MM):

> Using nbg_rate_history from the first to the last day of
> ${arguments.month}, give me a table of the official National Bank of
> Georgia rate of ${arguments.currency} for every day of the month, in GEL
> per one unit, marking the days whose rate is carried over from an earlier
> day. Below the table give the first, last, lowest and highest rate of the
> month.

The prompts pass arguments through as typed; the tools validate dates and
codes and their error texts already say what to fix.

`manifest.json` gains `prompts`: one entry per prompt with `name`,
`description`, `arguments` (the argument names, in order) and `text` equal
to the template. `prompts_generated` stays absent (false).

### Icon

`assets/icon.svg`: a 512x512 rounded square filled `#1F3A5F` (dark blue)
with a white lari sign (U+20BE, Noto Sans Bold) centred. No flag colours and
no NBG mark: the project is not affiliated with NBG and the icon must not
suggest it is. `scripts/render-icon.mjs` renders `assets/icon.png`
(512x512) from the SVG with `sharp` (available as a global npm package on
the maintainer's machine, not a devDependency); the PNG is committed, so a
build needs no renderer. `manifest.json` gains `"icon": "assets/icon.png"`
and `scripts/build-bundle.sh` copies `assets/` into the bundle.

### Long description

`manifest.json` gains `long_description`, markdown, four short paragraphs:
what the server does (the README lead), the four example questions of
Change 2, which rate is applied (the first two sentences of "Which rate you
get"), and the non-affiliation sentence.

### Acceptance

- Unit: `renderPrompt` substitutes every placeholder and leaves no
  `${arguments.` behind; an absent optional argument renders as the empty
  string.
- In-memory client: `prompts/list` returns the four prompts with the titles,
  descriptions and argument names and `required` flags of `PROMPTS`;
  `prompts/get` for each returns one `user` text message equal to
  `renderPrompt` of its template with the given arguments.
- Drift: a test parses `manifest.json` and asserts that its `prompts` equal
  `PROMPTS` in name, description, argument names (order included) and text,
  and that `icon` names a file that exists.
- E2e: the built binary answers `prompts/list` with the four names.
- `scripts/build-bundle.sh` runs `mcpb validate` on the new manifest and the
  packed bundle contains `assets/icon.png`.

## Release 0.3.0

- `package.json`, `manifest.json` and `server.json` move to 0.3.0
  (`scripts/check-release.ts` already requires them to agree).
- CHANGELOG entry:

  > Added: four prompts (today's rates, rate on a date, convert an amount,
  > rates table for a month), shown by clients such as Claude Desktop as
  > ready-made questions; an icon and a long description in the Claude
  > Desktop bundle.
  >
  > Changed: the README leads with what to ask and which rate applies, links
  > the Claude Desktop bundle directly and lists where
  > `claude_desktop_config.json` lives on each OS. Release notes start with
  > install steps, and every release also carries the bundle as
  > `nbg-rates-mcp-latest.mcpb` so one link always downloads the newest one.
  >
  > Repository: topics and homepage are defined in `.github/repository.json`
  > and applied with `scripts/apply-repo-settings.sh`.

- After the release the maintainer runs `scripts/apply-repo-settings.sh`
  once; it is not part of the workflow because the publish job holds no
  token with repository-administration scope.

## Documents updated with the code

- `README.md`: Change 2, the Development sentence of Change 3.
- `CHANGELOG.md`: the 0.3.0 entry.
- `manifest.json`: prompts, icon, long description.

## Out of scope

- A hosted Streamable HTTP endpoint for claude.ai, Claude mobile and
  ChatGPT (review item 1).
- A Georgian README (item 4).
- Batch conversion, period summaries and multi-currency history (items 7
  to 9).
- Submission to Anthropic's Claude Desktop extension directory: a form the
  maintainer fills after 0.3.0 ships, not a change to the repository.
- `icons` (per-theme variants) and `screenshots` in the manifest.
