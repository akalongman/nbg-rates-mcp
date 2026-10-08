import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        testTimeout: 15_000,
        projects: [
            { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'] } },
            { extends: true, test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'] } },
            { extends: true, test: { name: 'contract', include: ['test/contract/**/*.test.ts'] } },
        ],
    },
});
