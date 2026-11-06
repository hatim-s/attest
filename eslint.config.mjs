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

// Exact file paths only. New roots need a concrete lifecycle owner.
const effectRoots = [
  {
    file: 'packages/contracts/src/schema/parse.ts',
    operations: ['Effect.runSyncExit'],
    owner: 'public synchronous schema decoding boundary',
  },
  {
    file: 'packages/contracts/src/_tests_/schema-decoding.test.ts',
    operations: ['Effect.runSync'],
    owner: 'contracts decoder invariant tests',
  },
];

// Each entry: { file, operations, removalSlice, owner }. Removed in S10.
const effectMigrationBridges = [];

const effectExecutionBlock = ({ file, operations, removalSlice }) => {
  const dataOnly =
    /^(packages\/core\/src\/(records|analytics)\/|packages\/api\/src\/contract\/)/.test(file);

  const browser =
    dataOnly ||
    /^(packages\/api\/src\/client\/|packages\/web\/src\/|packages\/client\/src\/(index\.ts$|runner\/))/.test(
      file,
    );

  const options = { operations, dataOnly, browser };

  if (removalSlice) options.removalSlice = removalSlice;

  return { files: [file], rules: { 'anti-slop/effect-boundaries': ['error', options] } };
};

const effectExecutionBlocks = [...effectRoots, ...effectMigrationBridges].map(effectExecutionBlock);

export { effectRoots, effectMigrationBridges, effectExecutionBlock };

export default tseslint.config(
  ...antiSlopConfig,
  {
    ignores: [
      '**/dist/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.notes/**',
      'conformance/fixtures/**',
      '**/.logs/**',
    ],
  },
  tseslint.configs.recommended,
  {
    files: ['packages/core/src/{records,analytics}/**/*.ts', 'packages/api/src/contract/**/*.ts'],
    rules: { 'anti-slop/effect-boundaries': ['error', { dataOnly: true, browser: true }] },
  },
  {
    files: [
      'packages/api/src/client/**/*.ts',
      'packages/web/src/**/*.{ts,tsx}',
      'packages/client/src/index.ts',
      'packages/client/src/runner/**/*.ts',
    ],
    rules: { 'anti-slop/effect-boundaries': ['error', { browser: true }] },
  },
  {
    files: ['packages/core/src/records/page-schemas.ts'],
    rules: {
      'anti-slop/effect-boundaries': [
        'error',
        {
          dataOnly: true,
          browser: true,
          schemaConstructionModules: ['Effect'],
        },
      ],
    },
  },
  {
    files: ['packages/api/src/contract/requests.ts'],
    rules: {
      'anti-slop/effect-boundaries': [
        'error',
        {
          dataOnly: true,
          browser: true,
          schemaConstructionModules: ['Effect', 'SchemaGetter'],
        },
      ],
    },
  },
  ...effectExecutionBlocks,
  {
    files: ['conformance/src/**/*.ts'],
    languageOptions: { parserOptions: { project: './conformance/tsconfig.json' } },
  },
  {
    files: [
      'packages/contracts/src/schema/parse.ts',
      'packages/contracts/src/project/shared.ts',
      // Typecheck-only upstream API probe, removed with its workspace in S10.
      'tools/effect-probe/src/probe.ts',
    ],
    rules: { 'anti-slop/schema-decoding': 'off' },
  },
  {
    files: ['scripts/**/*.ts', 'packages/web/scripts/**/*.ts', 'packages/web/vite.config.ts'],
    languageOptions: { parserOptions: { project: './scripts/tsconfig.json' } },
  },
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
              message:
                'Contract and client use browser-safe contracts, core entries and each other.',
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
    files: ['packages/client/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@attest/*', '!@attest/contracts'],
              message: 'Client imports only @attest/contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/client/src/index.ts', 'packages/client/src/runner/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@attest/*', '!@attest/contracts', 'node:*', 'bun:*'],
              message:
                'The root @attest/client entry runs on Workers; Node code lives under /node and /pi.',
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
