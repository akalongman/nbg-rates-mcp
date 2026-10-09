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
// Stands in for npm: npm view finds no published version, so the npm step publishes.
const NPM_STUB = `#!/usr/bin/env bash
echo "npm $*" >> "$STUB_LOG"
`;
// Stands in for gh: `release view` answers per GH_VIEW (missing: exit 1; false or true: the --jq result), and
// `release create` logs its arguments without the notes and writes the notes to a file, since they span lines.
const GH_STUB = `#!/usr/bin/env bash
if [ "$1 $2" = "release view" ]; then
    echo "gh release view $3" >> "$STUB_LOG"
    if [ "$GH_VIEW" = missing ]; then exit 1; fi
    printf '%s' "$GH_VIEW"
    exit 0
fi
if [ "$1 $2" = "release create" ]; then
    printf '%s' "\${@: -1}" > "$STUB_DIR/notes"
    set -- "\${@:1:$#-1}"
fi
echo "gh $*" >> "$STUB_LOG"
`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(ROOT, 'nbg-rates-mcp-0.2.0.mcpb');
const LATEST = join(ROOT, 'nbg-rates-mcp-latest.mcpb');
const INSTALL_BLOCK =
    'Install: on Claude Desktop (macOS, Windows) download [nbg-rates-mcp-0.2.0.mcpb](https://github.com/akalongman/nbg-rates-mcp/releases/download/v0.2.0/nbg-rates-mcp-0.2.0.mcpb) and open it. In Claude Code run `claude mcp add nbg-rates -- npx -y nbg-rates-mcp@0.2.0`. Other clients: see the [README](https://github.com/akalongman/nbg-rates-mcp#install).';

describe('publish-release.sh', () => {
    let stubDir: string;

    beforeEach(() => {
        stubDir = mkdtempSync(join(tmpdir(), 'publish-release-'));
        for (const [name, body] of [
            ['curl', CURL_STUB],
            ['sleep', SLEEP_STUB],
            ['npm', NPM_STUB],
            ['gh', GH_STUB],
        ] as const) {
            writeFileSync(join(stubDir, name), body);
            chmodSync(join(stubDir, name), 0o755);
        }
    });

    afterEach(() => {
        rmSync(stubDir, { recursive: true, force: true });
        rmSync(BUNDLE, { force: true });
        rmSync(LATEST, { force: true });
    });

    function runStep(
        step: 'npm' | 'registry' | 'github',
        npm404s = 0,
        ghView = 'missing',
    ): { status: number | null; stderr: string; calls: string[] } {
        const log = join(stubDir, 'calls.log');
        writeFileSync(log, '');
        const result = spawnSync('bash', [SCRIPT, step, '0.2.0'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
                STUB_DIR: stubDir,
                STUB_LOG: log,
                NPM_404S: String(npm404s),
                GH_VIEW: ghView,
                RUNNER_TEMP: stubDir,
            },
        });
        return { status: result.status, stderr: result.stderr, calls: readFileSync(log, 'utf8').trim().split('\n') };
    }

    it('registry: waits until npm serves the version before fetching the publisher', () => {
        // npm processes a publish asynchronously; on 2026-10-09 0.2.0 answered 404 for about 108 seconds.
        const { calls } = runStep('registry', 2);

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

    it('registry: gives up after ten minutes without fetching the publisher, naming the status npm answered', () => {
        const { status, stderr, calls } = runStep('registry', Number.MAX_SAFE_INTEGER);

        expect(status).toBe(1);
        expect(stderr).toContain('npm still answers 404 for nbg-rates-mcp@0.2.0');
        expect(calls.filter((call) => call === NPM_VERSION_CHECK)).toHaveLength(40);
        expect(calls.filter((call) => call === 'sleep 15')).toHaveLength(39);
        expect(calls.some((call) => PUBLISHER_DOWNLOAD.test(call))).toBe(false);
    });

    it('npm: publishes the tarball the build job packed, since the publish job cannot build', () => {
        const { status, calls } = runStep('npm');

        expect(status).toBe(0);
        expect(calls).toEqual([
            'npm view nbg-rates-mcp@0.2.0 version',
            'npm publish nbg-rates-mcp-0.2.0.tgz --access public',
        ]);
    });

    describe('github', () => {
        function withBundle(): void {
            // The build job's artifact: the versioned bundle in the repository root, where the publish job runs.
            writeFileSync(BUNDLE, 'bundle bytes');
        }

        it('creates the release with both bundle names and notes that start with the install block', () => {
            withBundle();

            const { status, calls } = runStep('github');

            expect(status).toBe(0);
            expect(calls).toEqual([
                'gh release view v0.2.0',
                'gh release create v0.2.0 nbg-rates-mcp-0.2.0.mcpb nbg-rates-mcp-latest.mcpb --title v0.2.0 --notes',
            ]);
            expect(readFileSync(LATEST, 'utf8')).toBe('bundle bytes');
            const notes = readFileSync(join(stubDir, 'notes'), 'utf8');
            expect(notes.startsWith(`${INSTALL_BLOCK}\n\n`)).toBe(true);
            expect(notes).toContain('Breaking: `nbg_rate_history` days are now');
        });

        it('finishes a release that lacks one of the assets by uploading both and publishing it', () => {
            withBundle();

            const { status, calls } = runStep('github', 0, 'false');

            expect(status).toBe(0);
            expect(calls).toEqual([
                'gh release view v0.2.0',
                'gh release upload v0.2.0 nbg-rates-mcp-0.2.0.mcpb nbg-rates-mcp-latest.mcpb --clobber',
                'gh release edit v0.2.0 --draft=false',
            ]);
        });

        it('leaves a complete release alone', () => {
            withBundle();

            const { status, calls } = runStep('github', 0, 'true');

            expect(status).toBe(0);
            expect(calls).toEqual(['gh release view v0.2.0']);
        });
    });
});
