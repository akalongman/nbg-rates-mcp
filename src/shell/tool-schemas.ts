import * as z from 'zod';

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const currencyCode = z.string().min(1).max(10);
// nbg_get_rates lists an entry that is not a three-letter code in unknownCodes as typed and answers
// the rest, so an empty entry or a currency name typed in place of its code must not reject the call.
const requestedCode = z.string().max(64);

export const languageInput = z
    .enum(['en', 'ka'])
    .describe(
        'Language of currency names: en (default) or ka (Georgian). Codes, numbers and dates are identical in both.',
    );

export const getRatesInput = z.object({
    date: calendarDate
        .optional()
        .describe(
            "Calendar date YYYY-MM-DD. Defaults to today in Tbilisi. Tomorrow's rate exists after about 17:00 Tbilisi time.",
        ),
    currencies: z
        .array(requestedCode)
        .min(1)
        .optional()
        .describe(
            'ISO 4217 codes to return, case-insensitive, duplicates ignored (for example ["USD", "EUR"]). Omit for all currencies.',
        ),
    language: languageInput.optional(),
});

export const convertInput = z.object({
    amount: z.number().finite().describe('Amount in the "from" currency. May be negative.'),
    from: currencyCode.describe('ISO 4217 code, or GEL.'),
    to: currencyCode.describe('ISO 4217 code, or GEL.'),
    date: calendarDate
        .optional()
        .describe('Calendar date YYYY-MM-DD whose official rate to apply. Defaults to today in Tbilisi.'),
});

export const listCurrenciesInput = z.object({
    language: languageInput.optional(),
});

export const rateHistoryInput = z.object({
    currency: currencyCode.describe('ISO 4217 code, for example USD.'),
    from: calendarDate.describe('First calendar day, inclusive.'),
    to: calendarDate.describe('Last calendar day, inclusive. At most 366 days including "from".'),
});

const effectiveDate = z.string().describe('Calendar date the returned rate took effect, as published by NBG');
const carriedOver = z
    .boolean()
    .describe(
        'true when the rate in force on requestedDate took effect on an earlier day; it is still the official rate',
    );

const rateEntry = z.object({
    code: z.string(),
    name: z.string(),
    rate: z.number().describe('GEL per ONE unit of the currency'),
    diff: z.number().describe('Change versus the previous published rate, per one unit'),
    nbgQuantity: z.number().describe('Units NBG quotes the raw rate for (1, 10, 100, 1000 or 10000)'),
    nbgRate: z.number().describe('Raw rate as published by NBG, for nbgQuantity units'),
});

export const getRatesOutput = z.object({
    requestedDate: z.string(),
    effectiveDate,
    carriedOver,
    rates: z.array(rateEntry),
    unknownCodes: z.array(z.string()),
});

export const convertOutput = z.object({
    amount: z.number(),
    from: z.string(),
    to: z.string(),
    result: z.number().describe('Unrounded'),
    rate: z.number().describe('One unit of "from" expressed in "to"'),
    via: z.enum(['direct', 'GEL']),
    requestedDate: z.string(),
    effectiveDate,
    carriedOver,
});

export const listCurrenciesOutput = z.object({
    effectiveDate,
    currencies: z.array(z.object({ code: z.string(), name: z.string(), nbgQuantity: z.number() })),
});

export const rateHistoryOutput = z.object({
    currency: z.string(),
    from: z.string(),
    to: z.string(),
    days: z.array(
        z.object({
            date: z.string(),
            rate: z.number().describe('GEL per ONE unit of the currency'),
            effectiveDate: z
                .string()
                .describe('Present only on carried-over days: the calendar date the rate took effect')
                .optional(),
            carriedOver: z
                .literal(true)
                .describe('Present, and true, only on days that carry a rate set earlier')
                .optional(),
        }),
    ),
});
