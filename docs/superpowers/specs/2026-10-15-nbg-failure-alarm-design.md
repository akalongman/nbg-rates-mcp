# NBG failure alarm: design

Approved: 2026-10-15.

## Why

On 2026-10-15 NBG put its rates API behind its F5 bot defense. Every
request to `https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/...`
was answered with a 307 to itself and a `TSPD_101_R0` cookie, and a
request that sent the cookie back had its connection reset. Every rate
lookup failed, on the hosted endpoint and on local installs alike. At
least 10:40 to 10:44 UTC is confirmed, and by 10:49 UTC NBG answered
again and a full smoke test against production passed. When it started
is unknown, because nothing recorded it.

Nobody was told. A failed lookup reaches the client as a tool result
with `isError: true` inside an HTTP 200, so the request log line says
`status: 200, outcome: "ok"` (as the hosted-endpoint spec intends), and
the three alarms (API Gateway 5xx, the stage's 429s, Lambda throttles)
watch nothing that moves. The outage was found by chance, by a manual
smoke test.

The owner wants an email when NBG fails a request on the hosted
endpoint: one email when an outage starts and one when it clears, not
one per failed request.

## Worked example

At 10:40 UTC a claude.ai user asks for today's USD rate. The hosted
Lambda calls NBG, the call fails after its retry, and the user is told
that NBG did not respond usably and the request can be retried.

- Today: the log line is
  `{"method":"tools/call","tool":"nbg_convert","status":200,"outcome":"ok",...}`
  and no alarm moves.
- After this change: the same line also carries
  `"nbgError":"upstream_unavailable"`. A CloudWatch metric filter on the
  function log counts it, and within five minutes the new alarm moves to
  ALARM and NotifyMe sends one email. Further failed lookups during the
  same outage send nothing more. Once a five-minute period passes with no
  failed lookup, the alarm returns to OK and NotifyMe sends one OK email.

## Goals

- An email within about five minutes of the first NBG failure on the
  hosted endpoint, and an OK email once five minutes pass without one.
- Every way a hosted request reaches NBG counts: `nbg_convert`,
  `nbg_convert_many` (whose outage failures sit in its items while the
  call itself succeeds), `nbg_get_rates`, `nbg_list_currencies`,
  `nbg_rate_history` and the `nbg://rates/{date}` resource (whose failure
  is a JSON-RPC error, not a tool result).
- The request log says which NBG failure a request met, so the function
  log answers "what happened at 10:40" without guessing.

## Non-goals

- Local installs (Claude Desktop, `npx nbg-rates-mcp`). They report
  nothing to this project and must not; the privacy section promises it.
- A scheduled probe of NBG from AWS. It would add bot-like traffic from
  an AWS address, the kind of traffic NBG's firewall reacts to, and cost
  money. The consequence is accepted: an outage during which nobody uses
  the hosted endpoint sends no email. Superseded on 2026-10-17 by the
  scheduled sync of `2026-10-16-nbg-mirror-design.md`, accepted there at
  about 45 to 75 requests a day and a one-off fill of about 430.
- Distinguishing "NBG is blocking us" from "NBG is down". Both reach the
  code as the same `upstream_unavailable` error, and the owner wants the
  email either way.
- Slack, SMS or any channel other than the existing NotifyMe topic.

## Anti-goals

- An email per failed request. An outage with fifty failed lookups sends
  one ALARM email and one OK email.
- An email for a user's own mistake: an unknown currency, an invalid or
  future date, a range that is too long, a rate NBG has not published
  yet (`rate_not_published`), a result out of range. None of these is
  an NBG failure.
- Logging anything a user asked about. The log line gains an error kind,
  never an amount, date, currency or message text.
- Counting a lookup whose first attempt failed and whose retry
  succeeded. Only a lookup that finally failed counts.

## What counts as an NBG failure

A lookup whose final result is a `RatesError` of kind
`upstream_unavailable` or `upstream_shape_changed` (`src/core/types.ts`).
Both mean NBG is unusable for everyone: the first that it does not
answer usably, the second that it answers in a shape this code no longer
reads, which includes `requirePublished` in `src/core/normalize.ts`
finding that NBG answered a date with a table valid from a later day.
Every other kind is the user's input or a normal state of NBG's
data and does not count.

## Decided

### The log line

`RequestLogLine` in `src/shell/http.ts` gains one field:

```ts
/** The NBG failure a lookup in this request ended in, else null. */
readonly nbgError: 'upstream_unavailable' | 'upstream_shape_changed' | null;
```

- `outcome` keeps its meaning (HTTP status, or a JSON-RPC error in the
  body). The field is separate because the two vary independently: an
  `nbg_convert_many` outage is `outcome: "ok"` with `nbgError` set, and
  an invalid-params error is `outcome: "error"` with `nbgError: null`.
  The saved Logs Insights queries that read `outcome` keep working.
- A request that meets both kinds records the first one it met.
- The line also names the cause of that same failure in `nbgCause`,
  right after `nbgError` (for example `HTTP 503 after retry`), and null
  when `nbgError` is null. A cause is built from a fixed vocabulary and
  carries nothing from the request, its URL or NBG's response body; see
  `2026-10-19-nbg-failure-cause-design.md`.
- Only `/mcp` requests have a log line; site paths are unchanged.

### Where the failure is recorded

At the place NBG is called, not by reading the response. A tool result
carries only text (`describeError`), `nbg_convert_many` reports an outage
inside a successful result, and the resource reports one as a JSON-RPC
error, so the response cannot tell the shell reliably. The failure is
recorded where the rates service settles a lookup's final result, whether
the counting kind came from the NBG client or from `requirePublished`,
and reaches the log line of the request that caused it.

Attribution must be exact per request. On Lambda an instance handles one
request at a time, but `nbg-rates-mcp --http` serves concurrent requests
from one process, so a process-wide "last failure" would mark the wrong
request's line. A per-request context that follows the request's async
work (Node's `AsyncLocalStorage` is the expected tool) meets this; the
mechanism is the builder's choice within that requirement. Cached answers
never fail, and failures are not cached (`rates-service.ts` caches only
answers that passed `requirePublished`), so the cache needs no change.

### The privacy section

The first log is described today as "which tool was called from which
client". It becomes "which tool was called from which client and whether
NBG answered", in `copy-en.ts` and with the same meaning in `copy-ka.ts`,
and in the other copies of the same sentence: `README.md` (kept in step
with the page by a test in `page.test.ts`) and `docs/directory-listings.md`.
The section is a promise and must match what the log holds. The Georgian
wording is reviewed before release.

### The alarm, in `personal/iac`

Beside the three existing alarms in `terraform/aws/nbg-rates-mcp.tf`, in
the same style:

- A log metric filter on the function log group
  (`aws_cloudwatch_log_group.nbg_rates_mcp`), adding 1 for each line whose
  `nbgError` is `upstream_unavailable` or `upstream_shape_changed`, into a
  metric in the `nbg-rates-mcp` namespace with no default value (a quiet
  period is missing data, as for `Rejected429`).
- An alarm on that metric: Sum over 300 seconds, one evaluation period,
  threshold 1, `GreaterThanOrEqualToThreshold`, `treat_missing_data =
  "notBreaching"`, `alarm_actions` and `ok_actions` both on
  `aws_sns_topic.notify_me`. Its description says that NBG failed a hosted
  lookup, that OK means five minutes without a failed lookup (which also
  happens when nobody uses the endpoint, so it does not prove NBG is
  back), and names the function log group and how to see the kind.
  Changed on 2026-10-31 to read the metric through `FILL(m, 0)`: with
  missing data CloudWatch looked back for the last real datapoint, so the
  one failed lookup of 2026-10-19 at 06:32 held the alarm in ALARM until
  06:52, not five minutes. A quiet five minutes is now a zero, and OK
  comes as this design intends.
- `docs/aws.md` in that repository lists the new alarm with the others.
- One alarm, not one per kind: either kind needs a person to look, and
  the log line says which one it was.

### Release

The server change ships as 0.6.2, with the CHANGELOG entry and the
release smoke test change already on `main` ("the release smoke test
waits until the endpoint serves the new version"). The alarm can be
applied before or after the release: until 0.6.2 is live the filter
matches nothing.

The release smoke test is unchanged: its conversion must succeed through
the hosted endpoint, so a deploy during an NBG outage fails and moves the
alias back, while npm, GitHub and the MCP registry, which publish before
the deploy, already carry 0.6.2. The alarm would then watch a 0.6.1
endpoint that never writes `nbgError`. So the tag waits for NBG: right
before tagging, a hosted `nbg_convert` must succeed, and after the
release the live footer and `initialize` must report 0.6.2. The test
email (below) is sent while NBG answers, so the real metric cannot hold
or re-raise the alarm during the check.

## Must be proven, not assumed

- The function log stores each line as Lambda's text format, a timestamp,
  request id and level before the JSON
  (`2026-10-15T10:41:01.947Z <tab> <request id> <tab> INFO <tab> {...}`).
  The `Rejected429` filter reads the API Gateway access log, whose lines
  are bare JSON, so its pattern style is no evidence for this log. Before
  apply, `aws logs test-metric-filter` runs the chosen pattern against
  lines in the exact stored format: one with `nbgError` set to each kind
  (counts), one with `nbgError: null` (does not count), one from a site
  request or with no `nbgError` field (does not count).
- A test drives an NBG failure through each path named under Goals and
  finds `nbgError` on that request's log line; one test runs two
  concurrent requests on the HTTP handler, one failing and one not, and
  finds the field only on the failing request's line.
- A test shows that `rate_not_published`, `unknown_currency` and a retry
  that succeeds leave `nbgError` null.
- After apply, one test email is sent through the alarm's path
  (`aws cloudwatch set-alarm-state` to ALARM, then back to OK), as was
  done for the existing alarms, and the owner confirms both emails
  arrived.

## Changes to existing documents

- `docs/superpowers/specs/2026-10-12-hosted-endpoint-design.md`: the log
  line gains `nbgError`, and the passage that says a tool failure is
  `outcome: "ok"` says where the NBG failure is recorded instead.
- `CHANGELOG.md`: 0.6.2.
- `personal/iac/docs/aws.md`: the alarm list.

## Left to the builder

- The metric and alarm names, following the existing
  `${local.nbg_rates_mcp_name}-...` pattern.
- The exact metric filter pattern, within the proof above.
- The per-request mechanism, within the attribution requirement.
- The Georgian privacy wording, subject to review.

## Coordination

`personal/iac` is shared with the Personal IaC sessions, which keep local
unpushed commits there and other work in the aws root. Before editing
`terraform/aws/nbg-rates-mcp.tf` or `docs/aws.md`, ask those sessions
whether the aws root is free, and build on whatever is committed there at
that moment, local commits included.
