import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { date } from '../../test/helpers/values.js';
import { createServiceFromEnvironment, readPackageVersion } from './environment.js';

describe('readPackageVersion', () => {
    it('reads the version of the package.json it is pointed at', () => {
        const packageJson = new URL('../../package.json', import.meta.url);
        const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
        expect(readPackageVersion(packageJson)).toBe(version);
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
