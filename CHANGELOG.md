# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and the project uses semantic versioning.

## 0.2.1 - 2026-10-09

Fixed: the release job waits for npm to serve a newly published version before registering it with the MCP registry, which rejected 0.2.0 on the first attempt. The package itself is unchanged.

## 0.2.0 - 2026-10-09

Breaking: `nbg_rate_history` days are now `{ date, rate }` when the day's own rate is in force; only carried-over days add `effectiveDate` and `carriedOver: true`. A full year of history is about 40% smaller.

Added: server instructions, so clients that load tools on demand know when to use this server; `title`, `description` and `websiteUrl` in the server identity.

## 0.1.0 - 2026-10-09

Initial release: `nbg_get_rates`, `nbg_convert`, `nbg_list_currencies`, `nbg_rate_history`, the `nbg://rates/{date}` resource, per-unit normalisation, Tbilisi date semantics, the `carriedOver` flag, a `rate_not_published` error for dates NBG has not published yet, one-request history from the NBG CSV export, in-memory cache, live contract test.
