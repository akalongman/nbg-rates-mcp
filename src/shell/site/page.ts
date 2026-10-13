import { createHash } from 'node:crypto';
import type { Language, PageCopy } from './copy.js';
import { ISSUES_URL, MCP_URL, REPOSITORY_URL, SITE_ORIGIN } from './hosted.js';

const PRODUCT_NAME = 'NBG Rates';
const CLAUDE_CODE_COMMAND = `claude mcp add --transport http nbg-rates ${MCP_URL}`;
const OG_IMAGE_URL = `${SITE_ORIGIN}/og.png`;

const PAGE_PATHS: Readonly<Record<Language, string>> = { en: '/', ka: '/ka' };
const OG_LOCALES: Readonly<Record<Language, string>> = { en: 'en_US', ka: 'ka_GE' };
const OTHER_LANGUAGE: Readonly<Record<Language, Language>> = { en: 'ka', ka: 'en' };

/** One setup tab: its radio input is `app-<id>` and its panel `panel-<id>`, which the style selects by. */
interface AppTab {
    readonly id: string;
    readonly name: string;
    readonly steps: (setup: PageCopy['setup']) => readonly string[];
    /** Printed after the first step, before the rest. */
    readonly command?: string;
}

const APP_TABS: readonly AppTab[] = [
    { id: 'claude-ai', name: 'claude.ai', steps: (setup) => setup.claudeAi },
    { id: 'chatgpt', name: 'ChatGPT', steps: (setup) => setup.chatGpt },
    { id: 'claude-desktop', name: 'Claude Desktop', steps: (setup) => setup.claudeDesktop },
    { id: 'claude-code', name: 'Claude Code', steps: (setup) => setup.claudeCode, command: CLAUDE_CODE_COMMAND },
];

/** The rect and the path of assets/icon.svg, inline so the header requests no image. */
const ICON_SVG =
    '<svg class="logo" viewBox="0 0 512 512" aria-hidden="true">' +
    '<rect width="512" height="512" rx="96" fill="#1F3A5F"/>' +
    '<path fill="#FFFFFF" d="M167.77 335.16H222.17Q199.73 321.9 184.26 298.27Q168.79 274.64 168.79 238.94Q168.79 199.84 188.85 173.49Q208.91 147.14 245.29 138.64V100.9H268.07V135.58Q272.83 135.24 277.93 135.24Q286.43 135.24 293.91 135.92V100.9H316.69V138.98Q330.29 142.04 344.57 147.82V191Q330.97 185.56 316.69 182.16V237.58H293.91V178.76Q287.11 178.08 280.65 178.08Q274.19 178.08 268.07 179.1V237.58H245.29V187.6Q219.79 204.6 219.79 243.7Q219.79 269.2 230.5 289.94Q241.21 310.68 262.63 322.92Q284.05 335.16 315.67 335.16H347.63V378H167.77Z"/>' +
    '</svg>';

/** Selectors for every tab: the radio input in `state`, then the sibling `target` returns for its id. */
function tabSelectors(state: 'checked' | 'focus-visible', target: (id: string) => string): string {
    return APP_TABS.map(({ id }) => `#app-${id}:${state} ~ ${target(id)}`).join(',\n');
}

/** The page's one style block, the same for both languages; the policy pins it by hash. */
const PAGE_STYLE = `
:root {
    --navy: #1f3a5f;
    --navy-deep: #152a46;
    --ink: #1b2430;
    --muted: #4a586b;
    --surface: #f4f7fb;
    --line: #d8e0eb;
    --focus: #2f6fb3;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    color-scheme: light;
}
*,
*::before,
*::after {
    box-sizing: border-box;
}
[hidden] {
    display: none !important;
}
html {
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
}
body {
    margin: 0;
    background: #fff;
    color: var(--ink);
    font-family: system-ui, "Segoe UI", "Noto Sans Georgian", Sylfaen, sans-serif;
    font-size: 1rem;
    line-height: 1.55;
    overflow-wrap: break-word;
}
a {
    color: var(--navy);
    text-underline-offset: 0.15em;
}
a:hover {
    color: var(--navy-deep);
}
:focus-visible {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
}
.wrap {
    max-width: 72rem;
    margin: 0 auto;
    padding-right: 1rem;
    padding-left: 1rem;
}
.site-header {
    background: #fff;
    border-bottom: 1px solid var(--line);
}
.header-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem 1.5rem;
    padding-top: 0.875rem;
    padding-bottom: 0.875rem;
}
.brand {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
}
.logo {
    flex: none;
    width: 2.75rem;
    height: 2.75rem;
}
.brand-name {
    margin: 0;
    color: var(--navy);
    font-size: 1.25rem;
    font-weight: 700;
    line-height: 1.2;
}
.independence {
    margin: 0.125rem 0 0;
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1.35;
}
.header-links {
    display: flex;
    gap: 1.25rem;
    font-weight: 600;
}
.hero {
    padding: 2.5rem 0 3rem;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
}
.hero-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 2.5rem;
    align-items: start;
}
h1 {
    margin: 0 0 1rem;
    color: var(--navy);
    font-size: clamp(1.875rem, 1.2rem + 2.6vw, 2.875rem);
    line-height: 1.15;
}
.intro {
    max-width: 36rem;
    margin: 0;
    color: var(--muted);
    font-size: 1.125rem;
}
.url-box {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1.75rem;
}
.url {
    flex: 1 1 18rem;
    min-width: 0;
    padding: 0.75rem 0.875rem;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    color: var(--ink);
    font-family: var(--mono);
    font-size: 0.9375rem;
    overflow-wrap: anywhere;
    -webkit-user-select: all;
    user-select: all;
}
.copy-button {
    flex: none;
    padding: 0.75rem 1.25rem;
    background: var(--navy);
    border: 0;
    border-radius: 0.5rem;
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
}
.copy-button:hover {
    background: var(--navy-deep);
}
.copy-status {
    min-height: 1.5em;
    margin: 0.375rem 0 0;
    color: var(--muted);
    font-size: 0.875rem;
}
.setup {
    position: relative;
    min-width: 0;
    margin: 1.25rem 0 0;
    padding: 0;
    border: 0;
}
.setup legend {
    margin-bottom: 0.625rem;
    padding: 0;
    font-weight: 700;
}
.setup > input {
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    margin: 0;
    opacity: 0;
}
.tab-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
}
.tab-labels label {
    padding: 0.4375rem 0.9375rem;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 0.9375rem;
    font-weight: 600;
    cursor: pointer;
}
.tab-labels label:hover {
    border-color: var(--navy);
}
${tabSelectors('checked', (id) => `.tab-labels [for="app-${id}"]`)} {
    background: var(--navy);
    border-color: var(--navy);
    color: #fff;
}
${tabSelectors('focus-visible', (id) => `.tab-labels [for="app-${id}"]`)} {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
}
.panel {
    display: none;
    margin: 0.75rem 0 0;
    padding: 1rem 1.25rem 1rem 2.5rem;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 0.75rem;
}
${tabSelectors('checked', (id) => `.panel-${id}`)} {
    display: block;
}
.panel li + li {
    margin-top: 0.5rem;
}
.command {
    margin: 0.5rem 0 0;
    padding: 0.75rem 0.875rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    font-family: var(--mono);
    font-size: 0.875rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.chat {
    margin: 0;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 1rem;
    box-shadow: 0 1px 2px rgba(31, 58, 95, 0.06), 0 16px 40px rgba(31, 58, 95, 0.12);
    overflow: hidden;
}
.chat-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.875rem;
    font-weight: 600;
}
.chat-head::before {
    content: "";
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: #3c9a6a;
}
.chat-log {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 1.125rem 1rem 1.25rem;
}
.msg {
    max-width: 88%;
    margin: 0;
    padding: 0.625rem 0.875rem;
    border-radius: 1rem;
    font-size: 0.9375rem;
    line-height: 1.5;
}
.msg-user {
    align-self: flex-end;
    background: var(--navy);
    border-bottom-right-radius: 0.25rem;
    color: #fff;
}
.msg-tool {
    align-self: flex-start;
    padding: 0.25rem 0.75rem;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--muted);
    font-size: 0.8125rem;
}
.msg-bot {
    align-self: flex-start;
    background: var(--surface);
    border-bottom-left-radius: 0.25rem;
}
.msg-bot + .msg-user {
    margin-top: 0.75rem;
}
.msg.is-waiting {
    visibility: hidden;
    opacity: 0;
}
.msg.is-typing {
    position: relative;
    color: transparent;
}
.typed {
    position: absolute;
    top: 0.625rem;
    right: 0.875rem;
    left: 0.875rem;
    color: #fff;
}
.section {
    padding: 3rem 0;
}
.section + .section {
    border-top: 1px solid var(--line);
}
h2 {
    margin: 0 0 1.25rem;
    color: var(--navy);
    font-size: clamp(1.375rem, 1.1rem + 1.2vw, 1.75rem);
    line-height: 1.25;
}
.cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 12.5rem), 1fr));
    gap: 1rem;
    margin: 0;
    padding: 0;
    list-style: none;
}
.card {
    padding: 1.125rem 1.25rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 0.75rem;
}
.card h3 {
    margin: 0 0 0.5rem;
    color: var(--navy);
    font-size: 1.0625rem;
    line-height: 1.3;
}
.card p {
    margin: 0;
    color: var(--muted);
    font-size: 0.9375rem;
}
.rules {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    gap: 0.875rem 2.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
}
.rules li {
    position: relative;
    padding-left: 1.75rem;
}
.rules li::before {
    content: "";
    position: absolute;
    top: 0.5em;
    left: 0.25rem;
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    background: var(--navy);
}
.prose {
    max-width: 46rem;
}
.prose p {
    margin: 0 0 0.875rem;
}
.prose p:last-child {
    margin-bottom: 0;
}
.legal {
    background: var(--surface);
}
.site-footer {
    padding: 2rem 0 2.5rem;
    background: var(--navy);
    color: #dbe4ef;
    font-size: 0.9375rem;
}
.site-footer a {
    color: #fff;
}
.site-footer :focus-visible {
    outline-color: #fff;
}
.footer-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.5rem;
    margin: 0 0 1rem;
    padding: 0;
    list-style: none;
}
.footer-meta {
    margin: 0;
}
@media (min-width: 47.5rem) {
    .wrap {
        padding-right: 2rem;
        padding-left: 2rem;
    }
    .hero {
        padding: 3.5rem 0 4rem;
    }
    .hero-grid {
        grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
        gap: 3rem;
    }
}
@media (prefers-reduced-motion: no-preference) {
    .msg {
        transition: opacity 0.3s ease;
    }
}
`;

/**
 * The page's one script, the same for both languages; the policy pins it by hash. It reveals the copy button and,
 * unless the reader prefers reduced motion, replays the chat once when it comes into view. It writes text only
 * through textContent.
 */
const PAGE_SCRIPT = `
(function () {
    'use strict';

    const button = document.getElementById('copy-url');
    const address = document.getElementById('mcp-url');
    const status = document.getElementById('copy-status');
    let clearTimer = 0;

    function confirmCopy() {
        status.textContent = button.getAttribute('data-copied') || '';
        clearTimeout(clearTimer);
        clearTimer = setTimeout(function () {
            status.textContent = '';
        }, 4000);
    }

    function selectAddress() {
        const selection = window.getSelection();
        if (!selection) {
            return;
        }
        const range = document.createRange();
        range.selectNodeContents(address);
        selection.removeAllRanges();
        selection.addRange(range);
        let copied = false;
        try {
            copied = document.execCommand('copy');
        } catch (error) {
            copied = false;
        }
        if (copied) {
            confirmCopy();
        }
    }

    if (button && address && status) {
        button.hidden = false;
        button.addEventListener('click', function () {
            const clipboard = navigator.clipboard;
            if (!clipboard || typeof clipboard.writeText !== 'function') {
                selectAddress();
                return;
            }
            try {
                clipboard.writeText(address.textContent || '').then(confirmCopy, selectAddress);
            } catch (error) {
                selectAddress();
            }
        });
    }

    const log = document.getElementById('chat-log');
    const reduceMotion = !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!log || reduceMotion) {
        return;
    }
    const messages = Array.from(log.querySelectorAll('.msg'));

    function typeQuestion(message, done) {
        const characters = Array.from(message.textContent || '');
        const typed = document.createElement('span');
        typed.className = 'typed';
        typed.setAttribute('aria-hidden', 'true');
        message.classList.add('is-typing');
        message.appendChild(typed);
        let count = 0;
        const timer = setInterval(function () {
            count += 1;
            typed.textContent = characters.slice(0, count).join('');
            if (count >= characters.length) {
                clearInterval(timer);
                typed.remove();
                message.classList.remove('is-typing');
                done();
            }
        }, 32);
    }

    function reveal(index) {
        const message = messages[index];
        if (!message) {
            return;
        }
        message.classList.remove('is-waiting');
        function next() {
            reveal(index + 1);
        }
        if (message.classList.contains('msg-user')) {
            typeQuestion(message, function () {
                setTimeout(next, 500);
            });
        } else {
            setTimeout(next, message.classList.contains('msg-tool') ? 900 : 1600);
        }
    }

    messages.forEach(function (message) {
        message.classList.add('is-waiting');
    });
    if (!('IntersectionObserver' in window)) {
        reveal(0);
        return;
    }
    const observer = new IntersectionObserver(
        function (entries) {
            if (entries.some(function (entry) { return entry.isIntersecting; })) {
                observer.disconnect();
                reveal(0);
            }
        },
        { threshold: 0.35 },
    );
    observer.observe(log);
})();
`;

function hashSource(text: string): string {
    return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** Allows nothing from another origin and nothing inline but the page's own style and script. */
export const PAGE_CONTENT_SECURITY_POLICY: string = [
    "default-src 'none'",
    "img-src 'self'",
    `style-src ${hashSource(PAGE_STYLE)}`,
    `script-src ${hashSource(PAGE_SCRIPT)}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

const HTML_ESCAPES: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/** Escapes text for an element's content or a quoted attribute value. */
export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function pageUrl(language: Language): string {
    return `${SITE_ORIGIN}${PAGE_PATHS[language]}`;
}

function languageLink(copy: PageCopy): string {
    const other = OTHER_LANGUAGE[copy.language];
    return `<a href="${PAGE_PATHS[other]}" hreflang="${other}" lang="${other}">${escapeHtml(copy.otherLanguage)}</a>`;
}

function renderHead(copy: PageCopy): string {
    const title = escapeHtml(copy.title);
    const description = escapeHtml(copy.description);
    const imageAlt = escapeHtml(copy.ogImageAlt);
    const canonical = pageUrl(copy.language);
    return [
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="theme-color" content="#1F3A5F">',
        `<title>${title}</title>`,
        `<meta name="description" content="${description}">`,
        `<link rel="alternate" hreflang="en" href="${pageUrl('en')}">`,
        `<link rel="alternate" hreflang="ka" href="${pageUrl('ka')}">`,
        `<link rel="alternate" hreflang="x-default" href="${pageUrl('en')}">`,
        `<link rel="canonical" href="${canonical}">`,
        '<link rel="icon" href="/favicon.ico" sizes="any">',
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
        '<meta property="og:type" content="website">',
        `<meta property="og:site_name" content="${PRODUCT_NAME}">`,
        `<meta property="og:title" content="${title}">`,
        `<meta property="og:description" content="${description}">`,
        `<meta property="og:url" content="${canonical}">`,
        `<meta property="og:locale" content="${OG_LOCALES[copy.language]}">`,
        `<meta property="og:image" content="${OG_IMAGE_URL}">`,
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        `<meta property="og:image:alt" content="${imageAlt}">`,
        '<meta name="twitter:card" content="summary_large_image">',
        `<meta name="twitter:title" content="${title}">`,
        `<meta name="twitter:description" content="${description}">`,
        `<meta name="twitter:image" content="${OG_IMAGE_URL}">`,
        `<meta name="twitter:image:alt" content="${imageAlt}">`,
        `<style>${PAGE_STYLE}</style>`,
        '</head>',
    ].join('\n');
}

function renderHeader(copy: PageCopy): string {
    return [
        '<header class="site-header">',
        '<div class="wrap header-row">',
        '<div class="brand">',
        ICON_SVG,
        '<div>',
        `<p class="brand-name">${PRODUCT_NAME}</p>`,
        `<p class="independence">${escapeHtml(copy.independence)}</p>`,
        '</div>',
        '</div>',
        '<div class="header-links">',
        languageLink(copy),
        `<a href="${REPOSITORY_URL}">${escapeHtml(copy.footer.source)}</a>`,
        '</div>',
        '</div>',
        '</header>',
    ].join('\n');
}

function renderPanel(tab: AppTab, copy: PageCopy): string {
    const steps = tab.steps(copy.setup).map((step, index) => {
        const command =
            index === 0 && tab.command !== undefined
                ? `<pre class="command"><code>${escapeHtml(tab.command)}</code></pre>`
                : '';
        return `<li>${escapeHtml(step)}${command}</li>`;
    });
    return [`<ol class="panel panel-${tab.id}">`, ...steps, '</ol>'].join('\n');
}

function renderSetup(copy: PageCopy): string {
    return [
        '<fieldset class="setup">',
        `<legend>${escapeHtml(copy.setupLabel)}</legend>`,
        ...APP_TABS.map(
            ({ id }, index) => `<input type="radio" name="app" id="app-${id}"${index === 0 ? ' checked' : ''}>`,
        ),
        '<div class="tab-labels">',
        ...APP_TABS.map(({ id, name }) => `<label for="app-${id}">${escapeHtml(name)}</label>`),
        '</div>',
        ...APP_TABS.map((tab) => renderPanel(tab, copy)),
        '</fieldset>',
    ].join('\n');
}

function renderChat(copy: PageCopy): string {
    return [
        '<figure class="chat">',
        `<figcaption class="chat-head">${escapeHtml(copy.chatLabel)}</figcaption>`,
        '<div class="chat-log" id="chat-log">',
        ...copy.chat.flatMap(({ question, toolLine, answer }) => [
            `<p class="msg msg-user">${escapeHtml(question)}</p>`,
            `<p class="msg msg-tool">${escapeHtml(toolLine)}</p>`,
            `<p class="msg msg-bot">${escapeHtml(answer)}</p>`,
        ]),
        '</div>',
        '</figure>',
    ].join('\n');
}

function renderHero(copy: PageCopy): string {
    return [
        '<section class="hero">',
        '<div class="wrap hero-grid">',
        '<div>',
        `<h1>${escapeHtml(copy.headline)}</h1>`,
        `<p class="intro">${escapeHtml(copy.intro)}</p>`,
        '<div class="url-box">',
        `<code class="url" id="mcp-url">${MCP_URL}</code>`,
        `<button type="button" class="copy-button" id="copy-url" hidden data-copied="${escapeHtml(copy.copied)}">` +
            `${escapeHtml(copy.copyButton)}</button>`,
        '</div>',
        '<p class="copy-status" id="copy-status" aria-live="polite"></p>',
        renderSetup(copy),
        '</div>',
        renderChat(copy),
        '</div>',
        '</section>',
    ].join('\n');
}

function renderAsk(copy: PageCopy): string {
    return [
        '<section class="section">',
        '<div class="wrap">',
        `<h2>${escapeHtml(copy.askHeading)}</h2>`,
        '<ul class="cards">',
        ...copy.cards.map(
            ({ title, example }) => `<li class="card"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(example)}</p></li>`,
        ),
        '</ul>',
        '</div>',
        '</section>',
    ].join('\n');
}

function renderRules(copy: PageCopy): string {
    return [
        '<section class="section">',
        '<div class="wrap">',
        `<h2>${escapeHtml(copy.rulesHeading)}</h2>`,
        '<ul class="rules">',
        ...copy.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`),
        '</ul>',
        '</div>',
        '</section>',
    ].join('\n');
}

function renderSelfHost(copy: PageCopy): string {
    return [
        '<section class="section">',
        '<div class="wrap">',
        '<div class="prose">',
        `<h2>${escapeHtml(copy.selfHostHeading)}</h2>`,
        `<p>${escapeHtml(copy.selfHost)}</p>`,
        `<p><a href="${REPOSITORY_URL}#install">${escapeHtml(copy.selfHostLink)}</a></p>`,
        '</div>',
        '</div>',
        '</section>',
    ].join('\n');
}

function renderLegal(id: 'privacy' | 'terms', heading: string, paragraphs: readonly string[]): string {
    return [
        `<section class="section legal" id="${id}">`,
        '<div class="wrap">',
        '<div class="prose">',
        `<h2>${escapeHtml(heading)}</h2>`,
        ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
        '</div>',
        '</div>',
        '</section>',
    ].join('\n');
}

function renderFooter(copy: PageCopy, version: string): string {
    const links = [
        `<a href="#privacy">${escapeHtml(copy.footer.privacy)}</a>`,
        `<a href="#terms">${escapeHtml(copy.footer.terms)}</a>`,
        `<a href="${ISSUES_URL}">${escapeHtml(copy.footer.support)}</a>`,
        `<a href="${REPOSITORY_URL}">${escapeHtml(copy.footer.source)}</a>`,
        languageLink(copy),
    ];
    return [
        '<footer class="site-footer">',
        '<div class="wrap">',
        '<nav>',
        '<ul class="footer-links">',
        ...links.map((link) => `<li>${link}</li>`),
        '</ul>',
        '</nav>',
        `<p class="footer-meta">${escapeHtml(copy.footer.operatedBy)}</p>`,
        `<p class="footer-meta">nbg-rates-mcp ${escapeHtml(version)}</p>`,
        '</div>',
        '</footer>',
    ].join('\n');
}

/** The whole page in one language: pure, so the host renders each language once when it starts. */
export function renderPage(copy: PageCopy, version: string): string {
    return [
        '<!doctype html>',
        `<html lang="${copy.language}">`,
        renderHead(copy),
        '<body>',
        renderHeader(copy),
        '<main>',
        renderHero(copy),
        renderAsk(copy),
        renderRules(copy),
        renderSelfHost(copy),
        renderLegal('privacy', copy.privacyHeading, copy.privacy),
        renderLegal('terms', copy.termsHeading, copy.terms),
        '</main>',
        renderFooter(copy, version),
        `<script>${PAGE_SCRIPT}</script>`,
        '</body>',
        '</html>',
        '',
    ].join('\n');
}
