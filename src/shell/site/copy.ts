/** The page's text in one language. The template owns the markup, the URLs and the product names. */
export type Language = 'en' | 'ka';

export interface ChatExchange {
    readonly question: string;
    /** The line naming the tool the assistant used, for example "Using NBG Rates: Convert via NBG rate". */
    readonly toolLine: string;
    readonly answer: string;
}

export interface ToolCard {
    readonly title: string;
    readonly example: string;
}

export interface PageCopy {
    readonly language: Language;
    /** The `<title>`, og:title and twitter:title. */
    readonly title: string;
    /** The meta description, og:description and twitter:description. */
    readonly description: string;
    readonly ogImageAlt: string;
    /** The label of the link to the other language: "ქართული" on the English page, "English" on the Georgian. */
    readonly otherLanguage: string;
    /** "Independent project. Not affiliated with the National Bank of Georgia." */
    readonly independence: string;
    readonly headline: string;
    readonly intro: string;
    readonly copyButton: string;
    /** Shown after a copy; the script reads it from a data attribute, so the script is the same for both pages. */
    readonly copied: string;
    readonly setupLabel: string;
    readonly setup: {
        readonly claudeAi: readonly string[];
        readonly chatGpt: readonly string[];
        readonly claudeDesktop: readonly string[];
        /** Steps around the `claude mcp add` command, which the template prints after them. */
        readonly claudeCode: readonly string[];
    };
    /** The chat window's label: an AI assistant, never Claude or ChatGPT. */
    readonly chatLabel: string;
    readonly chat: readonly [ChatExchange, ChatExchange];
    readonly askHeading: string;
    readonly cards: readonly [ToolCard, ToolCard, ToolCard, ToolCard, ToolCard];
    readonly rulesHeading: string;
    readonly rules: readonly [string, string, string, string];
    readonly selfHostHeading: string;
    readonly selfHost: string;
    readonly selfHostLink: string;
    readonly privacyHeading: string;
    readonly privacy: readonly string[];
    readonly termsHeading: string;
    readonly terms: readonly string[];
    readonly footer: {
        readonly privacy: string;
        readonly terms: string;
        readonly support: string;
        readonly source: string;
        /** Names the operator; contains OPERATOR in Latin letters on both pages. */
        readonly operatedBy: string;
    };
}
