# Browser redirect at /mcp and independent share text (0.6.3): design

Approved: 2026-10-16.

## Why

The launch posts link the landing page, and two things a stranger meets
there work against the project.

1. The share text never says the tool is independent. A link to
   `https://nbg-rates.env.ge` previews in chats and feeds as
   "NBG Rates: official lari exchange rates in Claude and ChatGPT" over
   "Official National Bank of Georgia (NBG) lari exchange rates in Claude
   and ChatGPT: ...". In a feed that reads as the bank's own product. The
   page body says it is independent; the preview, which travels on its
   own, does not. LinkedIn's feed shows the image, the title and the
   domain, X's large card only the image and the domain, and Facebook
   often hides the description, so the description alone does not reach
   LinkedIn readers; the title does. (Platform behaviour as reported, not
   measured; the owner chose description and title, not the card image,
   on 2026-10-16.)
2. The share card (`og.png`) prints `nbg-rates.env.ge/mcp`, the URL to
   paste into a connector. Someone who types it into a browser gets the
   raw JSON-RPC answer `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}`
   with status 405.

## Worked example

- A Georgian accountant sees the card in a Facebook group, types
  `nbg-rates.env.ge/mcp` into Chrome. Today: a 405 and a line of JSON.
  After: a 302 to `https://nbg-rates.env.ge/`, the landing page with the
  setup steps and a link to `/ka`.
- Claude, ChatGPT or any MCP client sends `GET /mcp` with
  `Accept: text/event-stream` (the Streamable HTTP way to open a stream).
  Today and after: 405 with `Allow: POST`, unchanged.
- A link to `https://nbg-rates.env.ge` pasted in LinkedIn previews with
  the title "NBG Rates (independent): official lari exchange rates in Claude and ChatGPT"; in Slack, Telegram or WhatsApp also with the
  description "Official National Bank of Georgia (NBG) lari rates in Claude and ChatGPT, from an independent project not affiliated w...", so the disclaimer is in the first line a
  reader sees.

## Goals

- A browser that opens `/mcp` on the hosted site lands on the landing page.
- Every MCP client keeps exactly today's answers at `/mcp`.
- The title of both pages says, right after the name, that the project
  is independent, and the share and search description says, within its
  first 140 characters, that it is independent and not affiliated with
  the bank.

## Non-goals

- Choosing English or Georgian from `Accept-Language`. The redirect goes
  to `/`, which links to `/ka` (my call: the card is in English, and one
  target keeps the rule simple).
- Changing the share card image (`og.png`), or any page text other than
  the title and the description. X's large card, which shows only the
  image and the domain, keeps today's look (the owner's choice).
- Anything on hosts other than `nbg-rates.env.ge` (a local `--http`
  server, the API Gateway default domain): they keep today's answers, as
  the landing page itself is served only on the hosted host.

## Anti-goals

- An MCP client redirected away from `/mcp`. The rule must be narrow
  enough that no MCP request can match it.
- A permanent redirect. Browsers cache a 301 or 308 indefinitely, and
  `/mcp` may later want its own page.

## Decided

### The redirect

A request is a browser visit to the endpoint when all of these hold:

- the host is the site host (`SITE_HOST`, `nbg-rates.env.ge`);
- the path is `/mcp` or `/mcp/` (any query string);
- the method is `GET` or `HEAD`;
- `Accept` contains `text/html` and does not contain `text/event-stream`
  (case-insensitive). A request without `Accept` is not a browser visit.

It is answered `302 Found`, `location: /`, `cache-control: no-store`, the
site's common headers (`x-content-type-options`, `referrer-policy`), and
no body. Every other request to `/mcp` goes to the MCP handler as today,
including its 405 with `Allow: POST`.

The decision lives with the other site paths in
`src/shell/site/routes.ts`, which today sees only the method and the URL;
it now also needs the `Accept` header. A redirect is a site answer, so it
writes no MCP request log line (the gateway's access log still records it,
as it does every page visit, which the privacy text already says).
`robots.txt` keeps `Disallow: /mcp`.

### The title and the description

`title` in `src/shell/site/copy-en.ts` and `copy-ka.ts` (the `<title>`,
`og:title` and `twitter:title`) becomes:

- English (75 characters): `NBG Rates (independent): official lari exchange rates in Claude and ChatGPT`
- Georgian (83 characters), to be confirmed by the owner:
  `NBG Rates (დამოუკიდებელი პროექტი): ლარის ოფიციალური კურსები Claude-სა და ChatGPT-ში`

`description` (the meta description, `og:description` and
`twitter:description`) becomes:

- English (178 characters, the clause ends at 130):
  `Official National Bank of Georgia (NBG) lari rates in Claude and ChatGPT, from an independent project not affiliated with the bank: any date, exact conversions, free, no account.`
- Georgian (225 characters, the clause ends at 136), to be confirmed by the owner:
  `საქართველოს ეროვნული ბანკის ოფიციალური კურსები Claude-სა და ChatGPT-ში, დამოუკიდებელი პროექტისგან, რომელიც ბანკთან არ არის დაკავშირებული: ლარის კურსი ნებისმიერი თარიღისთვის და ზუსტი კონვერტაცია, უფასოდ და რეგისტრაციის გარეშე.`

Tests pin that each title names the project independent within its first
30 characters (`independent`, `დამოუკიდებელი`), so a truncated title still
shows it, and that each description's independence clause ends within its
first 140 characters. Previews and search snippets cut by pixel width, and
Georgian letters are wide, hence the margin below the usual 155 to 160.

### Release

0.6.3, with a CHANGELOG entry. The release smoke test is unchanged: it
checks `GET /` with Node's default `Accept: */*` and posts to `/mcp`,
neither of which matches the redirect rule. After the deploy, a request
with a browser `Accept` to `https://nbg-rates.env.ge/mcp` answers 302 to
`/`, and one with `Accept: text/event-stream` answers 405 with
`Allow: POST`.

## Left to the builder

- The exact shape of the new parameter of the site responder.
- Test names and placement.
