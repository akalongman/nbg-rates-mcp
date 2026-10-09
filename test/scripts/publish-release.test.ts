import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'publish-release.sh');
const MCP_REGISTRY_CHECK =
    'curl https://registry.modelcontextprotocol.io/v0.1/servers/io.github.akalongman%2Fnbg-rates/versions/0.2.0';
const NPM_VERSION_CHECK = 'curl https://registry.npmjs.org/nbg-rates-mcp/0.2.0';
const PUBLISHER_DOWNLOAD = /^curl https:\/\/github\.com\/modelcontextprotocol\/registry\/releases\/download\//;

// Stands in for curl: the MCP registry does not list the version yet, npm answers 404 for the first NPM_404S checks
// of the version URL and 200 after, and the publisher download fails, so the step stops before anything is published.
const CURL_STUB = `#!/usr/bin/env bash
url="\${*: -1}"
echo "curl $url" >> "$STUB_LOG"
case "$url" in
    https://registry.modelcontextprotocol.io/*) printf 404 ;;
    https://registry.npmjs.org/*)
        checks=$(( $(cat "$STUB_DIR/npm-checks" 2> /dev/null || echo 0) + 1 ))
        echo "$checks" > "$STUB_DIR/npm-checks"
        if [ "$checks" -gt "$NPM_404S" ]; then printf 200; else printf 404; fi
        ;;
    *) exit 22 ;;
esac
`;
const SLEEP_STUB = `#!/usr/bin/env bash
echo "sleep $1" >> "$STUB_LOG"
`;

describe('publish-release.sh registry', () => {
    let stubDir: string;

    beforeEach(() => {
        stubDir = mkdtempSync(join(tmpdir(), 'publish-release-'));
        for (const [name, body] of [
            ['curl', CURL_STUB],
            ['sleep', SLEEP_STUB],
        ] as const) {
            writeFileSync(join(stubDir, name), body);
            chmodSync(join(stubDir, name), 0o755);
        }
    });

    afterEach(() => {
        rmSync(stubDir, { recursive: true, force: true });
    });

    function runRegistryStep(npm404s: number): { status: number | null; stderr: string; calls: string[] } {
        const log = join(stubDir, 'calls.log');
        writeFileSync(log, '');
        const result = spawnSync('bash', [SCRIPT, 'registry', '0.2.0'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
                STUB_DIR: stubDir,
                STUB_LOG: log,
                NPM_404S: String(npm404s),
                RUNNER_TEMP: stubDir,
            },
        });
        return { status: result.status, stderr: result.stderr, calls: readFileSync(log, 'utf8').trim().split('\n') };
    }

    it('waits until npm serves the version before fetching the publisher', () => {
        // npm processes a publish asynchronously; on 2026-10-09 0.2.0 answered 404 for about 108 seconds.
        const { calls } = runRegistryStep(2);

        expect(calls.slice(0, -1)).toEqual([
            MCP_REGISTRY_CHECK,
            NPM_VERSION_CHECK,
            'sleep 15',
            NPM_VERSION_CHECK,
            'sleep 15',
            NPM_VERSION_CHECK,
        ]);
        expect(calls.at(-1)).toMatch(PUBLISHER_DOWNLOAD);
    });

    it('gives up after ten minutes without fetching the publisher, naming the status npm answered', () => {
        const { status, stderr, calls } = runRegistryStep(Number.MAX_SAFE_INTEGER);

        expect(status).toBe(1);
        expect(stderr).toContain('npm still answers 404 for nbg-rates-mcp@0.2.0');
        expect(calls.filter((call) => call === NPM_VERSION_CHECK)).toHaveLength(40);
        expect(calls.filter((call) => call === 'sleep 15')).toHaveLength(39);
        expect(calls.some((call) => PUBLISHER_DOWNLOAD.test(call))).toBe(false);
    });
});
