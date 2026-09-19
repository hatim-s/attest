import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/coverage/**',
      'conformance/fixtures/**',
    ],
  },
  tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['**/_tests_/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@attest/runtime',
                '@attest/runtime/*',
                '@attest/local',
                '@attest/local/*',
                '@attest/cli',
                '@attest/cli/*',
                '@attest/web',
                '@attest/web/*',
                'node:fs',
                'node:fs/*',
                'node:child_process',
                'node:http',
                'node:https',
                'node:net',
                'node:sqlite',
                'bun:sqlite',
                'kysely',
                '@libsql/*',
                'hono',
                'hono/*',
                '@hono/*',
                '@tanstack/ai*',
              ],
              message:
                'Core owns domain logic and interfaces. Put execution in runtime and local I/O in local.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/runtime/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@attest/local', '@attest/local/*', '@attest/cli', '@attest/cli/*'],
              message: 'Runtime must work without the local application or CLI.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/local/src/**/*.ts'],
    ignores: ['**/_tests_/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@attest/cli', '@attest/cli/*', 'commander'],
              message: 'Local application code must not depend on terminal commands.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@attest/runtime',
                '@attest/runtime/*',
                '@attest/local',
                '@attest/local/*',
                '@attest/cli',
                '@attest/cli/*',
                'node:*',
              ],
              message: 'The dashboard consumes shared domain types, not server implementations.',
            },
          ],
        },
      ],
    },
  },
);
