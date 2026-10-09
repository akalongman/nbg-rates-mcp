import * as z from 'zod';

export interface PromptArgument {
    readonly name: string;
    readonly description: string;
    readonly required: boolean;
}

export interface PromptDefinition {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly arguments: ReadonlyArray<PromptArgument>;
    /** The user message, with `${arguments.<name>}` placeholders; manifest.json lists the same text verbatim. */
    readonly text: string;
}

/**
 * Ready-made questions a client such as Claude Desktop shows in its prompt menu. Each text handles an empty
 * optional argument in words, so the server and the manifest copy (which cannot run code) behave the same.
 */
export const PROMPTS: ReadonlyArray<PromptDefinition> = [
    {
        name: 'nbg_rates_today',
        title: "Today's NBG rates",
        description: "Today's official NBG rates of the lari for a few currencies",
        arguments: [
            {
                name: 'currencies',
                description: 'Comma-separated ISO codes; USD, EUR and GBP when empty',
                required: false,
            },
        ],
        text:
            "Give me today's official National Bank of Georgia rates for ${arguments.currencies} (USD, EUR and GBP when " +
            'none are named) with nbg_get_rates. For each currency report the rate in GEL per one unit and the change ' +
            'versus the previous rate, then the date the rates took effect and whether they are carried over from an ' +
            'earlier day.',
    },
    {
        name: 'nbg_rate_on_date',
        title: 'Rate on a date',
        description: 'The official NBG rate of one currency in force on a date',
        arguments: [
            { name: 'currency', description: 'ISO code such as USD', required: true },
            { name: 'date', description: 'Calendar date, YYYY-MM-DD', required: true },
        ],
        text:
            'What was the official National Bank of Georgia rate of ${arguments.currency} in force on ' +
            '${arguments.date}? Use nbg_get_rates. Report the rate in GEL per one unit, the date it took effect, and ' +
            'whether it is carried over from an earlier day.',
    },
    {
        name: 'nbg_convert_amount',
        title: 'Convert an amount',
        description: 'Convert an amount at the official NBG rate in force on a date',
        arguments: [
            { name: 'amount', description: 'Number in the from currency', required: true },
            { name: 'from', description: 'ISO code or GEL', required: true },
            { name: 'to', description: 'ISO code or GEL', required: true },
            { name: 'date', description: 'Calendar date, YYYY-MM-DD; today when empty', required: false },
        ],
        text:
            'Convert ${arguments.amount} ${arguments.from} to ${arguments.to} at the official National Bank of Georgia ' +
            'rate in force on ${arguments.date} (today when no date is given) with nbg_convert. Show the rate used, ' +
            'the date it took effect, whether it is carried over, and the result rounded to 2 decimal places.',
    },
    {
        name: 'nbg_monthly_rates',
        title: 'Rates table for a month',
        description: 'The official NBG rate of one currency for every day of a month, as a table',
        arguments: [
            { name: 'currency', description: 'ISO code such as EUR', required: true },
            { name: 'month', description: 'Month, YYYY-MM', required: true },
        ],
        text:
            'Using nbg_rate_history from the first to the last day of ${arguments.month}, give me a table of the ' +
            'official National Bank of Georgia rate of ${arguments.currency} for every day of the month, in GEL per ' +
            'one unit, marking the days whose rate is carried over from an earlier day. Below the table give the ' +
            'first, last, lowest and highest rate of the month.',
    },
];

const PLACEHOLDER = /\$\{arguments\.([A-Za-z_]+)\}/g;

/** Replaces each placeholder with its argument, or with nothing when the argument is absent or empty. */
export function renderPrompt(text: string, args: Readonly<Record<string, string | undefined>>): string {
    // A replacer function inserts the value as is; a replacement string would expand $& and $1 in it.
    return text.replace(PLACEHOLDER, (_match, name: string) => args[name] ?? '');
}

/** The zod schema the SDK advertises as the prompt's arguments: every argument a string, optional ones optional. */
export function promptArgsSchema(
    prompt: PromptDefinition,
): z.ZodObject<Record<string, z.ZodString | z.ZodOptional<z.ZodString>>> {
    const shape: Record<string, z.ZodString | z.ZodOptional<z.ZodString>> = {};
    for (const argument of prompt.arguments) {
        // Describe last: zod 4 keeps a description on the instance it is set on, and .optional() returns a new one.
        shape[argument.name] = argument.required
            ? z.string().describe(argument.description)
            : z.string().optional().describe(argument.description);
    }
    return z.object(shape);
}
