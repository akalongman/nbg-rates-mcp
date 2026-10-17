import type { PageCopy } from './copy.js';
import { OPERATOR, SITE_HOST } from './hosted.js';

const SELF_HOST_HEADING = 'Prefer to run it yourself?';

export const COPY_EN: PageCopy = {
    language: 'en',
    title: 'NBG Rates (independent): official lari exchange rates in Claude and ChatGPT',
    description:
        'Official National Bank of Georgia (NBG) lari rates in Claude and ChatGPT, from an independent project not ' +
        'affiliated with the bank: any date, exact conversions, free, no account.',
    ogImageAlt:
        'The NBG Rates icon, a white lari sign on navy, beside the headline “Official NBG exchange rates, inside ' +
        `Claude and ChatGPT” and the address ${SITE_HOST}/mcp.`,
    otherLanguage: 'ქართული',
    independence: 'Independent project. Not affiliated with the National Bank of Georgia.',
    headline: 'Official NBG exchange rates, inside Claude and ChatGPT',
    intro:
        'Ask in plain words for the lari rate on any date, convert an amount or a list of invoices, or see how a ' +
        'currency moved. Free, no account, no key.',
    copyButton: 'Copy',
    copied: 'URL copied.',
    setupLabel: 'Add it to your app',
    setup: {
        claudeAi: [
            'On claude.ai, open Customize, then Connectors.',
            'Click “+ Add”, then “Add custom connector”.',
            'Paste the URL above and finish with “Add”.',
            'The connector then also appears in the Claude mobile apps and in Claude Desktop under the same account.',
            'On a Team or Enterprise plan, an owner adds it under Organization settings, then Connectors.',
        ],
        chatGpt: [
            'Open chatgpt.com/plugins.',
            'Select the plus button, then “Add custom MCP server”.',
            'Enter a name, “NBG Rates”, and a short description, and under Connection paste the URL above.',
            'Leave authentication off, review the risk warning and select “I understand and want to continue”, ' +
                'then “Create as a plugin”.',
            'Install the plugin, start a new chat, type @ and pick NBG Rates.',
            'Account and workspace policies apply: in a workspace, an admin may need to allow custom MCP servers first.',
        ],
        claudeDesktop: [
            'Add the connector once on claude.ai, as the claude.ai tab shows.',
            'It then appears in Claude Desktop and the Claude mobile apps under the same account, ' +
                'with nothing to install.',
            `To run it on your computer instead, see “${SELF_HOST_HEADING}” below.`,
        ],
        claudeCode: ['Run this in a terminal:', 'Start a new session and ask about a rate.'],
    },
    chatLabel: 'AI assistant',
    chat: [
        {
            question: 'How much is 2,450 USD in GEL at the NBG rate on 7 October 2026?',
            toolLine: 'Using NBG Rates: Convert via NBG rate',
            answer: '2,450 USD is 6,376.13 GEL, at the official NBG rate of 2.6025 GEL per dollar in force on 7 October 2026.',
        },
        {
            question: 'What was the EUR rate on Sunday 4 October 2026?',
            toolLine: 'Using NBG Rates: NBG rates for a date',
            answer:
                'Sunday has no rate of its own, so the rate in force on 4 October 2026 is 2.9257 GEL per euro, set by ' +
                'NBG on Friday 2 October and in force from Saturday 3 October.',
        },
    ],
    askHeading: 'What you can ask',
    cards: [
        { title: 'Rates on a date', example: 'What were the USD and EUR rates on 1 March 2026?' },
        {
            title: 'Convert an amount',
            example: 'Convert 1,200 GBP to GEL at today’s rate. The result is rounded half up to the tetri.',
        },
        {
            title: 'Convert a list',
            example: 'Convert these invoices to GEL, each at the rate of its own date, and give me the total.',
        },
        {
            title: 'A rate’s history',
            example:
                'How did the USD rate move in September 2026? Up to a year at a time, with the low, high, change and ' +
                'average.',
        },
        {
            title: 'Currencies NBG quotes',
            example: 'Which currencies does NBG quote, and per how many units? JPY, for one, is quoted per 100.',
        },
    ],
    rulesHeading: 'Gets the details right',
    rules: [
        'Straight from NBG: the official rates, exactly as nbg.gov.ge shows them.',
        'Calendar days in Tbilisi. A Sunday, a Monday or the day after a public holiday keeps the last rate set, and ' +
            'the answer says which day’s rate applies.',
        'A date NBG has not published yet is an error, never a guess.',
        'Per-unit rates beside NBG’s quoted form: 1.6452 GEL per 100 JPY is 0.016452 GEL per yen.',
    ],
    selfHostHeading: SELF_HOST_HEADING,
    selfHost:
        'Install the Claude Desktop extension, or the npm package for Claude Code, Cursor and other MCP clients. ' +
        'Rate lookups then go from your computer straight to NBG, without passing through this hosted copy.',
    selfHostLink: 'Installation instructions on GitHub',
    privacyHeading: 'Privacy',
    privacy: [
        'The connector needs no account and never records the amounts or currencies you ask about. For a past date ' +
            'it keeps a copy of NBG’s table the first time anyone asks; the copy does not say who asked or when.',
        'It keeps two logs for 30 days: which tool was called from which client and whether NBG answered, and the ' +
            'gateway’s access log, with the time, path, status, and the caller’s IP address and user agent. For ' +
            'claude.ai and ChatGPT, the caller is Anthropic’s or OpenAI’s server.',
        'The logs are used only to keep the service running, to see which clients use it and to investigate errors ' +
            'or abuse; they are not sold, shared or used for advertising.',
        'This page sets no cookies and loads nothing from anyone else. Opening it is logged like any other request.',
        `The connector and this page are operated by ${OPERATOR}, on AWS. Questions go to the Support link below.`,
    ],
    termsHeading: 'Terms',
    terms: [
        'The connector and this page are free to use and provided as is, without warranty of any kind.',
        'Rates are the National Bank of Georgia’s published rates. Anyone who needs a rate for an official or ' +
            'legal purpose should check it on nbg.gov.ge.',
        'The service may change, be limited or stop at any time.',
        'This is an independent project, not affiliated with the National Bank of Georgia.',
    ],
    footer: {
        privacy: 'Privacy',
        terms: 'Terms',
        support: 'Support',
        source: 'GitHub',
        operatedBy: `Operated by ${OPERATOR}`,
    },
};
