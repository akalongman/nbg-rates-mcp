# Hosted NBG mirror: design

Status: approved by the owner on 2026-10-17. Drafted 2026-10-16 and
revised 2026-10-17 after an outside review.

Amends `2026-10-12-hosted-endpoint-design.md` (how the Lambda entry builds
its rates service) and supersedes one non-goal of
`2026-10-15-nbg-failure-alarm-design.md` (no scheduled traffic from AWS to
NBG), as explained under "Decided".

## Why

On 2026-10-16 the owner shared NBG Rates in a Facebook group so its
members can read the landing page and add the connector, and a listing in
the Anthropic and OpenAI directories is parked for later. The owner's
anti-goal for that audience: someone tries NBG Rates and cannot use it.

Today every hosted request that is not in its Lambda instance's memory
asks NBG itself:

- Each instance has its own in-memory cache (`createSnapshotCache` in
  `src/shell/cache.ts`), so more instances mean more cold caches, each
  asking NBG separately. `nbg_rate_history` is not cached at all: every
  call is one CSV export request to NBG.
- NBG load therefore grows with traffic, all of it from AWS addresses.
  On 2026-10-15 NBG's F5 bot defense answered every request with a
  redirect and a cookie challenge for at least 10:40 to 10:44 UTC, and
  every lookup failed, hosted and local alike.
- During such an outage every request whose instance has no cached
  answer fails, and a dead NBG holds an instance for up to about 21
  seconds (`nbg-client.ts`: a 10 second timeout per attempt, one retry).
  With 10 reserved instances, ten such requests starve every other
  request, `tools/list` included.

The owner chose to mirror NBG in a database rather than share a cache.

## Worked example

Friday 2026-10-16, Tbilisi time. The mirror has every NBG table from
1995-10-14 to Friday's. The sync checks NBG once an hour, and on weekdays
also every minute from 17:00.

- 16:00: the hourly run finds no table valid from Saturday 2026-10-17 yet
  and records the mirror as fresh until 17:02, two minutes after the next
  check is due. At 16:52 Nino asks claude.ai for tomorrow's USD rate and
  is told, from the mirror, that NBG has not published it yet, as the
  live path would say.
- 17:00: the per-minute runs start. This one finds nothing yet.
- 17:00:05: NBG writes the table valid from Saturday, and at 17:01:02 it
  writes the table again, as it did with the table valid from 2026-10-09
  (see "The sync job").
- 17:01: the run sees Saturday's table, fetches it in both languages and
  as CSV rows, finds the three agree, and commits it. By 17:02 a run has
  seen the second write and committed any change it made.
- 17:02: Nino asks again and gets Saturday's rate from the mirror. At
  17:03 Giorgi asks the same on another instance and gets it too. NBG is
  not asked by either.
- About 17:12: ten successful per-minute runs in a row have seen no
  change, so the per-minute runs stop for the day and the mirror is fresh
  until 18:05, five minutes after the next hourly check is due.
- 17:30: Lasha asks for the USD history of September. Every day is in
  the mirror, so NBG is not asked.
- Monday 2026-10-19 at 10:40 NBG blocks every request for half an hour.
  The mirror is fresh until 11:05 from the 10:00 run, so users asking for
  today, last week or 2019 get their answers from it and notice nothing.
  The 11:00 run fails and writes an error line; the mirror is untouched.
  From 11:05 the mirror is past its fresh-until time, so a request tries
  NBG once with a short timeout, and while that fails the server answers
  from the mirror anyway, a few seconds slower. Ana asks at 11:07 for
  tomorrow's rate: the mirror's only answer is "not published", which a
  stale mirror cannot vouch for, so she gets today's "NBG is not
  answering" error. Once NBG recovers at 11:10, requests get NBG's
  answers live until the 12:00 run makes the mirror fresh again. The
  owner gets an ALARM email from the sync alarm, another from the
  NBG-failure alarm once a hosted lookup has failed live, and an OK email
  from each once a five-minute period passes without a failure.

## Goals

- In steady state, NBG load does not depend on how many people use the
  hosted endpoint or how many instances serve them.
- An NBG outage or block does not reach users for any date the mirror
  holds a rate for.
- Every answer from the mirror is the answer the live path would give,
  within the correction bounds under "How far the mirror may lag NBG".
- The owner is told by email when the mirror stops being kept up to date.

## Non-goals

- Local installs (stdio, `nbg-rates-mcp --http`, the Claude Desktop
  bundle). They keep asking NBG directly with today's cache: the landing
  page promises that "Rate lookups then go from your computer straight to
  NBG", and they must not depend on the maintainer's infrastructure.
- Serving the mirror as a public download or API.
- Raising the Lambda concurrency and the stage throttle. That is a
  separate Terraform change in `personal/iac`.
- Changing any tool's input, output or wording. A user cannot tell from
  an answer whether it came from the mirror.

## Anti-goals

- A confidently stale answer: the mirror answering after a check that
  was due has not succeeded, while NBG could have been asked.
- A wrong answer from a half-written or out-of-order mirror: a reader
  seeing part of a publication, or an older sync run undoing a newer
  one.
- Recording what users ask. User requests never write to the mirror,
  so its contents never reveal which dates or currencies anyone looked
  up. The privacy promise "never records the amounts, dates or currencies
  you ask about" stays true without new wording. The owner asked on
  2026-10-17 whether requests should write their answers back, as a cache
  would, and kept them read-only: the mirror is filled before anyone
  asks, so a request finds nothing to write while the sync works, and
  what it could write otherwise is either unchecked by the sync or a
  record of the date someone asked about.
- The mirror's own failure failing a request. A database error or a slow
  database falls through to today's live path in time.
- NBG traffic that grows with users in steady state.

## Decided

### What the mirror holds

NBG's own published data, as each existing reader needs it, kept per
publication, that is per date a table is valid from:

- The day table in both languages (`en`, `ka`), the shape `fetchDay`
  returns today (`NbgDay` in `src/core/nbg-schema.ts`). Snapshots are
  built from them with the same `normalizeSnapshot` and `requirePublished`
  the live path uses.
- Every row NBG's CSV export lists with that `ValidFromDate`, the shape
  `fetchRange` returns today (`NbgCsvRow` in `src/core/nbg-csv.ts`), one
  or more per currency (the export can list a currency twice for one
  date, and `assembleHistory` applies the later publication).
- When the sync fetched that data from NBG (its observation time).

Beside the publications, one record holds:

- The complete span: the first and last date for which every publication
  is committed, contiguous, with no gap.
- The fresh-until time (see "Freshness").
- The publication window's state for the current Tbilisi date, the dates
  still unresolved (see "Committing a publication"), and when the daily
  refetch, each slice of the weekly re-check and the backfill last
  completed.

Storing each endpoint's own shape, rather than deriving history rows from
day tables, keeps each reader's input exactly what the live path reads
today.

NBG's CSV export fails for some combinations of currencies: the main
spec records that a request including AZN for 2006 and 2007 returns only
the header for every currency in it, and that AZN rows can be fetched
only from 2008-01-01. Where that defect makes the live request return
nothing, the mirror answers from the rows it holds, which may give a
rate where the live path fails, or another error kind (an AZN history of
2006 alone is `no_data_for_date` live and `unknown_currency` from the
mirror, because the mirror holds USD rows for the interval). That is the
one accepted difference from the live path (the builder's question 4,
settled as this design's call), and the equivalence tests name it. In
every other case the answers, error kinds included, are equal.

### Committing a publication

These rules exist because the mirror is written in pieces by runs that
can overlap, fail half way or arrive late, while requests read it.

- A publication is committed as one unit: a reader sees all of it (both
  languages and its CSV rows) or none of it. One item per publication is
  the simplest way (a table in both languages with its rows is a few tens
  of kilobytes, far under DynamoDB's 400 KB item limit); a transaction of
  several items also meets the rule. The layout is the builder's call
  within it.
- A publication is committed only when its three sources agree: the same
  valid-from date, the same currency codes, and the same quantity and
  rate per code in the English table, the Georgian table and the CSV
  rows. A future date asked of the JSON endpoint returns the latest
  published table, so a table whose valid-from date is not the one asked
  for is "not there yet", never a table to store. When the sources
  disagree (the CSV can show a new row before the JSON does, or the
  reverse), the date is recorded as unresolved and every following run
  fetches it again until the sources agree, whatever the CSV comparison
  says. Until then the mirror keeps the last committed version of that
  publication, or none.
- A write never replaces newer data with older: every publication write
  is conditional on its observation time being later than the stored
  one, and the span, the fresh-until time and the window state only move
  forward under the same kind of condition. An older run finishing after
  a newer one therefore changes nothing.
- The complete span grows only by contiguous verified dates. After an
  interruption longer than the late-publication window (the sync down for
  ten days, say), a run catches up from the old end of the span, one
  verified publication after another, before the span may reach
  tomorrow. The backfill moves the start of the span backwards the same
  way. A new publication is committed before the span is extended over
  it, and readers ignore any publication outside the span they read.
- Readers read the span record and the publications with strongly
  consistent reads, follow every query page and retry every unprocessed
  key before treating anything as absent, so a just-committed publication
  is never missed and an absent row is a real absence.
- Comparisons reconcile complete row sets: a row present in the mirror
  and absent from NBG's answer is a change, like a new or a differing row.
  An empty or header-only export is never read as removals (NBG's filter
  defect can produce one); it fails the run, which the next run retries.
- The CSV request for a publication names every code in its JSON tables,
  so a currency newly added to a table has its rows fetched before the
  publication is committed. Every request over the archive (the backfill
  and the weekly re-check) takes its codes from the tables it covers, not
  from today's (BGN's last table is valid from 2025-12-31), and leaves AZN
  out of any request reaching into 2006 or 2007.

### Answering a request on the hosted endpoint

1. The mirror answers when it is fresh and covers the request. Covered
   means: for a snapshot, the date lies inside the complete span, which
   starts at a publication, so the table in force on that date is inside
   it too; for a history range, the interval the live path would ask NBG
   for lies inside the span. That interval is the range's start minus 31
   days (`HISTORY_LOOKBACK_DAYS`) through its end, for the requested
   currency and USD; an interval reaching before 1995-10-14 is covered
   when the span starts there, because NBG has nothing earlier. The
   mirror then hands `assembleHistory` exactly the rows NBG's export would
   return for those currencies and that interval (the export filters on
   `ValidFromDate`, inclusive), so BGN asked for 2026 is `unknown_currency`
   through both paths. The complete span runs to tomorrow as of the last
   check, so a tomorrow without a table is answered from the mirror
   exactly as the live path answers it: not published yet
   (`rate_not_published`).
2. Otherwise the request takes today's live path: the NBG client and the
   instance's in-memory cache. This covers a mirror past its fresh-until
   time, a date outside the complete span (an archive not yet filled back
   that far), and any database error or timeout. The database read has a
   bound of its own (about 2 seconds, the builder picks the value), so a
   slow database still leaves the live path its full time inside the
   function's 29 seconds. After an NBG outage the mirror stays stale until
   the next check succeeds, up to an hour, and in that hour requests ask
   NBG live, each instance's cache absorbing repeats. That is the accepted
   cost of hourly checks. An in-memory cache entry is never served when
   the mirror observed the same date later than the entry was cached, so
   an instance never steps back to a value the mirror had already
   replaced.
3. When a stale mirror holds a rate or a history series for the request,
   the live attempt is cut short: one attempt with a timeout of a few
   seconds (the builder picks the value), not today's two attempts of up
   to 10 seconds each. If it ends in an NBG failure (`upstream_unavailable`
   or `upstream_shape_changed`), the mirror's answer is returned instead.
   Only a rate or a series is returned this way: a stale "not published",
   "no data" or "unknown currency" cannot say what NBG would answer now,
   so on an NBG failure the request gets the failure, as today. Without a
   mirror answer the live path keeps today's timing. (The builder's
   question 2: without the short attempt, a hanging NBG would hold every
   instance for about 21 seconds even though the mirror could answer,
   which is the starvation this design exists to end.)
4. One request makes at most one short attempt. `nbg_convert_many`
   resolves its dates one after another and already stops asking NBG
   after an `upstream_unavailable` (`convertMany` in `src/shell/server.ts`);
   with the mirror, the dates after a failure are still answered from the
   mirror where rule 3 allows it, without another attempt, and the rest
   get the failure as today. So a batch of 100 items over many dates
   spends at most one short attempt on a hanging NBG.
5. The request's log line records an NBG failure in `nbgError` even when
   the mirror answered in its place, so the NbgFailures alarm keeps
   meaning "NBG failed a hosted lookup". `reportingNbgFailures` in
   `src/shell/nbg-failure.ts` sees only a call's final result, so the seam
   that adds the mirror has to carry the failure to it.
6. User requests only read the mirror. Only the sync job writes it.

A history range that ends tomorrow is answered from the mirror like any
other range; tomorrow's day is not published until the mirror holds its
table, as on the live path.

The owner first chose that a date the mirror lacks, such as tomorrow in
the minutes after 17:00, be asked of NBG live. Review showed that this
also sends every "tomorrow" request before publication to NBG (all day
on Saturdays and before holidays, when no table for the next day ever
comes), so NBG traffic would again grow with users. The owner accepted
the per-minute publication window below instead.

### Freshness

- Each successful check (an hourly run or a per-minute run) records a
  fresh-until time: when the next check is due, plus a margin for a slow
  run (2 minutes inside the publication window, 5 outside). After the
  16:00 check that is 17:02; after the per-minute runs stop at 17:12 it
  is 18:05.
- Nothing else moves it. The clock leaving the window never makes a
  stale mirror fresh again: if every per-minute run from 17:02 to 17:30
  fails, the mirror stays stale from 17:04 until a check succeeds. A
  successful backfill run, daily refetch or weekly re-check slice does
  not move it either, and a skipped, duplicate or late event writes
  nothing.
- The schedule's times (the hourly cadence, the window, its weekdays and
  its 17:30 end) live in one place in `src/core`, used by both the
  fresh-until computation and the stop rule. The Terraform schedules fire
  the runs; the mirror-stale alarm catches the two drifting apart.

### How far the mirror may lag NBG

| Change at NBG                                                      | Reaches the mirror within                |
| ------------------------------------------------------------------ | ---------------------------------------- |
| A new table at the weekday 17:00 publication                       | about a minute, at most about two        |
| A rate or quantity in the last 7 days or tomorrow, at another time | an hour (the next hourly check)          |
| A name or signed diff in the last 7 days, with no rate change      | a day (the daily refetch)                |
| A rate or quantity older than 7 days                               | a week (the weekly re-check)             |
| A name or signed diff older than 7 days                            | never: those tables are treated as final |

For comparison, today's in-memory cache re-asks NBG after 10 minutes for
a provisional entry and 12 hours for a final one (`cache.ts`), for each
instance separately. The owner accepted the hour for changes outside the
window. The last row is the accepted cost of not asking NBG about 22,000
day tables again: nothing proves NBG never corrects an old name, and
today's 12 hour re-ask of a final entry (`finalTtlMs`) exists for that
reason.

The two-minute bound for the 17:00 publication comes from EventBridge
Scheduler: with its flexible time window off it fires within the
scheduled minute, not at its first second, so a run just before NBG
writes can be followed by one late in the next minute. The owner accepted
that bound on 2026-10-17.

### The sync job

- Checks NBG once an hour, around the clock, and keeps the mirror equal
  to NBG for the late-publication window (the last 7 days, as
  `LATE_PUBLICATION_DAYS` in `cache.ts`) and tomorrow. That catches a
  table published late for a past day (Monday 2026-09-28 17:01 published
  the table valid from Saturday 2026-09-26) and a changed rate within an
  hour. Each hourly check asks NBG for one CSV export (every code of the
  latest committed table, over the window and tomorrow) and compares the
  complete row sets with the mirror's; a difference makes it fetch the
  affected publications in both languages and commit them (above).
- The publication window: on weekdays from 17:00 Tbilisi time (schedules
  in `Asia/Tbilisi`; Georgia keeps UTC+4 all year) the sync also runs
  every minute. Each per-minute run asks for tomorrow's JSON table in
  English, which carries every rate, quantity, signed diff and English
  name, and on a change, or while the date is unresolved, also fetches
  the Georgian table and the CSV rows and commits. The per-minute runs
  stop for the day once tomorrow's publication is committed and ten
  successful per-minute runs in a row have seen no change in it; a failed
  or skipped run does not count towards the ten. The stop is recorded
  with the Tbilisi date. On a typical weekday that is about a dozen runs.
  On a day no table comes (a public holiday such as 2026-10-14), the
  per-minute runs end with the 17:30 run. Saturdays and Sundays have no
  per-minute runs: NBG publishes Saturday's table on Friday and nothing on
  either weekend day. A change only to a Georgian name in the second
  write is caught by the daily refetch.
- Why these times (the owner asked on 2026-10-17 why not every 10
  minutes and why not from 17:00; answered from data): a scan on
  2026-10-17 of the 249 tables valid from 2025-10-14 to 2026-10-13 read
  each table's final write stamp. 246 were last written between 17:00:59
  and 17:01:15, one at 17:09:20 (Monday 2026-09-28, the day of the late
  Saturday table), and one evening fell outside the window: Friday
  2025-10-31, when the table valid from that same day was written at
  18:11 and Saturday's at 18:24. No final stamp is earlier than 17:00:59,
  and the one first write on record came at 17:00:01, so nothing points
  to a write before 17:00; the window starts there. Checks every 10
  minutes around the clock (this design's first draft) would have
  mattered on that one evening, at six times the requests of hourly
  checks; there the hourly checks cost up to an hour of lag, which the
  owner accepted.
- The row `date` field holds a table's last write, not its first: the
  table valid from 2026-10-09 was first seen at 17:00:24 stamped
  `17:00:01.911` and now reads `17:01:14.467`. NBG wrote that table twice,
  about a minute apart, which is why the per-minute runs wait for ten
  quiet runs instead of stopping at the first sight of the table. How
  often NBG writes twice, and whether the second write ever changes a
  value, is not known yet (see "Must be proven").
- Once a day an hourly run also refetches the window's publications in
  both languages whatever the CSV says (about 16 requests). That catches
  a change only the JSON carries (a name, the signed diff) within a day.
- Older tables (the builder's question 3, settled as this design's call):
  once a week the whole archive's rates are re-checked through the CSV
  export, in slices spread over the week's hourly runs (a few dozen
  requests in all), and a differing row set refetches its publications.
- Fills the archive back to `NBG_ARCHIVE_START` (1995-10-14) until the
  complete span reaches it. About 22,000 day tables (both languages) and
  the CSV rows of every code do not fit in hourly runs, so the backfill
  has its own schedule, every few minutes, and asks NBG nothing once the
  archive is complete. Its pace is the builder's call within two limits:
  it finishes in about a week (about 3,200 requests a day, two or three a
  minute), and NBG never sees a burst. Until then, older dates take the
  live path (rule 2).
- Every run works to a deadline: before each NBG request and each
  database write it checks the invocation's remaining time, leaves room
  for its commit and its log line, and leaves unfinished work (a slice,
  backfill dates, an unresolved publication) for the next run. A run
  never commits half of a publication because it ran out of time.
- Delivery: EventBridge Scheduler's retry policy is set to no retries
  with the shortest event age, and so is the function's asynchronous
  invocation configuration, because Lambda would otherwise retry a failed
  sync run up to twice and may deliver an event more than once. The next
  scheduled run is the retry. Each event carries its scheduled time
  (Scheduler's `<aws.scheduler.scheduled-time>`), and a run whose event
  is more than a minute old does nothing. Two runs in the same minute
  (the hourly check and the first per-minute run at 17:00) are harmless
  under the conditional writes; the builder may skip one.
- Steady-state budget, whatever the traffic: about 60 NBG requests on a
  typical weekday (24 hourly checks, about 16 in the window, about 16 for
  the daily refetch, a few for the weekly re-check), about 75 on a
  weekday holiday (31 window runs that find nothing), and about 45 on a
  weekend day. Each changed publication adds three (two JSON tables and
  the CSV rows), and the client retries a failed request once, as today.
  The backfill's week comes on top.
- Writes one log line per run: the kind of run, its outcome, the NBG
  failure kind if any, publications committed, the complete span. No user
  data exists in the sync to log. The line uses its own field names, not
  `nbgError`, so the existing NbgFailures metric filter never counts a
  failed sync (the builder's question 6).

### Where the code runs

- The sync is a second way into the same Lambda function, `nbg-rates-mcp`,
  invoked through the alias `live` by EventBridge Scheduler schedules
  (hourly, the publication window, the backfill), each with its own
  execution role allowed to invoke the alias. The handler in
  `dist/lambda.js` tells a scheduled sync event from an API Gateway
  event. A release moves the endpoint and the sync together, and
  `publish-release.sh lambda` needs no change. A sync run takes one of
  the reserved instances for its duration.
- The mirror is used only when the Lambda environment names a table
  (a new variable, for example `NBG_RATES_MIRROR_TABLE`). Unset, the
  function behaves exactly as today, which also keeps README line 117's
  self-hosting on Lambda working with no table. `bin.ts` never reads it.

### The database: DynamoDB, on demand

The builder's call within the requirements above was made here, for these
reasons:

- No server, no connection pool and no VPC. A Lambda in a VPC would need a
  NAT gateway (about 32 USD a month) to reach NBG; RDS Postgres alone
  would exceed the endpoint's 5 USD monthly budget.
- Size: about 11,000 publications of a few tens of kilobytes each, well
  under a gigabyte, cents a month. Reads are strongly consistent, which
  costs twice an eventually consistent read and is still cents. The
  backfill's writes cost under a dollar once.
- One table, in `personal/iac`, defined in Terraform like the rest of the
  endpoint. No point-in-time recovery: the mirror can be rebuilt from NBG.

### Dependencies

The npm package and the Claude Desktop bundle gain no runtime dependency.
The Lambda gets its DynamoDB client either from the AWS SDK for
JavaScript v3 that the Node.js Lambda runtime includes, or from a
Lambda-only install in `scripts/build-lambda.sh`; the builder picks one
and proves it (below).

### The alarms, in `personal/iac`

Beside the four existing alarms in `terraform/aws/nbg-rates-mcp.tf`, in
the same style, each with `alarm_actions` and `ok_actions` on
`aws_sns_topic.notify_me`:

- Sync failed: a metric filter on the function log counting sync lines
  whose outcome is an error, alarm on Sum over 300 seconds >= 1, missing
  data not breaching. It reports the failures the code sees.
- Function errors: the function's `AWS/Lambda` `Errors` metric, Sum over
  300 seconds >= 1, missing data not breaching. It reports what the code
  cannot log: a sync run killed by the timeout, a failed start, a crashed
  process. It also fires for such a crash on a user request, as in the
  0.6.3 incident, alongside the 5xx alarm.
- Mirror stale: a metric filter counting successful checks, alarm on Sum
  over 1800 second periods < 1 in 4 of 4 periods, missing data breaching.
  On the hourly cadence every other half hour holds a success, so it
  fires when two hourly checks in a row have not succeeded, about two and
  a half hours after the last success, and also when the schedule stops
  firing. It is the backstop for a silent stop; the two alarms above
  report a failed run within minutes.

An OK email means a period passed without the alarm's condition, not
that the cause is fixed. The budget's service filter gains Amazon
DynamoDB and the scheduler's service, so the 5 USD budget still watches
everything the endpoint uses.

### The superseded non-goal

The alarm design ruled out "a scheduled probe of NBG from AWS" because it
adds bot-like traffic from an AWS address. The sync job is such
scheduled traffic, accepted deliberately: about 45 to 75 requests a day,
steady, plus the one-off backfill, replace traffic that grows with every
user and instance. Its user agent stays
`nbg-rates-mcp/<version> (+https://github.com/akalongman/nbg-rates-mcp)`,
so NBG can see who it is.

### Release

0.7.0: new behavior on the hosted endpoint, none for local installs.
The code can ship before the table exists: with the variable unset
nothing changes. The order:

1. Release 0.7.0 as usual. The alias `live` moves to it.
2. In `personal/iac`, apply the table, the permissions, the alarms and
   the three schedules, the schedules created disabled.
3. Set the variable in the same Terraform. That publishes a new version
   of the `$LATEST` code with the variable, which `live` does not follow
   (`ignore_changes` on the alias). Promote it by the procedure in
   `personal/iac/docs/aws.md`: compare its `CodeSha256` with the one
   behind `live`, and move the alias only when they match.
4. Enable the schedules, and watch the first runs and the backfill.

Every later release publishes from `$LATEST`, so it keeps the variable.
Before the alias is ever moved back to a version older than 0.7.0, the
schedules are disabled: an older handler reads every event as an API
Gateway event (`event.headers` in `src/lambda.ts`) and fails on a
scheduled one.

## Must be proven, not assumed

- Equivalence: for the recorded NBG fixtures in `test/fixtures` and the
  cases the existing tests cover (a business day, tomorrow before and
  after publication, a Sunday and a Monday carried over, the day after a
  holiday, the 2026-09-28 late publication, a pre-September-2021 daily
  row, the archive start, an unknown code, history across the 2021
  changeover, BGN history before and after its last table on 2025-12-31,
  a history range whose lookback reaches the start of the span), every
  tool and the `nbg://rates/{date}` resource answer the same through the
  mirror as through the live path.
- Where NBG's CSV export defect (AZN, 2006 and 2007) makes the live path
  return nothing, the test records the mirror's answer and the live one
  side by side, as the one accepted difference.
- Fallbacks, each with a test: a stale mirror takes the live path; a
  date outside the complete span takes the live path; a database error
  and a database read that outlives its bound take the live path; an NBG
  failure on the live path returns the mirror's rate or series when it
  has one, and the log line still carries `nbgError`; a stale "not
  published" with an NBG failure returns the failure.
- An in-memory cache entry older than the mirror's observation of the
  same date is not served when the mirror is stale.
- User requests never write to the mirror.
- With a stale mirror holding the answers and an NBG that never answers
  (a fetch that hangs), one request makes one short attempt: an
  `nbg_convert_many` of 100 items over 30 distinct dates finishes well
  inside the function's 29 second timeout, from the mirror.
- With a fresh mirror covering the dates asked, a burst of concurrent
  requests causes no NBG request at all, requests for tomorrow included,
  both before and after NBG publishes.
- Committing: a reader never sees part of a publication; a run stopped
  between committing a publication and extending the span leaves every
  answer unchanged; an older run finishing after a newer one changes
  nothing; a duplicate or more than a minute late event does nothing; a
  CSV showing a row the JSON does not yet show leaves the date unresolved
  and retried until the sources agree; a row removed at NBG is removed
  from the mirror; an empty export fails the run instead of removing rows;
  after a ten-day interruption the span does not cross a date no run
  verified.
- Freshness: a mirror last checked by the 16:00 run answers at 16:59 but
  not at 17:03 when no per-minute run has succeeded, and is still stale
  at 17:31 if none did; a successful backfill run does not make a stale
  mirror fresh.
- The per-minute runs stop after ten successful quiet runs and not after
  ten failed ones, never run on Saturdays and Sundays, and end with the
  17:30 run on a day no table comes.
- A run that reaches its deadline stops cleanly and the next run finishes
  its work.
- A real 17:00 publication is watched minute by minute from 16:59 to
  17:15, in both JSON languages and the CSV export: when each first shows
  the new table, whether a second write comes and changes any rate, name
  or diff, and how far apart the sources are. The same is checked on the
  next late publication observed. The window's English-table check and
  the commit rule are confirmed or adjusted from what it shows before the
  mirror is switched on.
- The DynamoDB client the Lambda uses is present in the deployed zip or
  runtime, proven against the deployed function, not assumed from
  documentation.
- After step 3 of the release, `aws lambda get-alias` shows `live` on the
  version that carries the variable, and a scheduled run reaches it.
- Before apply, `aws logs test-metric-filter` runs the sync alarm's and
  the mirror-stale alarm's patterns against sync lines in Lambda's stored
  text format (timestamp, request id and level before the JSON), as the
  alarm design required for NbgFailures. After apply, a test email is
  sent through each new alarm (`aws cloudwatch set-alarm-state` to ALARM
  and back to OK) and the owner confirms they arrived. That proves
  delivery only; the function-errors alarm is also shown firing on a
  deliberately failing test invocation.

## Changes to existing documents

- `2026-10-12-hosted-endpoint-design.md`: on Lambda the rates service
  reads the mirror first when the table variable is set; the new
  variable; the scheduled sync events.
- `2026-10-15-nbg-failure-alarm-design.md`: the non-goal on scheduled
  NBG traffic points here.
- `README.md`: the Lambda paragraph (line 117) names the optional mirror
  variable.
- `CHANGELOG.md`: 0.7.0.
- `personal/iac/docs/aws.md`: the table, the schedules, the three alarms,
  the release order and the rollback rule.

## Left to the builder

- The item layout and key design of the table, within "What the mirror
  holds" and "Committing a publication".
- How a check compares rows within the stated requests, and the
  backfill's pace within its limits.
- The interfaces in `src/shell` that let `createRatesService` read the
  mirror. `SnapshotCache` is synchronous and a database read is not, so
  the mirror needs an asynchronous seam of its own; extend the existing
  service and client surface rather than duplicating it. The seam also
  carries a live failure past a mirror answer (rule 5) and the one-attempt
  rule across a request (rule 4).
- The values of the database read bound, the short attempt's timeout and
  the margins, within the stated limits.
- Names of the variable, the metrics, the alarms and the schedules,
  following the existing `${local.nbg_rates_mcp_name}-...` pattern.
- Whether the request log line gains a field saying the mirror answered.
  If it does, the privacy sentence "which tool was called from which
  client and whether NBG answered" and its copies (`copy-en.ts`,
  `copy-ka.ts`, `README.md`, `docs/directory-listings.md`) must still
  describe what the log holds.

## Coordination

`personal/iac` is shared with the Personal IaC sessions. Before editing
`terraform/aws/nbg-rates-mcp.tf` or `docs/aws.md`, ask those sessions
whether the aws root is free, and build on whatever is committed there at
that moment, local commits included.
