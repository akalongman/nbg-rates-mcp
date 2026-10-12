import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'build-lambda.sh');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };

describe('build-lambda.sh', () => {
    let workDir: string | undefined;

    afterEach(() => {
        if (workDir !== undefined) {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    it('zips dist, node_modules and package.json from the tarball with the lock beside it', () => {
        workDir = mkdtempSync(join(tmpdir(), 'build-lambda-'));
        // The tarball the build job packs; npm pack writes it into the working directory.
        execFileSync('npm', ['pack', '--pack-destination', workDir], { cwd: ROOT, stdio: 'ignore' });
        const result = spawnSync('bash', [SCRIPT, version], {
            cwd: workDir,
            encoding: 'utf8',
            env: { ...process.env, PACKAGE_LOCK: join(ROOT, 'package-lock.json') },
        });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const zip = join(workDir, `nbg-rates-mcp-${version}-lambda.zip`);
        expect(existsSync(zip)).toBe(true);
        const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n');
        expect(listing).toContain('dist/lambda.js');
        expect(listing).toContain('dist/bin.js');
        expect(listing).toContain('package.json');
        expect(listing.some((entry) => entry.startsWith('node_modules/@modelcontextprotocol/server/'))).toBe(true);
        expect(listing.some((entry) => entry.startsWith('node_modules/zod/'))).toBe(true);
        expect(listing.some((entry) => entry.startsWith('node_modules/vitest/'))).toBe(false);
        expect(listing.some((entry) => entry.startsWith('package/'))).toBe(false);
    }, 120_000);
});
