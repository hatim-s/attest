import antiSlopConfig from './tools/anti-slop/config.mjs';
import tseslint from 'typescript-eslint';

const apiForbidden = [
  '@attest/executor',
  '@attest/executor/*',
  '@attest/runtime',
  '@attest/runtime/*',
  '@attest/local',
  '@attest/local/*',
  '@attest/cli',
  '@attest/cli/*',
  '@attest/web',
  '@attest/web/*',
  'node:*',
  'bun:*',
  '@hono/*',
  'kysely',
  '@libsql/*',
];

const coreForbidden = [
  '@attest/api',
  '@attest/api/*',
  '@attest/executor',
  '@attest/executor/*',
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
];

export default tseslint.config(
  ...antiSlopConfig,
  {
    ignores: [
      '**/dist/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/coverage/**',
      'conformance/fixtures/**',
      '**/.logs/**',
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
              group: coreForbidden,
              message:
                'Core owns domain logic and interfaces. Put transport execution in executor, evaluation execution in runtime, and local I/O in local.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/{analytics,records}/**/*.ts'],
    ignores: ['**/_tests_/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...coreForbidden, 'node:*'],
              message: 'Analytics and records must remain browser-safe.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/api/src/**/*.ts'],
    ignores: ['**/_tests_/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: apiForbidden,
              message:
                'The api package runs on any fetch host. Hosts own sockets, storage drivers and auth.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/api/src/contract/**/*.ts', 'packages/api/src/client/**/*.ts'],
    ignores: ['**/_tests_/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@attest/core', message: 'Browser code imports browser-safe core entries.' },
          ],
          patterns: [
            {
              group: [...apiForbidden, 'hono', 'hono/*', '../server/*', '../host/*'],
              message: 'Contract and client import zod, browser-safe core entries and each other.',
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
    files: ['packages/executor/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@attest/core',
                '@attest/core/*',
                '@attest/runtime',
                '@attest/runtime/*',
                '@attest/local',
                '@attest/local/*',
                '@attest/cli',
                '@attest/cli/*',
                '@attest/web',
                '@attest/web/*',
              ],
              message: 'Executor imports only @attest/contracts.',
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
          paths: [
            {
              name: '@attest/api',
              message:
                'The dashboard uses @attest/api/client and @attest/api/contract, never the server app.',
            },
            { name: '@attest/core', message: 'The dashboard imports browser-safe core entries.' },
          ],
          patterns: [
            {
              group: [
                '@attest/executor',
                '@attest/executor/*',
                '@attest/runtime',
                '@attest/runtime/*',
                '@attest/local',
                '@attest/local/*',
                '@attest/cli',
                '@attest/cli/*',
                'node:*',
                'hono',
                'hono/*',
              ],
              message: 'The dashboard consumes shared domain types, not server implementations.',
            },
          ],
        },
      ],
    },
  },
);
