# Directory listings

The texts and files for listing the hosted connector,
https://nbg-rates.env.ge/mcp, in Anthropic's Connectors Directory and in
OpenAI's app directory. The design behind them is
`docs/superpowers/specs/2026-10-13-landing-page-design.md`.

Every text to paste is a plain paragraph with no formatting, under a
heading or a bold label that names the field. Copy it from the rendered
file (on GitHub, for example), where its lines join with single spaces;
the source breaks it at 80 columns, and those breaks must not reach a
portal field. A field with a character limit names the limit in its
heading.

## What only the maintainer can do

These steps need the maintainer's own accounts. They start once release
0.6.0 is live, since the verification route
`/.well-known/openai-apps-challenge` arrives with it (it answers 404 until
a token is set). In order:

1. Verify the OpenAI developer identity as the individual Avtandil
   Kikabidze, the publisher that the page's operator line, its privacy
   section and both listings name.
2. Record the demo video OpenAI's review asks for, for example the
   connector added in ChatGPT answering some of the positive test cases
   below.
3. Create the plugin in OpenAI's portal for https://nbg-rates.env.ge/mcp
   and copy the domain verification token.
4. Set the token in the infrastructure repository (`personal/iac`), as its
   `docs/aws.md` describes: the token becomes the default of the variable
   `nbg_rates_mcp_openai_challenge` in `terraform/aws/variables.tf`,
   committed. Run the targeted apply that `docs/aws.md` gives, which
   publishes a new function version from the live code, and promote that
   version with the `CodeSha256` check and `update-alias` described there
   (or let it go live with the next release). Then
   `curl -s https://nbg-rates.env.ge/.well-known/openai-apps-challenge`
   prints the token and nothing else.
5. Run OpenAI's domain verification.
6. Build OpenAI's plugin ZIP, with the manifest name given below, and
   upload it.
7. Run all eight OpenAI test cases below in ChatGPT, and each of the five
   tools in Claude with the connector added, and correct any row whose
   outcome differs from what this file says.
8. Submit to both directories. The sections below give the texts and
   files for the fields and steps they name; anything else a portal asks
   for is answered in that portal.

## Anthropic Connectors Directory

### Connector URL

https://nbg-rates.env.ge/mcp

### Authentication

None. The connector serves public data and needs no account, so choose
no authentication.

### Name (at most 100 characters)

NBG Rates

### One-liner (at most 200 characters)

Official National Bank of Georgia exchange rates of the lari (GEL): the
rate on any date, exact conversions and rate history. Independent, not
affiliated with NBG.

### Description (at most 2,000 characters)

NBG Rates gives Claude the official exchange rates of the Georgian lari
(GEL), as set by the National Bank of Georgia (NBG). Ask in plain words
for the lari rate on any date, convert an amount or a list of invoices,
or see how a currency moved. It is free, with no account and no key.

Five read-only tools: the rates in force on a date; converting an amount
between two currencies; converting a list of amounts, each at the rate of
its own date, with a total in one currency; one currency's history over up
to a year, with the first, last, lowest and highest rate, the change and
the average; and the currencies NBG quotes, with the number of units it
quotes each in.

It gets right the details a raw lookup gets wrong. The rates are NBG's,
exactly as nbg.gov.ge shows them, and dates are calendar days in Tbilisi.
NBG sets rates on business days around 17:00 Tbilisi time, valid from the
next calendar day, so a Sunday, a Monday or the day after a public
holiday keeps the last rate set, and the answer says which day's rate
applies. A date NBG has not published yet is an error, never a guess.
Every rate is per one unit, and the rates for a date also show NBG's
quoted form (1.6452 GEL per 100 JPY is 0.016452 GEL per yen); converted
amounts are computed exactly from NBG's figures and rounded half up to two
decimals, the way a ledger posts them.

It never records the amounts, dates or currencies asked. It keeps two
logs for 30 days
(which tool was called from which client and whether NBG answered, and
the gateway's access log), used only to keep the service running, to see
which clients use it and to investigate errors or abuse; they are not
sold, shared or used for advertising. Details:
https://nbg-rates.env.ge/#privacy

An independent open-source project operated by Avtandil Kikabidze, not
affiliated with the National Bank of Georgia. Anyone who needs a rate for
an official or legal purpose should check it on nbg.gov.ge. Source code:
https://github.com/akalongman/nbg-rates-mcp

### Categories

The portal asks for one to five categories from its own list, which
Anthropic's submission documentation did not publish when this was
written (checked 2026-10-14). These are suggestions, to match to the
portal's list at submission: Finance first, then Data (or Research,
whichever of the two the list offers).

### Documentation URL

https://nbg-rates.env.ge

### Privacy policy URL

https://nbg-rates.env.ge/#privacy

### Support contact

https://github.com/akalongman/nbg-rates-mcp/issues

### Icon

Upload `assets/icon.png`, a square 512 by 512 PNG. Anthropic documents no
format or size for it.

### Other portal steps

The portal asks for more than the fields above: a URL slug in the same
step, then use cases, the company, data handling, test and launch
instructions, and compliance acknowledgments.

#### URL slug (permanent once the listing is published)

nbg-rates

#### Company

The publisher is the individual Avtandil Kikabidze, not an organisation,
as on the page's operator line and in OpenAI's developer verification.

**Name**

Avtandil Kikabidze

**Website**

https://nbg-rates.env.ge

**Primary contact**

https://github.com/akalongman/nbg-rates-mcp/issues

#### Use cases

**Primary use cases**

Looking up the official National Bank of Georgia rates of the lari (GEL)
in force on a date; converting an amount between two currencies at the
official rate of a date; converting a list of amounts, such as invoices,
each at the rate of its own date, with a total in one currency; following
one currency's rate over up to a year, with the first, last, lowest and
highest rate, the change and the average; and listing the currencies NBG
quotes, with the number of units it quotes each in.

**What users need before connecting**

Nothing on the connector's side: it is free and needs no account and no
key. Adding https://nbg-rates.env.ge/mcp as a connector is the whole
setup.

**Reads or writes data**

Reads only. All five tools are read-only and change nothing.

#### Data handling

**Underlying API**

A third party's API that the publisher does not control: the public
exchange rate API of the National Bank of Georgia (NBG).

**Personal health data**

No.

**Sponsored content**

No.

#### Test and launch

The portal also asks for a confirmation that every tool was run, which
step 7 of the maintainer's steps provides.

**Access instructions**

No account, credentials or setup are needed. Add
https://nbg-rates.env.ge/mcp as a custom connector in Claude with no
authentication, then ask these five questions, one per tool: What were
the official NBG rates for USD and EUR on 1 March 2026? Convert 1,200 GBP
to GEL at today's NBG rate. Convert these invoices to GEL, each at the
NBG rate of its own date: 500 USD on 2 October 2026 and 300 EUR on 5
October 2026. How did the US dollar move against the lari in September
2026? Which currencies does the National Bank of Georgia quote? They
call nbg_get_rates, nbg_convert, nbg_convert_many, nbg_rate_history and
nbg_list_currencies, in that order.

#### Compliance

The seven compliance acknowledgments are ticked in the portal; there is
nothing to paste for them.

## OpenAI app directory

### Plugin manifest name (stable identifier, keep it once published)

nbg-rates

### Display name (at most 30 characters)

NBG Rates

### Short description (at most 30 characters; this text is 23)

Official NBG lari rates

### Long description (at most 4,000 characters)

NBG Rates brings the official exchange rates of the Georgian lari (GEL),
as set by the National Bank of Georgia (NBG), into ChatGPT. It is an
independent open-source project operated by Avtandil Kikabidze, not
affiliated with the National Bank of Georgia. Ask in plain words for the
lari rate on any date, convert an amount or a list of invoices, or see
how a currency moved. It is made for accountants and open to anyone:
free, with no account and no key.

For example: What were the USD and EUR rates on 1 March 2026? Convert
1,200 GBP to GEL at today's rate. Convert these invoices to GEL, each at
the rate of its own date, and give me the total. How did the USD rate
move in September 2026? Which currencies does NBG quote, and per how many
units?

Five read-only tools answer these: the rates in force on a date;
converting an amount between two currencies; converting a list of
amounts, each at the rate of its own date, with a total in one currency;
one currency's history over up to a year, with the first, last, lowest and
highest rate, the change and the average; and the currencies NBG quotes,
with the number of units it quotes each in.

It gets right the details a raw lookup gets wrong. The rates are NBG's,
exactly as nbg.gov.ge shows them, and dates are calendar days in Tbilisi.
NBG sets rates on business days around 17:00 Tbilisi time, valid from the
next calendar day, so a Sunday, a Monday or the day after a public
holiday keeps the last rate set, and the answer says which day's rate
applies. A date NBG has not published yet is an error, never a guess.
Every rate is per one unit, and the rates for a date also show NBG's
quoted form (1.6452 GEL per 100 JPY is 0.016452 GEL per yen); converted
amounts are computed exactly from NBG's figures and rounded half up to two
decimals, the way a ledger posts them.

The connector never records the amounts, dates or currencies you ask
about. It keeps two logs for 30 days:
which tool was called from which client and whether NBG answered, and
the gateway's access log, with the time, path, status, and the caller's
IP address and user agent. For ChatGPT, the caller is OpenAI's server.
The logs are used only to keep the service running, to see which
clients use it and to investigate errors or abuse; they are not sold,
shared or used for advertising. Details:
https://nbg-rates.env.ge/#privacy

The connector is free to use and provided as is, without warranty of any
kind. Anyone who needs a rate for an official or legal purpose should
check it on nbg.gov.ge. Terms: https://nbg-rates.env.ge/#terms

### Website URL

https://nbg-rates.env.ge

### Support URL

https://github.com/akalongman/nbg-rates-mcp/issues

### Privacy policy URL

https://nbg-rates.env.ge/#privacy

### Terms of service URL

https://nbg-rates.env.ge/#terms

### Logo and composer icon

Upload `assets/icon.png` as both: a square 512 by 512 PNG of 11,676
bytes, within OpenAI's limits of 48 to 4096 pixels a side and 5 MiB.

### Test cases

Five positive and three negative cases, each in OpenAI's four fields. The
positive cases cover every tool. The negative cases' expected behaviour
is what the server answers for them (`describeError` in
`src/shell/server.ts`), except the last, which calls no tool.

#### Positive 1: rates on a date

**Description**

The official rates of two currencies on a past date. 1 March 2026 was a
Sunday, which has no rate of its own, so the answer names the day the
rate in force took effect.

**Prompt**

What were the official NBG rates for USD and EUR on 1 March 2026?

**Tools triggered**

nbg_get_rates

**Expected behaviour**

Both rates in GEL per one unit, with the date they took effect.

#### Positive 2: convert an amount

**Description**

An amount in pounds converted to lari at the official rate in force
today.

**Prompt**

Convert 1,200 GBP to GEL at today's NBG rate.

**Tools triggered**

nbg_convert

**Expected behaviour**

The amount in GEL rounded half up to the tetri, the rate and its
effective date.

#### Positive 3: convert a list

**Description**

Two invoices in different currencies, each converted at the rate in
force on its own date, with a total in GEL. 5 October 2026 was a Monday,
which has no rate of its own.

**Prompt**

Convert these invoices to GEL, each at the NBG rate of its own date: 500
USD on 2 October 2026 and 300 EUR on 5 October 2026.

**Tools triggered**

nbg_convert_many

**Expected behaviour**

Each amount at its own date's rate, and the total.

#### Positive 4: a rate's history

**Description**

A month of one currency's official rates, summarised by the server.

**Prompt**

How did the US dollar move against the lari in September 2026?

**Tools triggered**

nbg_rate_history

**Expected behaviour**

First, last, change, lowest and highest with dates, and the average.

#### Positive 5: the currencies NBG quotes

**Description**

The currencies NBG publishes a rate for, with the number of units it
quotes each in.

**Prompt**

Which currencies does the National Bank of Georgia quote?

**Tools triggered**

nbg_list_currencies

**Expected behaviour**

The codes with NBG's units (for example JPY per 100).

#### Negative 1: a date NBG has not published

**Description**

A rate for a future date, which does not exist yet. The connector
answers with an error instead of a guess.

**Prompt**

What will NBG's USD rate be next Friday?

**Tools triggered**

nbg_get_rates

**Expected behaviour**

No rate: NBG has not published it. The tool answers with an error saying
that NBG sets rates on business days around 17:00 Tbilisi time, valid
from the next calendar day, and that tomorrow is the furthest date that
can have a rate, and the answer says so instead of guessing a rate.

#### Negative 2: an unknown currency code

**Description**

A conversion from a code that is not a currency NBG quotes.

**Prompt**

Convert 100 XYZ to GEL.

**Tools triggered**

nbg_convert

**Expected behaviour**

No conversion: XYZ is not a currency NBG quotes. The tool answers with
an error saying that NBG did not quote XYZ on the requested date and
pointing to nbg_list_currencies for the codes it quotes, and the answer
suggests listing the currencies.

#### Negative 3: a commercial bank's rate

**Description**

A question about a commercial bank's own rate, which the connector does
not cover.

**Prompt**

What is TBC Bank's dollar buying rate today?

**Tools triggered**

none

**Expected behaviour**

The connector is not used for a commercial bank's rate; the answer says
it covers NBG's official rates only.

## Where the texts live

The page the listings link to is rendered from its copy in
`src/shell/site/copy-en.ts` and `src/shell/site/copy-ka.ts`, and its URLs
and operator come from `src/shell/site/hosted.ts`. The copy is in the
code, so a wording change there is a release; the privacy and terms
sections the listings link to change only with one.

The texts in this file are pasted by hand and change nothing by
themselves. When the page's privacy section changes, bring the
descriptions above in step with it and edit both listings in their
portals.
