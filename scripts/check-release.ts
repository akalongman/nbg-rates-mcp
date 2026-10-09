import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { parseCalendarDate } from '../src/core/dates.js';

/**
 * Release preconditions, checked before anything is published: every version field equals the tag's version
 * (including each server.json package entry, which is what registry clients install), CHANGELOG.md has a dated
 * heading for the version (its section becomes the GitHub release notes), and the npm CLI is new enough for
 * trusted publishing. Usage: tsx scripts/check-release.ts <version>
 */

const MINIMUM_NPM = [11, 5, 1] as const;

const versioned = z.object({ version: z.string() });
const serverManifest = versioned.extend({ packages: z.array(versioned).min(1) });

function readVersioned<T extends z.ZodType>(path: string, schema: T): z.infer<T> {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function isAtLeast(actual: string, minimum: ReadonlyArray<number>): boolean {
    const parts = actual.split('.').map(Number);
    for (const [index, wanted] of minimum.entries()) {
        const part = parts[index] ?? 0;
        if (part !== wanted) {
            return part > wanted;
        }
    }
    return true;
}

function changelogProblem(changelog: string, version: string): string | undefined {
    const prefix = `## ${version} - `;
    const heading = changelog.split('\n').find((line) => line.startsWith(prefix));
    if (heading === undefined) {
        return `CHANGELOG.md has no "${prefix}YYYY-MM-DD" heading`;
    }
    const released = heading.slice(prefix.length).trim();
    return parseCalendarDate(released).ok
        ? undefined
        : `CHANGELOG.md dates ${version} as "${released}", not a YYYY-MM-DD calendar date`;
}

const [tagVersion] = process.argv.slice(2);
if (tagVersion === undefined) {
    console.error('usage: tsx scripts/check-release.ts <version>');
    process.exit(2);
}

const server = readVersioned('server.json', serverManifest);
const versions: ReadonlyArray<readonly [string, string]> = [
    ['package.json', readVersioned('package.json', versioned).version],
    ['manifest.json', readVersioned('manifest.json', versioned).version],
    ['server.json', server.version],
    ...server.packages.map((entry, index) => [`server.json packages[${index}]`, entry.version] as const),
];
const problems = versions
    .filter(([, version]) => version !== tagVersion)
    .map(([file, version]) => `${file} has ${version}, the tag is ${tagVersion}`);

const changelog = changelogProblem(readFileSync('CHANGELOG.md', 'utf8'), tagVersion);
if (changelog !== undefined) {
    problems.push(changelog);
}

const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
if (!isAtLeast(npmVersion, MINIMUM_NPM)) {
    problems.push(`npm ${npmVersion} is older than ${MINIMUM_NPM.join('.')}, which trusted publishing needs`);
}

for (const problem of problems) {
    console.error(problem);
}
process.exitCode = problems.length === 0 ? 0 : 1;
