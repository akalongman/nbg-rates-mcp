import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { COPY_EN } from './copy-en.js';
import { COPY_KA } from './copy-ka.js';
import type { PageCopy } from './copy.js';
import { PAGE_CONTENT_SECURITY_POLICY, escapeHtml, renderPage } from './page.js';

interface PageCase {
    readonly copy: PageCopy;
    readonly canonical: string;
    readonly locale: string;
}

const PAGES: readonly PageCase[] = [
    { copy: COPY_EN, canonical: 'https://nbg-rates.env.ge/', locale: 'en_US' },
    { copy: COPY_KA, canonical: 'https://nbg-rates.env.ge/ka', locale: 'ka_GE' },
];

function blocks(html: string, tag: 'style' | 'script'): string[] {
    return [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => match[1] ?? '');
}

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('base64');
}

describe('escapeHtml', () => {
    it('escapes the five characters that matter in text and attributes', () => {
        expect(escapeHtml(`<a & "b" 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &#39;c&#39;&gt;');
    });
});

describe.each(PAGES)('the $copy.language page', ({ copy, canonical, locale }) => {
    const html = renderPage(copy, '9.9.9-test');

    it('declares UTF-8 first, its language, title and description', () => {
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain(`<html lang="${copy.language}">`);
        expect(html.indexOf('<meta charset="utf-8">')).toBeGreaterThan(0);
        expect(html.indexOf('<meta charset="utf-8">')).toBeLessThan(200);
        expect(html).toContain(`<title>${escapeHtml(copy.title)}</title>`);
        expect(html).toContain(`<meta name="description" content="${escapeHtml(copy.description)}">`);
    });

    it('links both languages, x-default and its canonical URL', () => {
        expect(html).toContain('<link rel="alternate" hreflang="en" href="https://nbg-rates.env.ge/">');
        expect(html).toContain('<link rel="alternate" hreflang="ka" href="https://nbg-rates.env.ge/ka">');
        expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://nbg-rates.env.ge/">');
        expect(html).toContain(`<link rel="canonical" href="${canonical}">`);
    });

    it('carries the share card tags with absolute URLs', () => {
        expect(html).toContain('<meta property="og:image" content="https://nbg-rates.env.ge/og.png">');
        expect(html).toContain('<meta property="og:image:width" content="1200">');
        expect(html).toContain('<meta property="og:image:height" content="630">');
        expect(html).toContain(`<meta property="og:url" content="${canonical}">`);
        expect(html).toContain(`<meta property="og:locale" content="${locale}">`);
        expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    });

    it('has the privacy and terms anchors, the URL, the operator, the support link and the version', () => {
        expect(html).toContain('id="privacy"');
        expect(html).toContain('id="terms"');
        expect(html).toContain('https://nbg-rates.env.ge/mcp');
        expect(html).toContain('Avtandil Kikabidze');
        expect(html).toContain('https://github.com/akalongman/nbg-rates-mcp/issues');
        expect(html).toContain(escapeHtml(copy.independence));
        expect(html).toContain('nbg-rates-mcp 9.9.9-test');
    });

    it('shows the four apps, the Claude Code command and both chat exchanges', () => {
        for (const app of ['claude.ai', 'ChatGPT', 'Claude Desktop', 'Claude Code']) {
            expect(html).toContain(app);
        }
        expect(html).toContain('claude mcp add --transport http nbg-rates https://nbg-rates.env.ge/mcp');
        for (const exchange of copy.chat) {
            expect(html).toContain(escapeHtml(exchange.question));
            expect(html).toContain(escapeHtml(exchange.answer));
        }
        expect(html.match(/<input type="radio" name="app"/g)).toHaveLength(4);
        expect(html).toMatch(/<input type="radio" name="app"[^>]*checked/);
    });

    it('loads nothing from another origin', () => {
        for (const [, value] of html.matchAll(/\ssrc="([^"]*)"/g)) {
            expect(value).toMatch(/^\/(?!\/)/);
        }
        for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
            if (!/rel="(canonical|alternate)"/.test(tag)) {
                expect(tag).toMatch(/href="\/(?!\/)/);
            }
        }
        expect(html).not.toMatch(/url\(|@import|<iframe|<object|<embed/i);
    });

    it('has no style attribute or inline event handler, which its policy would block', () => {
        expect(html).not.toMatch(/\sstyle=/i);
        expect(html).not.toMatch(/\son[a-z]+=/i);
    });

    it('pins its one style block and one script block by hash', () => {
        const [style, ...moreStyles] = blocks(html, 'style');
        const [script, ...moreScripts] = blocks(html, 'script');
        expect(moreStyles).toEqual([]);
        expect(moreScripts).toEqual([]);
        expect(PAGE_CONTENT_SECURITY_POLICY).toBe(
            `default-src 'none'; img-src 'self'; style-src 'sha256-${sha256(style ?? '')}'; ` +
                `script-src 'sha256-${sha256(script ?? '')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
    });
});

describe('the English copy', () => {
    it('quotes the demo figures', () => {
        expect(COPY_EN.chat[0].answer).toContain('6,376.13');
        expect(COPY_EN.chat[0].answer).toContain('2.6025');
        expect(COPY_EN.chat[1].answer).toContain('2.9257');
    });
});

describe('the Georgian copy', () => {
    it('writes the demo figures the Georgian way', () => {
        const amount = new Intl.NumberFormat('ka-GE', { minimumFractionDigits: 2 }).format(6376.13);
        const rate = new Intl.NumberFormat('ka-GE', { minimumFractionDigits: 4 }).format(2.6025);
        const euro = new Intl.NumberFormat('ka-GE', { minimumFractionDigits: 4 }).format(2.9257);
        expect(COPY_KA.chat[0].answer).toContain(amount);
        expect(COPY_KA.chat[0].answer).toContain(rate);
        expect(COPY_KA.chat[1].answer).toContain(euro);
    });

    it('links back to English and names the operator in Latin letters too', () => {
        expect(COPY_KA.otherLanguage).toBe('English');
        expect(COPY_KA.footer.operatedBy).toContain('Avtandil Kikabidze');
    });
});
