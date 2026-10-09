import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'apply-repo-settings.sh');

// Stands in for gh: logs each call with its stdin on one line, answers `repo view` with fixed JSON fields.
const GH_STUB = `#!/usr/bin/env bash
body=$(cat)
echo "gh $* <<< $body" >> "$STUB_LOG"
if [ "$1 $2" = "repo view" ]; then
    printf 'description: d\\nhomepage: h\\ntopics: t\\n'
fi
`;

describe('apply-repo-settings.sh', () => {
    let stubDir: string;

    beforeEach(() => {
        stubDir = mkdtempSync(join(tmpdir(), 'apply-repo-settings-'));
        writeFileSync(join(stubDir, 'gh'), GH_STUB);
        chmodSync(join(stubDir, 'gh'), 0o755);
    });

    afterEach(() => {
        rmSync(stubDir, { recursive: true, force: true });
    });

    it('sends the description, homepage and topics of .github/repository.json, then reads them back', () => {
        const log = join(stubDir, 'calls.log');
        writeFileSync(log, '');
        const settings = JSON.parse(readFileSync(join(ROOT, '.github', 'repository.json'), 'utf8')) as {
            description: string;
            homepage: string;
            topics: string[];
        };

        const result = spawnSync('bash', [SCRIPT], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${stubDir}:${process.env['PATH'] ?? ''}`, STUB_LOG: log },
        });

        expect(result.status).toBe(0);
        expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
            `gh api --method PATCH repos/{owner}/{repo} --input - <<< ${JSON.stringify({
                description: settings.description,
                homepage: settings.homepage,
            })}`,
            `gh api --method PUT repos/{owner}/{repo}/topics --input - <<< ${JSON.stringify({ names: settings.topics })}`,
            // The log is trimmed, so the empty stdin of the last call leaves no trailing space.
            'gh repo view --json description,homepageUrl,repositoryTopics --jq "description: \\(.description)\\nhomepage: \\(.homepageUrl)\\ntopics: \\((.repositoryTopics // []) | map(.name) | join(", "))" <<<',
        ]);
        expect(result.stdout).toBe('description: d\nhomepage: h\ntopics: t\n');
    });

    it('defines lowercase hyphenated topics only, as GitHub requires', () => {
        const { topics } = JSON.parse(readFileSync(join(ROOT, '.github', 'repository.json'), 'utf8')) as {
            topics: string[];
        };
        expect(topics.length).toBeGreaterThan(0);
        expect(topics.length).toBeLessThanOrEqual(20);
        for (const topic of topics) {
            expect(topic).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        }
    });
});
