# nbg-rates-mcp 0.5.0: a hosted endpoint at https://nbg-rates.env.ge/mcp

Date: 2026-10-12. Amends `2026-10-08-nbg-rates-mcp-design.md` (the main
spec), which declared "There is no hosted component"; from 0.5.0 there is
one, and this document wins for everything it names. The arithmetic spec of
2026-10-12 and the onboarding spec of 2026-10-09 are unchanged.

Amended 2026-10-13 to describe what 0.5.0 shipped, where implementation
and review corrected this design.

## Purpose

An accountant on claude.ai in a browser, on the Claude mobile app or on
ChatGPT cannot use a stdio server: those hosts only reach servers over
HTTPS. One hosted copy of this server, added as a custom connector by
pasting a URL, gives them the same five tools with no installation. The
hosted copy runs the same code as the npm package, is public and free,
needs no account, stores nothing a user typed, and costs cents a month.

Two deliverables, in two repositories:

1. In this repository: an HTTP shell beside the stdio one, a Lambda entry
   point, tests, a deploy job in the release workflow, and the README
   section that tells a user what to paste where.
2. In the maintainer's infrastructure repository (`personal/iac`, Terraform
   root `terraform/aws`): the function, the API in front of it, the domain
   name, the deploy role and a spending guard, in one new file
   `terraform/aws/nbg-rates-mcp.tf`.

The release is 0.5.0: the npm package gains two entry points and one
environment variable; no tool, prompt, resource or output field changes.

## Background (checked 2026-10-12)

- Claude's connector documentation: a remote server uses Streamable HTTP,
  may be unauthenticated, is called from Anthropic's cloud (not from the
  user's device), and on claude.ai and Claude Desktop has a 240 second
  tool call timeout and a 150,000 character result cap. Neither limit is
  near: a tool call here finishes in milliseconds from cache and in a
  second or two from NBG, and the largest result (a 100 item batch or a
  one year history) is under 60,000 characters.
- OpenAI's connector documentation recommends OAuth and shows SSE, and
  third party sources disagree about which ChatGPT plans can add an
  unauthenticated custom connector. ChatGPT is a "verify after launch"
  target, not a requirement the design bends for.
- `@modelcontextprotocol/server` 2.3.1, already a dependency, exports
  `createMcpHandler(factory, options)`, whose `fetch(request)` serves one
  web standard `Request` and resolves with a `Response`. It serves the
  2026-07-28 protocol revision and, by default (`legacy: 'stateless'`),
  answers 2025-era Streamable HTTP traffic statelessly: a fresh server from
  the factory per request, no session id, and `GET` or `DELETE` on the
  endpoint answered with 405. The entry does no Host or Origin validation
  itself. The package `@modelcontextprotocol/node` offers a `node:http`
  wrapper; it is at 2.1.1 while the server package is at 2.3.1, and the
  Lambda path needs an adapter of its own anyway, so this design writes
  one small adapter and adds no dependency.
- The client package exports `StreamableHTTPClientTransport`, which the
  end-to-end test uses. The smoke test loads no package at all
  (Change 3).
- CloudFront's origin access control for Lambda function URLs requires
  every `POST` to carry a SHA-256 of its body in the `x-amz-content-sha256`
  header, which MCP clients never send; CloudFront in front of a function
  URL therefore needs a shared secret header instead. API Gateway HTTP APIs
  need neither: they terminate TLS on a custom domain, invoke the function
  directly, and throttle per stage for free. Cost is $1.00 per million
  requests (the 12 month free tier does not apply to this account).
- Lambda offers the `nodejs24.x` runtime (active LTS, supported to April
  2028), the same major the project develops and tests on.
- The three hosted zones `env.ge`, `npm.ge` and `ssh.ge` exist in Route 53
  since 2026-10-12 (`terraform/aws/dns.tf`), each with an apex CAA that
  allows only ACM to issue; the registrar's delegation of `env.ge` to
  Route 53 was verified the same day.
- `src/shell/nbg-client.ts` waits up to 10 seconds per upstream attempt
  and retries once after 500 milliseconds, so a dead NBG costs a request
  about 21 seconds before `upstream_unavailable`. API Gateway's integration
  timeout can be at most 30 seconds.
- The release workflow's `publish` job already proves the deployment
  style: GitHub OIDC, no stored keys, the website repository's role in
  `iac/terraform/aws/iam.tf` trusts the immutable subject
  `repo:<owner>@<id>/<repo>@<id>:ref:...`. This repository's immutable
  subject prefix is `repo:akalongman@423050/nbg-rates-mcp@1411291932`
  (`gh api repos/akalongman/nbg-rates-mcp/actions/oidc/customization/sub`).
- On 2026-10-12 the tag `v0.4.0` started two release runs in the same
  second; both published and the loser failed with a 409 from npm. The
  workflow has no `concurrency` group.

## Decisions

1. **URL**: `https://nbg-rates.env.ge/mcp`. One host per tool: a future tool
   gets its own `<tool>.env.ge`, its own certificate and its own Terraform
   file, with nothing shared but the zone. `env.ge` rather than `npm.ge`
   or `ssh.ge` because those two names carry a strong existing meaning
   (the package manager, remote shells) worth keeping for a product about
   that; `env` is a neutral umbrella for tools an assistant connects to.
2. **Audience**: anyone, free, no sign-up, no authentication. Protection is
   API Gateway throttling, the function's reserved concurrency as a bill
   cap, and a budget alert. No WAF.
3. **Shape**: stateless. Each request builds a server from the existing
   factory; the rates service and its cache are created once per process
   and shared by every request the warm instance serves. There is no
   session id to count, so conversations are counted as `initialize`
   requests, which every host sends once when it connects.
4. **Infrastructure in `personal/iac`, code deployed by this repository's
   release workflow.** Terraform owns the function's configuration, its
   alias `live`, the API, the domain and the roles, and ignores the
   function's code attributes. The release workflow uploads the code of the
   tag, publishes an immutable version, moves the alias to it, smoke tests
   the public URL and moves the alias back on failure. This is the split
   the maintainer's website already uses (infrastructure in `iac`, content
   shipped by the site's CI through a narrowly scoped role), and it matches
   the practice the AWS Serverless Lens describes: consumers point at an
   alias, never at `$LATEST`, and every deployed version stays available
   for rollback.
5. **Region** `us-east-1`, like the rest of the root. The callers are
   Anthropic's and OpenAI's US servers; NBG is fetched once per date and
   cached.
6. **Logging**: one JSON line per MCP request with the method, the tool
   name, the client name and version, the protocol version, the HTTP
   status, the outcome and the duration. Never the arguments, so no amount,
   currency or date a user typed reaches a log. Retention 30 days.
7. **The npm package ships the HTTP entry points.** `nbg-rates-mcp --http`
   serves the same endpoint on a local port, and `dist/lambda.js` is the
   Lambda handler, so anyone can self-host either way. The stdio default
   is unchanged.
8. **The release workflow gets a `concurrency` group**, so a duplicate run
   of the same tag queues instead of racing the first one; the idempotent
   publish script then finds everything done.

## Change 1: the HTTP shell (this repository)

### `src/shell/http.ts`

```ts
export interface HttpDeps {
    readonly service: RatesService;
    readonly now: () => Date;
    readonly version: string;
    /** Host header values the endpoint answers for; empty disables the check. */
    readonly allowedHosts: readonly string[];
    readonly log: (line: RequestLogLine) => void;
}

export interface RequestLogLine {
    readonly time: string; // ISO 8601, UTC
    readonly method: string | null; // JSON-RPC method, null when the body is not a request
    readonly tool: string | null; // params.name of a tools/call, else null
    readonly client: { readonly name: string; readonly version: string } | null;
    readonly protocolVersion: string | null;
    readonly status: number;
    readonly outcome: 'ok' | 'error';
    readonly durationMs: number;
}

export function createHttpHandler(
    deps: HttpDeps,
    mcpFetch?: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response>;
```

`mcpFetch` defaults to the SDK handler of step 4; tests pass their own.

Behaviour of the returned function, in order:

1. If `allowedHosts` is not empty and the request's `Host` header (port
   stripped, lower-cased) is not in the list, answer 421 with a plain text
   body `This server answers only for <hosts>.` and no log line. This is
   the "put Host validation in front of the handler" the SDK's
   documentation asks for; the SDK's own `hostHeaderValidationResponse`
   helper is not used, because it answers with a JSON-RPC error body and a
   wrong host is not an MCP conversation.
2. `GET /` answers 200 `text/plain`:
   `nbg-rates-mcp <version>. MCP endpoint: POST /mcp (Streamable HTTP). Source: https://github.com/akalongman/nbg-rates-mcp`.
   It is the health check for the smoke test and what a person sees who
   opens the host in a browser.
3. `/mcp/` is served as `/mcp` (a pasted URL often ends in a slash). Any
   other path answers 404 `text/plain`
   `Not found. The MCP endpoint is /mcp.`, so a host pasted without the
   path gets the hint in the body.
4. `/mcp` is handed to `createMcpHandler(factory, { legacy: 'stateless' })`,
   created once in `createHttpHandler`. The factory is
   `() => createServer({ service, now, version })`. The SDK's own
   behaviour applies to method, `Accept` and `Content-Type` handling: a
   `GET /mcp` is 405, a body that is not JSON-RPC is 400, and a `POST`
   whose `Accept` does not list both `application/json` and
   `text/event-stream` is 406, so every test request carries that header.
5. For every request that reaches step 4, one `RequestLogLine` is written
   after the response is ready. `method`, `tool`, `client` and
   `protocolVersion` come from a lenient parse of the request body,
   which the handler reads once into bytes before step 4 and hands to the
   SDK as a fresh `Request` built from them (a body stream reads once, and
   a `Request` built from another one's stream would need the `duplex`
   option): a
   JSON object with a string `method` gives `method`; `params.name` gives
   `tool` when the method is `tools/call`; `params.clientInfo` gives
   `client` on `initialize`, and otherwise `params._meta` under the SDK's
   client info key, when a 2026-07-28 client sends it; `params.protocolVersion`
   gives `protocolVersion` on `initialize`. A body that does not parse
   gives nulls. `outcome` is `error` when the status is 400 or above, or
   when the buffered response body carries a JSON-RPC `error` member: a
   JSON body is parsed as one object, and an SSE body (the SDK's default
   for 2025-era clients, status 200 even for an error) is read as its
   `data:` lines, each parsed on its own. A tool that reports a problem
   inside a result (`isError`, the `error` text of a batch item) is an
   `ok` request: it answered. Nothing else from the body is read, and the
   line has no field for anything else.

The handler never throws: an exception from the SDK or from the parse
becomes a 500 `text/plain` `Internal error` with a log line of status 500,
and `console.error` gets one line of the exception's constructor name and
the fixed text `http handler failed`, never its message, which can quote
the request body or a user's arguments.

### `src/shell/http-adapter.ts`

Two pure functions that turn a transport's request shape into a web
`Request` and a `Response` back, shared by the local server and Lambda:

```ts
export interface IncomingRequest {
    readonly method: string;
    readonly url: string; // absolute, built from the Host header and the path plus query
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array | null;
}

export interface OutgoingResponse {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
}

export function toWebRequest(incoming: IncomingRequest): Request;
export async function fromWebResponse(response: Response): Promise<OutgoingResponse>;
```

`fromWebResponse` reads the whole body: the stateless handler answers
with a single JSON body or a short SSE stream that ends with the result,
so buffering is correct and is what API Gateway needs anyway. Repeated
response headers (`set-cookie` is the only one the platform splits, and
this server sets none) are joined with `, `.

### `src/shell/http-node.ts`

```ts
export interface ServeOptions {
    readonly port: number; // 0 picks a free port
    readonly host: string;
}

export function serveHttp(handler: (request: Request) => Promise<Response>, options: ServeOptions): Promise<{ port: number; close: () => Promise<void> }>;
```

A `node:http` server that collects the request body, calls
`toWebRequest`, awaits the handler, and writes `fromWebResponse`'s status,
headers and body. It is the only file in `src/shell` that imports
`node:http`. A failure while serving (a URL that cannot be built, a
stream error) answers 500 `Internal error` and writes the same reduced
`console.error` line as the handler; a client that hung up before its
body arrived whole gets no answer and no line.

### `src/bin.ts`

New flags: `--http` serves over HTTP instead of stdio, `--port <n>`
(default `3000`) and `--host <address>` (default `127.0.0.1`). The HELP
text documents them and `NBG_RATES_HTTP_HOSTS`. With `--http`, the process
builds one rates service, calls `createHttpHandler` with
`allowedHosts` from `NBG_RATES_HTTP_HOSTS` (comma separated, trimmed,
empty entries dropped) and `log` writing `JSON.stringify(line)` to
stdout, then `serveHttp`, then prints
`nbg-rates-mcp <version> serving HTTP on http://<host>:<port>/mcp (upstream <baseUrl>)`
to stderr. The end-to-end test reads the port from that line, so its
format is part of the contract. Without `--http` nothing changes.

### `src/lambda.ts`

```ts
export interface ApiGatewayV2Event {
    readonly rawPath: string;
    readonly rawQueryString: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly requestContext: { readonly http: { readonly method: string } };
    readonly body?: string;
    readonly isBase64Encoded: boolean;
}

export interface ApiGatewayV2Result {
    readonly statusCode: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly isBase64Encoded: boolean;
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Result>;
```

Module level, run once per instance: the rates service with the same
client, cache and `now` as `bin.ts`, and the HTTP handler with
`allowedHosts` from `NBG_RATES_HTTP_HOSTS` and `log` writing to
`console.log` (Lambda forwards it to CloudWatch). `handler` builds the
URL from `https://` plus the `host` header plus `rawPath` plus `?` and
`rawQueryString` when not empty, decodes the body from base64 when
`isBase64Encoded`, calls the handler through the adapter, and returns the
response with `isBase64Encoded: false` and the body as UTF-8 text (every
response this server produces is text). The interfaces are local so the
package gains no `@types/aws-lambda` dependency; they name only the
fields read.

`src/bin.ts` and `src/lambda.ts` build the rates service and read the
package version through one module, `src/shell/environment.ts`, so the
two entries cannot drift apart.

### Environment variables

`NBG_RATES_HTTP_HOSTS`: comma separated `Host` values the HTTP endpoint
answers for; unset or empty disables the check. Used by `--http` and by
the Lambda entry. Terraform sets it to `nbg-rates.env.ge` on the function.
`NBG_RATES_BASE_URL` and `NBG_RATES_DEBUG` keep their meaning in both
entries.

### Package

`files` is unchanged (`dist` already ships everything). `exports` gains
nothing: the Lambda handler is addressed by file path, which is how Lambda
addresses it. The package is `"type": "module"`, and the zip carries that
`package.json`, so Lambda loads `dist/lambda.js` as an ES module. The
`engines` floor stays at Node 22.

## Change 2: infrastructure (`personal/iac`, `terraform/aws/nbg-rates-mcp.tf`)

One file, in the root that already holds the zone, the OIDC provider and
the website. Resource names carry the prefix `nbg_rates_mcp`; AWS names
are `nbg-rates-mcp` unless AWS forces otherwise.

- **Function**: `aws_lambda_function` `nbg-rates-mcp`, runtime
  `nodejs24.x`, architecture `arm64`, handler `dist/lambda.handler`,
  memory 256 MB, timeout 29 seconds (one second under the gateway's
  ceiling, long enough for a NBG attempt, its retry and the response),
  `reserved_concurrent_executions = 10`, environment
  `NBG_RATES_HTTP_HOSTS=nbg-rates.env.ge`, `publish = true`, so the
  placeholder becomes the immutable version 1 and nothing ever serves
  `$LATEST`. Its code at creation is a placeholder zip built by Terraform's `archive_file` from
  `functions/nbg-rates-mcp/placeholder/dist/lambda.mjs`, a handler that
  answers 503 `text/plain` `nbg-rates-mcp is not deployed yet.`, and
  `lifecycle { ignore_changes = [filename, source_code_hash] }` so the
  release workflow's uploads never show as drift. The execution role
  attaches `AWSLambdaBasicExecutionRole` and nothing else. The log group
  `/aws/lambda/nbg-rates-mcp` is declared with `retention_in_days = 30`
  and named in the function's `logging_config` with the text format, so
  it exists with the retention before the first invocation and each line
  the handler writes stays the JSON it wrote, whose fields Logs Insights
  discovers on its own (the JSON format would wrap the line as a string
  inside its own envelope).
- **Alias** `live`, created on `aws_lambda_function.nbg_rates_mcp.version`
  (the placeholder's version 1) with
  `lifecycle { ignore_changes = [function_version] }`. Everything
  downstream points at the alias and never at `$LATEST`:
  `update-function-code` overwrites `$LATEST` before the smoke test has
  run, so an alias on `$LATEST` could not be rolled back.
- **API**: `aws_apigatewayv2_api` HTTP, one `AWS_PROXY` integration to the
  alias's invoke ARN with payload format 2.0 and `timeout_milliseconds =
  30000`; a single `$default` route, so every path reaches the function
  and the handler alone decides between `/`, `/mcp` and a 404 with a
  hint; the `$default` stage with
  `auto_deploy`, `default_route_settings { throttling_burst_limit = 10,
  throttling_rate_limit = 10 }` (requests per second across all callers:
  a flood of fast requests is refused with 429 at the gateway and stays
  off the function's reserved concurrency of 10, but requests slower
  than a second, such as tool calls during an NBG outage at about 21
  seconds each, can still occupy all 10 instances, and the function's
  own throttle then reaches callers as a 500), and access logging to the
  30 day log group `/aws/apigateway/nbg-rates-mcp` with the fields `requestId`, `ip`,
  `requestTime`, `httpMethod`, `path`, `status`, `integrationLatency`
  and `userAgent`. `aws_lambda_permission` lets the API invoke the alias
  (qualifier `live`, `source_arn` of the API's execute ARN). The API's
  own `execute-api` hostname is disabled
  (`disable_execute_api_endpoint = true`), so the custom domain is the
  only way in and the Host check is a second guard.
- **Domain**: `aws_acm_certificate` for `nbg-rates.env.ge`, DNS validated
  with the record in `aws_route53_zone.env_ge` and an
  `aws_acm_certificate_validation` waiter, in the same shape as the
  website's; `aws_apigatewayv2_domain_name` with `TLS_1_2`, the
  regional endpoint and `ip_address_type = "dualstack"` (an IPv4-only
  domain name gives the `AAAA` alias no address to return);
  `aws_apigatewayv2_api_mapping` of the API's
  `$default` stage with no path key; Route 53 `A` and `AAAA` alias
  records for `nbg-rates.env.ge` to the domain name's target.
- **Deploy role** `nbg-rates-mcp-deploy` in `nbg-rates-mcp.tf` (the
  website's role stays in `iam.tf`; the new file is self-contained):
  trust through the existing `aws_iam_openid_connect_provider.github`,
  `aud` equal to `sts.amazonaws.com`, and `sub` `StringLike`
  `repo:akalongman@423050/nbg-rates-mcp@1411291932:ref:refs/tags/v*`.
  Only a release tag's run can assume it, and the repository's "Release
  tags" ruleset restricts who can create those. Inline policy:
  `lambda:GetFunction`, `lambda:GetFunctionConfiguration`,
  `lambda:UpdateFunctionCode`, `lambda:PublishVersion` on the function
  ARN and `<function ARN>:*`; `lambda:GetAlias`, `lambda:UpdateAlias` on
  the function ARN and `<function ARN>:live`. Lambda authorizes those two
  actions against the unqualified function ARN, so the alias ARN alone
  would deny them; the role can therefore move any alias of this one
  function, and `live` is its only alias. Nothing on configuration, DNS,
  the API or any other function.
- **Budget** `nbg-rates.env.ge` of 5 USD a month, filtered to the
  services AWS Lambda, Amazon API Gateway and AmazonCloudWatch, alerting
  on actual and forecast spend to the owner's address, in the shape of the
  website's budget in `billing.tf` but declared in the new file.
- **Output** `nbg_rates_mcp` with `AWS_ROLE_ARN` (the deploy role),
  `FUNCTION_NAME`, `FUNCTION_ALIAS` and `MCP_URL`
  (`https://nbg-rates.env.ge/mcp`), and a script
  `scripts/nbg-rates-mcp-github-vars.sh` that copies all four into the
  GitHub repository variables of `akalongman/nbg-rates-mcp`, in the shape
  of `scripts/longman-me-github-vars.sh`.
- **Docs**: `docs/aws.md` gains a table row for the file and a section
  "nbg-rates.env.ge" stating the deploy split, the rollback command, the
  two log groups and the budget. `CLAUDE.md` in that repository gets the
  one line "after an apply that creates or replaces the function or the
  deploy role, run `scripts/nbg-rates-mcp-github-vars.sh`".

Expected monthly cost at a thousand to a million requests: $0.50 for the
zone already paid, $0.00 to $1.00 for API Gateway, cents for Lambda and
logs.

## Change 3: the deploy job and the release workflow (this repository)

`release.yml` gains:

- At the top, `concurrency: { group: release-${{ github.ref }}, cancel-in-progress: false }`.
- A third job `deploy`, `needs: publish`, with `permissions: { contents: read, id-token: write }`,
  that runs only when the repository variable `AWS_ROLE_ARN` is set
  (`if: vars.AWS_ROLE_ARN != ''`), so a fork or a repository without the
  infrastructure releases to npm and GitHub as today. Its own
  `concurrency: { group: lambda-deploy, cancel-in-progress: false }`
  queues deploys of different tags instead of letting them race over
  the one alias. Because the job can mint AWS credentials, it runs no
  installed package: `build-lambda.sh` installs the production
  dependencies with `--ignore-scripts` and only zips them, and the smoke
  test needs `node` alone. Steps:
  1. Checkout with `persist-credentials: false`; `actions/setup-node`
     with Node 24, no cache.
  2. Download the `release` artifact and build the Lambda zip with
     `scripts/build-lambda.sh <version>`.
  3. `aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0`
     with `role-to-assume: ${{ vars.AWS_ROLE_ARN }}`, `aws-region: us-east-1`.
  4. `scripts/publish-release.sh lambda <version>` with `FUNCTION_NAME`,
     `FUNCTION_ALIAS` and `MCP_URL` passed from the repository variables
     through the step's environment.

### `scripts/build-lambda.sh <version>`

Extracts `nbg-rates-mcp-<version>.tgz` into a temporary directory, whose
`package/` subdirectory (npm's tarball root) is where everything happens
next: copies the checkout's `package-lock.json` beside the extracted
`package.json` (the tarball does not carry it, and the lock at the tag is
the one the package was built from), runs
`npm ci --omit=dev --ignore-scripts` there, and from inside `package/`
zips `dist`, `node_modules` and `package.json` into
`nbg-rates-mcp-<version>-lambda.zip` in the original working directory,
with `zip -X -r`, so the archive's root holds `dist/lambda.js` and the
handler string `dist/lambda.handler` resolves. No bundler:
the function runs exactly the files the npm package ships plus its two
production dependencies, about 25 MB unzipped, well under Lambda's limit.

### `scripts/publish-release.sh lambda <version>`

A fourth step in the existing idempotent script, in the same style as
`npm`, `github` and `registry`:

The commands, with `$version` the argument, each reading one value with
`--query` and `--output text` so a variable never holds JSON:

1. Read the alias and refuse an unpublished one:
   `previous=$(aws lambda get-alias --function-name "$FUNCTION_NAME" --name "$FUNCTION_ALIAS" --query FunctionVersion --output text)`.
   If `previous` is `$LATEST`, print
   `$FUNCTION_ALIAS points at $LATEST; publish a version first` and exit
   1: a rollback target must be immutable. Then
   `current=$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --qualifier "$previous" --query Description --output text)`;
   if `current` equals `v$version`, print
   `$FUNCTION_NAME $FUNCTION_ALIAS is already v$version; smoke testing it`
   and run the smoke test of step 5, because a run stopped after the
   alias moved left it unverified. On failure there is no automatic
   rollback (the version it replaced is unknown here): the step prints
   the `list-versions-by-function` and `update-alias` commands for a
   person and exits 1.
   If `current` is a plain release `vX.Y.Z` newer than `v$version`,
   print `$FUNCTION_NAME $FUNCTION_ALIAS serves <current>, newer than v$version; not deploying an older release`
   and return before any upload, so a re-run of an older release's job
   never downgrades production. Versions compare by their `X.Y.Z` core
   with `sort -V`, and a pre-release of the live release is older than
   it; a description that is not a plain release (the placeholder's, a
   pre-release) never blocks a deploy. Then refuse a missing
   `nbg-rates-mcp-$version-lambda.zip` before touching the function.
2. `aws lambda update-function-code --function-name "$FUNCTION_NAME" --zip-file "fileb://nbg-rates-mcp-$version-lambda.zip" --query FunctionArn --output text`,
   then `aws lambda wait function-updated-v2 --function-name "$FUNCTION_NAME"`.
3. `new=$(aws lambda publish-version --function-name "$FUNCTION_NAME" --description "v$version" --query Version --output text)`.
4. `aws lambda update-alias --function-name "$FUNCTION_NAME" --name "$FUNCTION_ALIAS" --function-version "$new" --query FunctionVersion --output text`.
5. Smoke test: `node scripts/smoke-http.ts "$MCP_URL" "$version"`.
   On failure,
   `aws lambda update-alias --function-name "$FUNCTION_NAME" --name "$FUNCTION_ALIAS" --function-version "$previous"`,
   print `rolled back $FUNCTION_ALIAS to version $previous`, and exit 1,
   so the run is red while the public URL serves the last good release.

Rollback by hand is the same `update-alias` with any earlier version;
`aws lambda list-versions-by-function` shows them with their tag in
`Description`.

### `scripts/smoke-http.ts <url> <version>`

Imports nothing from `node_modules`, because the deploy step that runs
it holds the AWS session, and uses only erasable TypeScript syntax, so
Node 24 runs it as is (`node scripts/smoke-http.ts <url> <version>`);
typecheck and lint still cover it. It speaks MCP's JSON-RPC over
`fetch`, with `Accept: application/json, text/event-stream`, and reads
each answer as JSON or as an SSE stream. First `GET /` on the URL's
origin must answer 200 with text that names `<version>`; then
`initialize` must report `serverInfo.version` equal to `<version>`,
`notifications/initialized` must answer 202, `tools/list` must return
exactly the five tool names, and `nbg_convert` of 10 USD to GEL with no
date must return a `resultRounded` that is a finite number with at most
two decimals, checked with a tolerance (the amount times 100 within
1e-6 of an integer), never exact float equality, which rejects valid
amounts such as 20.01. The conversion is the one check that reaches
NBG, so it is tried up to three times, five seconds apart, when its
request fails, the endpoint answers 5xx or the tool answers an error,
each retry printing one line with the attempt and the reason; a wrong
amount and every other check fail at once. The protocol version it
sends is the latest one of the SDK in `package-lock.json`, so an SDK
update that changes it updates the script. Exit 0 on success, 1 with
the first failing check on stderr, 2 on a usage error. It is also the
manual check after an infrastructure change.

### One-time order

Infrastructure first (`terraform apply` in `iac`, then
`scripts/nbg-rates-mcp-github-vars.sh`), then the 0.5.0 tag. Until the
variables exist the `deploy` job is skipped; until the first deploy the
URL answers 503 from the placeholder.

## Change 4: documents

- **README**: the opening sentence says the server runs on your machine
  or as a hosted connector you paste into claude.ai or ChatGPT. Under
  "Install", a new first subsection "claude.ai, Claude mobile and
  ChatGPT (nothing to install)": paste `https://nbg-rates.env.ge/mcp`
  as a custom connector. On claude.ai that is Customize, then
  Connectors, then "+ Add" and "Add custom connector" (on a Team or
  Enterprise plan an owner adds it under Organization settings, then
  Connectors), and the connector then appears in the mobile apps and
  in Claude Desktop too; ChatGPT needs developer mode and may require a
  paid plan. It states what the hosted copy is: the latest release, run
  by the maintainer on AWS, no account, never the amounts, dates or
  currencies asked, and two logs kept for 30 days: which tool was
  called from which client, and the gateway's access log (time, path,
  status, and the caller's IP address and user agent; for claude.ai and
  ChatGPT the caller is Anthropic's or OpenAI's server). Under
  "Node.js", a paragraph "Self-hosting": `nbg-rates-mcp --http --port
  3000` and the Lambda handler `dist/lambda.handler` behind an API
  Gateway HTTP API with payload format 2.0 and the `$default` stage,
  with `NBG_RATES_HTTP_HOSTS`. The environment variable table gains
  `NBG_RATES_HTTP_HOSTS` (unset or empty: any host).
- **manifest.json**: unchanged (the bundle is the stdio server).
- **server.json** lists the hosted endpoint as a remote,
  `{ "type": "streamable-http", "url": "https://nbg-rates.env.ge/mcp" }`,
  so MCP Registry clients can find it. The registry (checked at its
  release v1.8.1) requires a remote to be https, not localhost, and not
  listed by another server name; it does not tie a remote's host to the
  `io.github` namespace.
- **CHANGELOG** `## 0.5.0 - <release date>` with the hosted endpoint, the
  `--http` flag, the Lambda entry, the environment variable and the
  registry remote.
- **Versions** 0.5.0 in `package.json`, `package-lock.json`,
  `manifest.json` and `server.json`; `scripts/check-release.ts` is the
  check.
- The main spec's sentence "There is no hosted component" is not edited;
  this document supersedes it.

## Testing

- `src/shell/http.test.ts`, unit, through in-memory `Request` objects and
  a fixture-backed service: `GET /` is 200 and names the version;
  `POST /mcp` with an `initialize` body answers 200 with the server's name
  and version and writes a log line with `method` `initialize`, the
  client name and version and `protocolVersion`; a `tools/call` of
  `nbg_convert` writes `tool` `nbg_convert` and nothing of the arguments
  (the serialised line does not contain the amount or the currency); a
  wrong `Host` is 421 with no log line; an empty `allowedHosts` skips the
  check; `/other` is 404 and `/mcp/` is served as `/mcp`; a `POST` without
  the SSE `Accept` is 406; a non-JSON body gives a 4xx status and a line
  with null fields and `outcome` `error`; a tool call that fails inside
  its result is `ok` while a JSON-RPC error carried in an SSE body is
  `error`; a service that throws is answered by the SDK as a tool error
  (status 200, `isError` true, `outcome` `ok`), so the 500 path is only
  for a failure of the handler itself: `createHttpHandler` takes an
  optional second argument, the MCP fetch function, which production
  leaves to the SDK and the test replaces with one that rejects. A log
  callback that throws never changes a response: the failure goes to
  `console.error` in the same reduced form.
- `src/shell/http-adapter.test.ts`: round trips of method, URL, headers
  and body, including a binary body and a response with a repeated
  header.
- `src/lambda.test.ts`: `handler` with a recorded API Gateway v2 event for
  `POST /mcp` (a plain body and the same body base64 encoded) returns the
  expected status and JSON; `GET /` returns the text; the result is never
  base64 encoded. The recorded events are fixtures under `test/fixtures/`.
- `test/e2e/http.test.ts`: starts `dist/bin.js --http --port 0` against
  the fixture NBG server, reads the port from the stderr line, connects
  with `StreamableHTTPClientTransport`, and runs the same scenarios as
  `stdio.test.ts` (today's rates, a conversion, a batch with a bad date, a
  history with its summary, the three error texts) plus one that a
  second client sees the cache warm (the fixture server counts requests).
- `test/e2e/build-lambda.test.ts` packs the package, runs
  `build-lambda.sh` the way the deploy job does (without the
  `npm_*` variables `npm run` sets, which npm 11 would refuse in the
  script's `npm ci` when a user `.npmrc` sets `allow-scripts`), and
  checks the zip's listing.
- `test/scripts/publish-release.test.ts` drives the `lambda` step
  against stub `aws` and `node` commands: a deploy, a rollback, an
  alias already on the version (smoke tested again, and the manual
  commands when that fails), a newer release left alone, and an alias
  on `$LATEST` refused. Every local run sets `AWS_PROFILE` to a
  profile that does not exist, so a stub that fails to shadow the real
  CLI cannot reach AWS.
- `scripts/smoke-http.ts` runs in the deploy job and by hand; it is not
  part of `npm test`.
- Contract tests are unchanged.
- Gates stay `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:e2e`,
  then `bash scripts/build-bundle.sh && npx tsx scripts/check-release.ts 0.5.0`.
  The infrastructure gate is `terraform -chdir=terraform/aws validate` and
  a plan that adds only the new file's resources.

## Operations

- **Counting use**: CloudWatch Logs Insights on `/aws/lambda/nbg-rates-mcp`:
  `filter method = "initialize" | stats count() by bin(1d)` for
  conversations a day, `filter method = "tools/call" | stats count() by tool`
  for calls by tool, `stats count() by client.name` for the share by
  host. The documented queries live in the README of `iac/docs/aws.md`,
  not in this repository.
- **A broken release**: the deploy job rolls the alias back by itself when
  the smoke test fails; a release that passed the smoke test and is found
  broken later is rolled back by hand with `update-alias`. A re-run of
  the live release's job smoke tests it again and, on failure, prints
  the manual commands; a re-run of an older release's job while a newer
  one is live changes nothing.
- **A configuration change in Terraform** (memory, timeout, an
  environment variable) is published as a new version of the current
  `$LATEST` code, and the alias stays where it is, so the change is not
  live until the alias moves: either the next release, or by hand with
  `update-alias` to that version, the highest number in
  `list-versions-by-function`, once its `CodeSha256` equals the live
  version's. After a release whose smoke test failed, `$LATEST` still
  holds the rejected build, so the hashes differ and the change waits
  for the next release. `docs/aws.md` says so beside the rollback
  command.
- **A NBG outage**: tool calls answer `upstream_unavailable` within about
  21 seconds, inside the function's timeout; the endpoint answers 200
  with a tool result that carries `isError` and the error text, as the
  stdio server would. Each such call holds an instance for those 21
  seconds, so more than about one call every two seconds fills the
  reserved concurrency and the rest are answered 500 (see "A flood").
- **A flood**: throttling answers 429 at the gateway above 10 requests a
  second; reserved concurrency caps the function at 10 parallel
  instances, and requests beyond those while all 10 are busy are
  answered 500 by the gateway (the function's own throttle); the budget
  mails at 5 USD. The URL may be slow or refuse during a flood, and
  nothing else in the account is affected.
- **A batch of many uncached dates**: `nbg_convert_many` fetches dates one
  after another; a hundred dates never seen by a cold instance can
  exceed the 29 second timeout. The function times out before the
  gateway's 30 second integration timeout, and the gateway reports the
  failed invocation as 500; the model is expected to retry with a
  smaller batch. Accepted; a shared
  cache is out of scope.

## Out of scope

- Authentication, per-user keys and usage caps per user. The host and
  path leave room for them without changing the URL.
- WAF, a shared cache between instances, CloudFront.
- ChatGPT's deep research tools (`search` and `fetch`).
- A landing page at `env.ge` or at the host's root beyond the one line
  text of `GET /`.
- Attaching the Lambda zip to the GitHub release.
- The zones `npm.ge` and `ssh.ge`.
- Submission of the hosted URL to Anthropic's connector directory, a form
  the maintainer fills after 0.5.0 ships.
