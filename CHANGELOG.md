# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and the project uses semantic versioning.

## 0.6.3 - 2026-10-16

Changed: the landing page's title and share description say, near their start and in English and Georgian, that NBG Rates is an independent project not affiliated with the National Bank of Georgia, so link previews say it too; a browser that opens https://nbg-rates.env.ge/mcp is sent to the landing page instead of an error, while MCP clients get the same answers as before.

## 0.6.2 - 2026-10-15

Changed: each hosted request's log line names the NBG failure it met (`nbgError`: `upstream_unavailable` or `upstream_shape_changed`, else null), counted for every tool, for each item of `nbg_convert_many` and for the `nbg://rates/{date}` resource, so an outage can raise an alarm; the privacy section says that the log records whether NBG answered.

Release process: the deploy smoke test asks `GET /` until it names the new version three times in a row, for up to 60 seconds, before its checks, because for a moment after the alias moves the public URL can still reach the previous version.

## 0.6.1 - 2026-10-15

Changed: the Georgian landing page writes dates in the standard order (`2026 წლის 7 ოქტომბერს`) and words its ChatGPT workspace step, the unpublished-rate rule, the self-hosting sentence, the privacy promise, the gateway log and the terms more naturally; on both pages the self-hosting sentence says that rate lookups, not questions, go from the computer straight to NBG.

## 0.6.0 - 2026-10-15

Added: a landing page at https://nbg-rates.env.ge, in English and in Georgian at `/ka`, with setup steps for claude.ai, ChatGPT, Claude Desktop and Claude Code, a short demo conversation, and the privacy and terms sections the Anthropic and OpenAI directories ask for; an icon redrawn without a font dependency, served as a favicon, a touch icon and a 1200 by 630 share card; the hosted server's icon in `serverInfo.icons` and in `server.json`; `/.well-known/openai-apps-challenge` and the `NBG_RATES_OPENAI_CHALLENGE` variable for OpenAI's domain verification; `docs/directory-listings.md` with the listing texts and test cases.

Changed: `server.json`, the server identity, `package.json` and the GitHub repository's homepage name https://nbg-rates.env.ge as the website; the Lambda entry returns non-text bodies base64 encoded; the release smoke test also checks `/favicon.ico`.

Fixed: a `GET` or `DELETE` to `/mcp` is answered 405 with the `Allow: POST` header a 405 must carry.

## 0.5.1 - 2026-10-13

Fixed: a `TRACK`, `TRACE` or `CONNECT` request is answered 405 instead of failing. A web `Request` cannot carry these methods, so on the hosted endpoint a `TRACK` request failed the Lambda invocation and API Gateway answered 500, and `--http` answered `TRACE` with 500 and an error line.

## 0.5.0 - 2026-10-13

Added: a hosted endpoint at `https://nbg-rates.env.ge/mcp` for claude.ai, Claude mobile and ChatGPT, with nothing to install; `nbg-rates-mcp --http` (`--port`, `--host`) to serve the same Streamable HTTP endpoint locally; a Lambda entry `dist/lambda.handler` for API Gateway; the `NBG_RATES_HTTP_HOSTS` variable. server.json lists the hosted endpoint as a remote, so MCP Registry clients can find it. The release workflow deploys each release to the hosted endpoint and rolls back when its smoke test fails.

## 0.4.0 - 2026-10-12

Added: `nbg_convert_many`, a batch of conversions, each at the rate of its own date, with per-item errors and a total; `resultRounded` on every conversion, computed exactly and rounded half up to two decimals; a `summary` (first, last, change, lowest, highest, calendar-day average) on `nbg_rate_history`.

Changed: descriptions and prompts ask for NBG's quoted form (for example 1.6452 GEL per 100 JPY) beside the per-unit rate; a value that is not a currency code gets its own error text; the future-date error names the last date that can have a rate; the monthly prompt ends at today for the current month; the today's-rates prompt adds TRY.

## 0.3.0 - 2026-10-10

Added: four prompts (today's rates, rate on a date, convert an amount, rates table for a month), shown by clients such as Claude Desktop as ready-made questions; an icon and a long description in the Claude Desktop bundle.

Changed: the README leads with what to ask and which rate applies, links the Claude Desktop bundle directly and lists where `claude_desktop_config.json` lives on each OS. Release notes start with install steps, and every release also carries the bundle as `nbg-rates-mcp-latest.mcpb` so one link always downloads the newest one.

Repository: topics and homepage are defined in `.github/repository.json` and applied with `scripts/apply-repo-settings.sh`.

## 0.2.2 - 2026-10-09

Fixed: a carried-over rate for a day in the last week is checked with NBG again after ten minutes instead of being kept for twelve hours. NBG sometimes publishes a table for a past day after that day (the table valid from Saturday 2026-09-26 appeared on Monday 2026-09-28), and a long-running client kept serving the rate it replaced.

Fixed: `nbg_convert` reports a result too large to represent with its own error message, and an unknown currency's message says the code may have rates on other dates.

Changed: clearer descriptions for models: an absent `effectiveDate` in `nbg_rate_history` means the rate took effect on `date`, tiny values use exponent notation, and `GEL` is listed in `unknownCodes` by `nbg_get_rates`.

Release process: build and publish run as separate jobs, the bundle tool is a locked dependency, workflow actions are pinned to commit SHAs, and only admins can push release tags.

## 0.2.1 - 2026-10-09

Fixed: the release job waits for npm to serve a newly published version before registering it with the MCP registry, which rejected 0.2.0 on the first attempt. The package itself is unchanged.

## 0.2.0 - 2026-10-09

Breaking: `nbg_rate_history` days are now `{ date, rate }` when the day's own rate is in force; only carried-over days add `effectiveDate` and `carriedOver: true`. A full year of history is about 40% smaller.

Added: server instructions, so clients that load tools on demand know when to use this server; `title`, `description` and `websiteUrl` in the server identity.

## 0.1.0 - 2026-10-09

Initial release: `nbg_get_rates`, `nbg_convert`, `nbg_list_currencies`, `nbg_rate_history`, the `nbg://rates/{date}` resource, per-unit normalisation, Tbilisi date semantics, the `carriedOver` flag, a `rate_not_published` error for dates NBG has not published yet, one-request history from the NBG CSV export, in-memory cache, live contract test.
