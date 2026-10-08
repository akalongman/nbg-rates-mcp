import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
    { ignores: ['dist/**', 'node_modules/**', '*.mcpb', 'bundle/**'] },
    tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-non-null-assertion': 'error',
            eqeqeq: ['error', 'always'],
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
    {
        files: ['src/core/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        { group: ['**/shell/**', 'node:*'], message: 'core is pure: no shell, no Node built-ins' },
                    ],
                },
            ],
            'no-console': 'error',
        },
    },
    {
        files: ['eslint.config.js'],
        extends: [tseslint.configs.disableTypeChecked],
    },
);
