import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        testTimeout: 15_000,
        projects: [
            { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts', 'test/scripts/**/*.test.ts'] } },
            { extends: true, test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'] } },
            // One live client call can take 20.5 s (10 s timeout, 500 ms backoff, 10 s retry). A slow NBG answer
            // must fail as upstream_unavailable inside the test, never as a Vitest timeout read as a contract break.
            {
                extends: true,
                test: { name: 'contract', include: ['test/contract/**/*.test.ts'], testTimeout: 60_000 },
            },
        ],
    },
});
