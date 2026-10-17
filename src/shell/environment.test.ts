import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failingNbg } from '../../test/helpers/failing-nbg.js';
import { createMemoryMirrorStore, seedMirror, type MemoryMirrorStore } from '../../test/helpers/memory-mirror-store.js';
import { publication, tableFixture } from '../../test/helpers/publications.js';
import { date } from '../../test/helpers/values.js';
import { snapshotFromDay } from '../core/normalize.js';
import {
    createServiceFromEnvironment,
    mirrorTableFromEnvironment,
    readPackageVersion,
    SHORT_ATTEMPT_TIMEOUT_MS,
} from './environment.js';
import { createLookupScopes } from './lookup-scope.js';

/** 10:00 in Tbilisi (UTC+4) on Thursday 2026-10-08. */
const NOW = new Date('2026-10-08T06:00:00Z');
/** 11:05 in Tbilisi: the 11:00 check plus its margin. */
const FRESH_UNTIL = Date.parse('2026-10-08T07:05:00Z');
/** 09:05 in Tbilisi: the 10:00 check has not succeeded. */
const STALE_SINCE = Date.parse('2026-10-08T05:05:00Z');
const EN_2026_10_07 = tableFixture('en', '2026-10-07');
/** The answer NBG's table valid from 2026-10-07 gives for that date, today being 2026-10-08. */
const ANSWER = snapshotFromDay(EN_2026_10_07, date('2026-10-07'), date('2026-10-08'));

/** A mirror whose span holds the publication of 2026-10-07, fresh until `freshUntil`. */
async function mirrorWith(freshUntil: number): Promise<MemoryMirrorStore> {
    const store = createMemoryMirrorStore();
    await seedMirror(store, {
        publications: [publication(EN_2026_10_07, { ka: tableFixture('ka', '2026-10-07') })],
        state: { span: { start: date('2026-10-07'), end: date('2026-10-09') }, freshUntil },
    });
    return store;
}

describe('readPackageVersion', () => {
    it('reads the version of the package.json it is pointed at', () => {
        const packageJson = new URL('../../package.json', import.meta.url);
        const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
        expect(readPackageVersion(packageJson)).toBe(version);
    });
});

describe('mirrorTableFromEnvironment', () => {
    it.each([
        ['unset', {}],
        ['empty', { NBG_RATES_MIRROR_TABLE: '' }],
        ['blank', { NBG_RATES_MIRROR_TABLE: '  ' }],
    ])('names no table when the variable is %s', (_case, env) => {
        expect(mirrorTableFromEnvironment(env)).toBeUndefined();
    });

    it('names the table trimmed', () => {
        expect(mirrorTableFromEnvironment({ NBG_RATES_MIRROR_TABLE: ' nbg-rates-mirror \n' })).toBe('nbg-rates-mirror');
    });
});

describe('createServiceFromEnvironment', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('calls https://nbg.gov.ge when NBG_RATES_BASE_URL is unset', () => {
        expect(createServiceFromEnvironment('1.2.3', {}).baseUrl).toBe('https://nbg.gov.ge');
    });

    it('removes trailing slashes from NBG_RATES_BASE_URL', () => {
        const { baseUrl } = createServiceFromEnvironment('1.2.3', { NBG_RATES_BASE_URL: 'http://127.0.0.1:9//' });
        expect(baseUrl).toBe('http://127.0.0.1:9');
    });

    it('asks the base URL with the versioned user agent and logs each request when NBG_RATES_DEBUG is 1', async () => {
        const fetchStub = vi.fn<typeof fetch>(() => Promise.resolve(new Response('gone', { status: 404 })));
        vi.stubGlobal('fetch', fetchStub);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { service } = createServiceFromEnvironment('1.2.3', {
            NBG_RATES_BASE_URL: 'http://nbg.example/',
            NBG_RATES_DEBUG: '1',
        });

        const result = await service.getSnapshot({ date: date('2026-10-01'), language: 'en' });

        expect(result.ok).toBe(false);
        expect(fetchStub).toHaveBeenCalledTimes(1);
        const [url, init] = fetchStub.mock.calls[0] ?? [];
        expect(url).toEqual(expect.stringMatching(/^http:\/\/nbg\.example\/gw\/api\//));
        expect(new Headers(init?.headers).get('user-agent')).toBe(
            'nbg-rates-mcp/1.2.3 (+https://github.com/akalongman/nbg-rates-mcp)',
        );
        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(consoleError.mock.calls[0]?.[0]).toMatch(/^\[nbg-rates-mcp\] GET http:\/\/nbg\.example\/gw\/api\//);
    });

    it('logs nothing unless NBG_RATES_DEBUG is exactly 1', async () => {
        vi.stubGlobal('fetch', () => Promise.resolve(new Response('gone', { status: 404 })));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { service } = createServiceFromEnvironment('1.2.3', { NBG_RATES_DEBUG: 'true' });

        await service.getSnapshot({ date: date('2026-10-01'), language: 'en' });

        expect(consoleError).not.toHaveBeenCalled();
    });
});

describe('createServiceFromEnvironment with a mirror', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('answers a fresh covered date from the mirror with no request to NBG_RATES_BASE_URL', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const nbg = failingNbg();
        const store = await mirrorWith(FRESH_UNTIL);
        const { service } = createServiceFromEnvironment(
            '1.2.3',
            { NBG_RATES_BASE_URL: 'http://nbg.example' },
            { store, scopes: createLookupScopes() },
        );

        const result = await service.getSnapshot({ date: date('2026-10-07'), language: 'en' });

        expect(result).toEqual(ANSWER);
        expect(nbg.fetch).not.toHaveBeenCalled();
    });

    it('makes its short attempt one try of SHORT_ATTEMPT_TIMEOUT_MS, then answers from a stale mirror', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const nbg = failingNbg();
        const store = await mirrorWith(STALE_SINCE);
        const { service } = createServiceFromEnvironment(
            '1.2.3',
            { NBG_RATES_BASE_URL: 'http://nbg.example' },
            { store, scopes: createLookupScopes() },
        );

        const result = await service.getSnapshot({ date: date('2026-10-07'), language: 'en' });

        expect(SHORT_ATTEMPT_TIMEOUT_MS).toBe(3_000);
        expect(result).toEqual(ANSWER);
        expect(nbg.fetch).toHaveBeenCalledTimes(1);
        expect(nbg.fetch.mock.calls[0]?.[0]).toEqual(expect.stringMatching(/^http:\/\/nbg\.example\/gw\/api\//));
        expect(nbg.timeouts).toEqual([3_000]);
    });
});
