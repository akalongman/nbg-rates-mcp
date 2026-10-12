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
            'ISO 4217 codes to return, case-insensitive, duplicates ignored (for example ["USD", "EUR"]). Omit for all currencies. ' +
                'GEL has no row, since every rate is in GEL, so it is listed in unknownCodes.',
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

/** Loose on purpose: the shape only, so one malformed date or code costs its item and not the batch. */
const convertItemInput = z.object({
    amount: z.number().finite().describe('Amount in the "from" currency. May be negative.'),
    from: z.string().max(64).describe('ISO 4217 code, or GEL.'),
    to: z.string().max(64).describe('ISO 4217 code, or GEL.'),
    date: z
        .string()
        .max(64)
        .optional()
        .describe('Calendar date YYYY-MM-DD whose official rate to apply. Defaults to today in Tbilisi.'),
});

export const convertManyInput = z.object({
    items: z
        .array(convertItemInput)
        .min(1)
        .max(100)
        .describe('1 to 100 conversions, each with the fields of nbg_convert; items are answered independently.'),
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
    diff: z
        .number()
        .describe(
            'Change versus the previous published rate, per one unit; values below 0.000001 use exponent notation, such as 4e-7',
        ),
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
    resultRounded: z
        .number()
        .describe(
            'result rounded half up to 2 decimals from the exact value; the amount to show. ' +
                'JSON drops trailing zeros, so 3.90 arrives as 3.9. ' +
                'Exact up to about 9e13 in the target currency; above that the nearest double.',
        ),
    rate: z.number().describe('One unit of "from" expressed in "to"'),
    via: z.enum(['direct', 'GEL']),
    requestedDate: z.string(),
    effectiveDate,
    carriedOver,
});

const convertItemFailure = z.object({
    amount: z.number(),
    from: z.string(),
    to: z.string(),
    date: z.string().optional(),
    error: z.string().describe('Why this item was not converted; the same text nbg_convert would return'),
});

export const convertManyOutput = z.object({
    items: z
        .array(z.union([convertOutput, convertItemFailure]))
        .describe('One entry per input item, in input order: a conversion, or the item with an error'),
    converted: z.number().int(),
    skipped: z.number().int(),
    total: z
        .object({
            to: z.string(),
            resultRounded: z
                .number()
                .describe('Exact sum of the resultRounded values of the converted items, as a ledger posts lines'),
        })
        .optional()
        .describe(
            'Present only when at least one item converted, every converted item has the same target currency, and ' +
                'the sum is a finite number. It covers the converted items only: when skipped is not 0, say the total ' +
                'is partial and list the skipped items.',
        ),
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
                .describe(
                    'Present only on carried-over days: the calendar date the rate took effect. ' +
                        'When absent, the rate took effect on date.',
                )
                .optional(),
            carriedOver: z
                .literal(true)
                .describe('Present, and true, only on days that carry a rate set earlier')
                .optional(),
        }),
    ),
    summary: z
        .object({
            first: z.number().describe('Rate on from'),
            last: z.number().describe('Rate on to'),
            change: z.number().describe("last minus first, exact, at the decimals NBG's quantity gives the currency"),
            min: z.number(),
            minDate: z.string().describe('First calendar day the minimum occurs on'),
            max: z.number(),
            maxDate: z.string().describe('First calendar day the maximum occurs on'),
            average: z
                .number()
                .describe('Arithmetic mean over every calendar day of the range, carried-over days included'),
        })
        .describe(
            'Computed by the server; report these instead of deriving them from days. change and average are exact, ' +
                "rounded half up to the decimals NBG's quantity gives the currency, 4 + log10(nbgQuantity), the largest " +
                'over the days (4 for USD, 7 for AMD).',
        ),
});
