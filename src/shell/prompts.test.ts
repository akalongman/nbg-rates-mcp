import { describe, expect, it } from 'vitest';
import { PROMPTS, promptArgsSchema, renderPrompt, type PromptDefinition } from './prompts.js';

const PLACEHOLDER = /\$\{arguments\.([A-Za-z_]+)\}/g;

function placeholders(prompt: PromptDefinition): string[] {
    return [...prompt.text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

describe('renderPrompt', () => {
    it('replaces every placeholder with its argument', () => {
        expect(
            renderPrompt('Convert ${arguments.amount} ${arguments.from} to ${arguments.to}.', {
                amount: '1500',
                from: 'USD',
                to: 'GEL',
            }),
        ).toBe('Convert 1500 USD to GEL.');
    });

    it('renders an absent or empty optional argument as nothing, identically', () => {
        const text = 'in force on ${arguments.date} (today when no date is given)';
        expect(renderPrompt(text, {})).toBe('in force on  (today when no date is given)');
        expect(renderPrompt(text, { date: '' })).toBe('in force on  (today when no date is given)');
        expect(renderPrompt(text, { date: undefined })).toBe('in force on  (today when no date is given)');
    });

    it('inserts replacement patterns and backslashes literally', () => {
        // String.prototype.replace with a string replacement would expand $& and $1.
        expect(
            renderPrompt('Convert ${arguments.amount} ${arguments.from}', { amount: '$1,500 $& \\', from: 'USD' }),
        ).toBe('Convert $1,500 $& \\ USD');
    });
});

describe('PROMPTS', () => {
    it('defines the four prompts in menu order', () => {
        expect(PROMPTS.map((prompt) => prompt.name)).toEqual([
            'nbg_rates_today',
            'nbg_rate_on_date',
            'nbg_convert_amount',
            'nbg_monthly_rates',
        ]);
    });

    it('uses every declared argument in its text and declares every placeholder it uses', () => {
        for (const prompt of PROMPTS) {
            const declared = prompt.arguments.map((argument) => argument.name);
            expect(new Set(placeholders(prompt)), prompt.name).toEqual(new Set(declared));
        }
    });

    it('renders each text with no placeholder left when every argument is given', () => {
        for (const prompt of PROMPTS) {
            const args = Object.fromEntries(prompt.arguments.map((argument) => [argument.name, 'X']));
            expect(renderPrompt(prompt.text, args), prompt.name).not.toContain('${arguments.');
        }
    });

    it('names each tool it asks the model to call', () => {
        const tools: Record<string, string> = {
            nbg_rates_today: 'nbg_get_rates',
            nbg_rate_on_date: 'nbg_get_rates',
            nbg_convert_amount: 'nbg_convert',
            nbg_monthly_rates: 'nbg_rate_history',
        };
        for (const prompt of PROMPTS) {
            expect(prompt.text, prompt.name).toContain(tools[prompt.name] ?? 'missing');
        }
    });

    it('marks only the optional arguments optional', () => {
        const optional = PROMPTS.flatMap((prompt) =>
            prompt.arguments
                .filter((argument) => !argument.required)
                .map((argument) => `${prompt.name}.${argument.name}`),
        );
        expect(optional).toEqual(['nbg_rates_today.currencies', 'nbg_convert_amount.date']);
    });
});

describe('promptArgsSchema', () => {
    it('requires exactly the required arguments and describes each one', () => {
        const convert = PROMPTS.find((prompt) => prompt.name === 'nbg_convert_amount');
        if (convert === undefined) {
            throw new Error('nbg_convert_amount missing');
        }
        const schema = promptArgsSchema(convert);
        expect(schema.safeParse({ amount: '1500', from: 'USD', to: 'GEL' }).success).toBe(true);
        expect(schema.safeParse({ amount: '1500', from: 'USD' }).success).toBe(false);
        expect(schema.shape['date']?.description).toBe('Calendar date, YYYY-MM-DD; today when empty');
    });
});
