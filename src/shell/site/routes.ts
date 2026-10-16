import { APPLE_TOUCH_ICON_PNG_BASE64, FAVICON_ICO_BASE64, ICON_PNG_BASE64, OG_PNG_BASE64 } from './assets.generated.js';
import { COPY_EN } from './copy-en.js';
import { COPY_KA } from './copy-ka.js';
import { SITE_HOST } from './hosted.js';
import { PAGE_CONTENT_SECURITY_POLICY, renderPage } from './page.js';

/**
 * Decides the answers of the site paths: the landing page in English and Georgian on the hosted host only, the icons,
 * the share card and robots.txt on every host, OpenAI's domain challenge once a token is set, and on the hosted host a
 * redirect to the landing page for a browser that opens /mcp (the address the share card prints). Everything is
 * rendered or decoded once, when the responder is created, so a request only wraps prepared bytes in a Response.
 */

export interface SiteOptions {
    readonly version: string;
    /** Served at /.well-known/openai-apps-challenge; empty leaves that path to the caller. */
    readonly openAiChallenge: string;
}

interface SiteFile {
    readonly body: Uint8Array;
    readonly headers: Readonly<Record<string, string>>;
}

const TEXT_PLAIN = 'text/plain; charset=utf-8';
const PAGE_CACHE = 'public, max-age=300';
const ASSET_CACHE = 'public, max-age=86400';
const ROBOTS_TXT = 'User-agent: *\nDisallow: /mcp\n';
const CHALLENGE_PATH = '/.well-known/openai-apps-challenge';
const CHALLENGE_HEADERS: Readonly<Record<string, string>> = { 'content-type': TEXT_PLAIN, 'cache-control': 'no-store' };
const ALLOWED_METHODS = 'GET, HEAD';

/** On every answer of the responder, the 405 and the redirect included. */
const COMMON_HEADERS: Readonly<Record<string, string>> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
};

const ENDPOINT_PATHS: ReadonlySet<string> = new Set(['/mcp', '/mcp/']);
/** A 302, never a permanent one: browsers cache those indefinitely, and /mcp may later get a page of its own. */
const REDIRECT_HEADERS: Readonly<Record<string, string>> = {
    location: '/',
    'cache-control': 'no-store',
    ...COMMON_HEADERS,
};

function file(body: Uint8Array | string, headers: Readonly<Record<string, string>>): SiteFile {
    return {
        body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
        headers: { ...headers, ...COMMON_HEADERS },
    };
}

function page(html: string): SiteFile {
    return file(html, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': PAGE_CONTENT_SECURITY_POLICY,
        'cache-control': PAGE_CACHE,
    });
}

function asset(base64: string, contentType: string): SiteFile {
    return file(new Uint8Array(Buffer.from(base64, 'base64')), {
        'content-type': contentType,
        'cache-control': ASSET_CACHE,
    });
}

function methodNotAllowed(): Response {
    return new Response('Method not allowed.', {
        status: 405,
        headers: { allow: ALLOWED_METHODS, 'content-type': TEXT_PLAIN, ...COMMON_HEADERS },
    });
}

/**
 * A browser asks for text/html; an MCP client posts its messages and opens a stream with a GET that asks for
 * text/event-stream. So a GET or HEAD that names the first and not the second is taken for a browser, and one with no
 * Accept at all is not.
 */
function isBrowserRequest(method: string, accept: string | null): boolean {
    if ((method !== 'GET' && method !== 'HEAD') || accept === null) {
        return false;
    }
    const types = accept.toLowerCase();
    return types.includes('text/html') && !types.includes('text/event-stream');
}

/**
 * Returns the answer for a site path, or undefined when the path is not one here (the caller goes on to its own
 * routes). A browser that opens /mcp on the hosted host gets a temporary redirect to the landing page; every other
 * request to /mcp is left to the caller's MCP routing. A Response body reads once, so every call builds a fresh
 * Response around the prepared bytes.
 */
export function createSiteResponder(
    options: SiteOptions,
): (method: string, url: URL, accept: string | null) => Response | undefined {
    const english = page(renderPage(COPY_EN, options.version));
    const georgian = page(renderPage(COPY_KA, options.version));
    const pages: ReadonlyMap<string, SiteFile> = new Map([
        ['/', english],
        ['/ka', georgian],
        ['/ka/', georgian],
    ]);
    const challenge: ReadonlyArray<readonly [string, SiteFile]> =
        options.openAiChallenge === '' ? [] : [[CHALLENGE_PATH, file(options.openAiChallenge, CHALLENGE_HEADERS)]];
    const files: ReadonlyMap<string, SiteFile> = new Map([
        ['/favicon.ico', asset(FAVICON_ICO_BASE64, 'image/x-icon')],
        ['/icon.png', asset(ICON_PNG_BASE64, 'image/png')],
        ['/apple-touch-icon.png', asset(APPLE_TOUCH_ICON_PNG_BASE64, 'image/png')],
        ['/og.png', asset(OG_PNG_BASE64, 'image/png')],
        ['/robots.txt', file(ROBOTS_TXT, { 'content-type': TEXT_PLAIN, 'cache-control': ASSET_CACHE })],
        ...challenge,
    ]);

    return function respond(method: string, url: URL, accept: string | null): Response | undefined {
        // The page names the maintainer and describes the hosted copy's logs, so any other host keeps its own / and
        // has no page to send a browser at /mcp to.
        const onSiteHost = url.hostname.toLowerCase() === SITE_HOST;
        if (onSiteHost && ENDPOINT_PATHS.has(url.pathname) && isBrowserRequest(method, accept)) {
            return new Response(null, { status: 302, headers: REDIRECT_HEADERS });
        }
        const answer = (onSiteHost ? pages.get(url.pathname) : undefined) ?? files.get(url.pathname);
        if (answer === undefined) {
            return undefined;
        }
        if (method !== 'GET' && method !== 'HEAD') {
            return methodNotAllowed();
        }
        return new Response(method === 'HEAD' ? null : answer.body, { status: 200, headers: answer.headers });
    };
}
