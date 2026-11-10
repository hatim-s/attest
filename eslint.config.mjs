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
    file: 'packages/local/src/commands/project/_tests_/project-init-command.test.ts',
    operations: ['Effect.runPromise', 'Effect.runPromiseExit'],
    owner: 'native command invariant test root',
  },
  {
    file: 'packages/local/src/commands/agent/_tests_/agent-test-lifetime.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'native command invariant test root',
  },
  {
    file: 'packages/local/src/commands/agent/_tests_/agent-test.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'native command invariant test root',
  },

  {
    file: 'packages/web/src/api/queries/runs.ts',
    operations: ['Effect.runPromise'],
    owner: 'TanStack query and mutation callback roots',
  },
  {
    file: 'packages/web/src/api/queries/projects.ts',
    operations: ['Effect.runPromise'],
    owner: 'TanStack query callback roots',
  },
  {
    file: 'packages/web/src/api/queries/evals.ts',
    operations: ['Effect.runPromise'],
    owner: 'TanStack query callback roots',
  },
  {
    file: 'packages/web/src/api/queries/activity.ts',
    operations: ['Effect.runPromise'],
    owner: 'TanStack query callback roots',
  },
  {
    file: 'packages/web/src/api/queries/cases.ts',
    operations: ['Effect.runPromise'],
    owner: 'TanStack query callback roots',
  },
  {
    file: 'packages/local/src/view/_tests_/run-view-command.test.ts',
    operations: ['Effect.runPromiseExit', 'Effect.runFork'],
    owner: 'native view command lifetime tests',
  },
  {
    file: 'packages/local/src/view-server/_tests_/view-server.test.ts',
    operations: ['Effect.runSync', 'Effect.runPromiseExit'],
    owner: 'native server Scope and assertion roots',
  },
  {
    file: 'packages/api/src/client/_tests_/snapshot-dashboard.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'native snapshot dashboard assertions',
  },
  ...[
    'packages/client/src/_tests_/support/native-owner.ts',
    'packages/client/src/_tests_/collect-artifacts.test.ts',
    'packages/client/src/_tests_/pi-handler.test.ts',
    'packages/client/src/_tests_/native-lifetimes.test.ts',
    'packages/client/examples/pi-runner.ts',
    'packages/cli/src/acceptance/_tests_/callback-pi-journey.test.ts',
  ].map((file) => ({
    file,
    operations: ['Effect.runPromise'],
    owner: 'Explicit client fixture or process owner scopes',
  })),
  {
    file: 'packages/client/src/node/serve-agent-runner.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Node HTTP request callback root; runner scope retains accepted invocations',
  },
  {
    file: 'packages/runtime/src/eval/_tests_/portability.check.mjs',
    operations: ['Effect.runPromise'],
    owner: 'Node and Bun native environment portability fixture root',
  },
  {
    file: 'packages/local/src/commands/agent/adapter/_tests_/metric-secrets.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S6 secret descriptor and cleanup evidence invariant fixture',
  },
  {
    file: 'packages/runtime/src/metrics/_tests_/metrics-portability.check.mjs',
    operations: ['Effect.runPromise', 'Effect.runPromiseExit'],
    owner: 'S6 Node and Bun native metric invariant root',
  },
  {
    file: 'packages/runtime/src/metrics/_tests_/native-lifetime.test.ts',
    operations: ['Effect.runPromise', 'Effect.runPromiseExit'],
    owner: 'S6 native lifetime invariant fixture',
  },
  {
    file: 'packages/runtime/src/metrics/_tests_/environment-transport.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'S6 metric fixture execution root',
  },
  {
    file: 'packages/runtime/src/metrics/_tests_/evaluate-metrics.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S6 metric fixture execution root',
  },
  {
    file: 'packages/runtime/src/metrics/_tests_/exec-metric.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S6 metric fixture execution root',
  },
  {
    file: 'packages/runtime/src/metrics/judge/_tests_/judge-metric.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S6 metric fixture execution root',
  },
  {
    file: 'packages/runtime/src/metrics/judge/_tests_/tanstack-judge-client.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S6 metric fixture execution root',
  },
  {
    file: 'packages/local/src/commands/eval/_tests_/scoring-redaction.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S6 metric fixture execution root',
  },
  {
    file: 'packages/executor/src/isolation/_tests_/operation.test.ts',
    operations: ['Effect.runPromise', 'Effect.runPromiseExit'],
    owner: 'Native environment lifetime invariant fixture root',
  },
  {
    file: 'packages/local/src/commands/eval/_tests_/metric-sandbox.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'S5 native environment fixture execution',
  },
  {
    file: 'packages/runtime/src/eval/_tests_/hooks.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'S5 native environment fixture execution',
  },
  {
    file: 'packages/executor/src/_tests_/support/run-effect.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S5 native environment fixture execution',
  },
  {
    file: 'packages/executor/src/adapters/websocket/_tests_/websocket-connection.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'WebSocket socket invariant test root',
  },
  {
    file: 'packages/executor/src/adapters/websocket/_tests_/websocket-adapter.test.ts',
    operations: ['Effect.runPromiseExit', 'Effect.runFork'],
    owner: 'WebSocket invariant test root',
  },
  {
    file: 'packages/executor/src/_tests_/callback-adapter.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'native callback lifecycle and authentication test root',
  },
  {
    file: 'packages/executor/src/adapters/stream/_tests_/stream-adapter.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'native stream framing and lifecycle invariant test root',
  },
  {
    file: 'packages/executor/src/adapters/process/_tests_/native-lifecycle.test.ts',
    operations: ['Effect.runPromise', 'Effect.runPromiseExit'],
    owner: 'native process interruption, cleanup and defect invariants',
  },
  {
    file: 'packages/executor/src/adapters/process/_tests_/support/retained-process.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'process fixture scope and invocation execution',
  },
  {
    file: 'packages/local/src/internal/_tests_/operation-cleanup.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S8c release Exit invariant fixtures',
  },
  {
    file: 'packages/cli/src/commands/eval/_tests_/eval-command.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'S8c fixture execution root',
  },
  {
    file: 'packages/local/src/registry/_tests_/registry-catalog.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S8c fixture execution root',
  },
  {
    file: 'packages/local/src/registry/_tests_/project-registry.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S8c fixture execution root',
  },
  {
    file: 'packages/local/src/cloud/_tests_/upload.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S8c fixture execution root',
  },
  {
    file: 'packages/local/src/cloud/_tests_/resolution.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S8c fixture execution root',
  },
  {
    file: 'packages/local/src/cloud/_tests_/client-credentials.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S8c fixture execution root',
  },
  {
    file: 'packages/executor/src/_tests_/portability.check.mjs',
    operations: ['Effect.runPromise'],
    owner: 'Node and Bun native executor portability process roots',
  },
  {
    file: 'packages/executor/src/_tests_/http-invoker.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'owned HTTP, transport and cleanup fixture execution',
  },
  {
    file: 'packages/executor/src/_tests_/http-transports.test.ts',
    operations: ['Effect.runPromise', 'Effect.runPromiseExit'],
    owner: 'owned HTTP, transport and cleanup fixture execution',
  },
  {
    file: 'packages/executor/src/adapters/http/_tests_/mapped-http-adapter.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'owned HTTP, transport and cleanup fixture execution',
  },
  {
    file: 'packages/executor/src/adapters/http/_tests_/pinned-request.test.ts',
    operations: ['Effect.runPromise', 'Effect.runPromiseExit'],
    owner: 'owned HTTP, transport and cleanup fixture execution',
  },
  {
    file: 'packages/executor/src/_tests_/cli-invoker.test.ts',
    operations: ['Effect.runPromise', 'Effect.runPromiseExit'],
    owner: 'CLI native attempt and resource lifetime invariant test root',
  },
  {
    file: 'packages/executor/src/_tests_/invoke.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'native dispatch retry and configuration invariant test root',
  },
  {
    file: 'packages/executor/src/internal/_tests_/invocation-retry.test.ts',
    operations: ['Effect.runPromise', 'Effect.runPromiseExit'],
    owner: 'native retry policy, typed channel, service inference and defect invariant test roots',
  },
  {
    file: 'packages/executor/src/internal/_tests_/process-tree.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'owned process observation, identity and termination invariants',
  },
  {
    file: 'packages/api/src/server/create-api-app.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Hono read/control request roots; start admission ignores request disconnect',
  },
  {
    file: 'packages/api/src/client/_tests_/api-client.test.ts',
    operations: ['Effect.runPromiseExit', 'Effect.runFork'],
    owner: 'API HTTP comparison fixture test root',
  },
  {
    file: 'packages/api/src/server/_tests_/create-api-app.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'API comparison fixture test root',
  },
  {
    file: 'packages/cli/src/_tests_/run-cli.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'CLI scoped persisted report and diff fixture root',
  },
  {
    file: 'packages/cli/src/commands/shared/_tests_/required-input.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'prompt cancellation test root',
  },
  {
    file: 'packages/local/src/store/_tests_/fixtures/crash-writer.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'intentional crash process root',
  },
  {
    file: 'packages/local/src/store/_tests_/store-fixture.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'scoped test store owner',
  },
  {
    file: 'packages/local/src/store/_tests_/store-lifetime.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'store lifetime invariants',
  },
  {
    file: 'packages/core/src/diff/_tests_/diff-runs.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'diff coordinator test root',
  },
  ...['bounded-run-details', 'run-store', 'cache'].map((name) => ({
    file: `packages/local/src/store/_tests_/${name}.test.ts`,
    operations: ['Effect.runPromiseExit'],
    owner: 'store driver fixture root',
  })),
  {
    file: 'packages/local/src/store/_tests_/migration-lifetime.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'native migration lifetime invariants',
  },
  {
    file: 'packages/local/src/store/_tests_/database.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'database migration fixture root',
  },
  {
    file: 'packages/local/src/internal/_tests_/open-anchored.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'anchored descriptor cleanup and interruption invariants',
  },
  {
    file: 'packages/cli/src/_tests_/project-commands.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'CLI project fixture test root',
  },
  {
    file: 'packages/cli/src/_tests_/projects-commands.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'CLI project fixture test root',
  },
  {
    file: 'packages/cli/src/commands/agent/_tests_/agent-command.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'CLI project fixture test root',
  },
  {
    file: 'packages/cli/src/commands/metric/_tests_/metric-command.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'CLI project fixture test root',
  },
  {
    file: 'packages/cli/src/commands/test/_tests_/test-command.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'CLI project fixture test root',
  },
  {
    file: 'packages/local/src/commands/agent/_tests_/agent-authoring.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'project source and consumer invariant test root',
  },
  {
    file: 'packages/local/src/commands/agent/_tests_/agent-mutation.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'project source and consumer invariant test root',
  },
  {
    file: 'packages/local/src/commands/eval/_tests_/eval-run-callback.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'project source and consumer invariant test root',
  },
  {
    file: 'packages/local/src/commands/metric/_tests_/metric-mutation-command.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'project source and consumer invariant test root',
  },
  {
    file: 'packages/local/src/commands/test/_tests_/test-mutation-command.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'project source and consumer invariant test root',
  },
  {
    file: 'packages/local/src/project/_tests_/discover-project.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'project source and consumer invariant test root',
  },
  {
    file: 'packages/local/src/project/_tests_/load-project.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'project source and consumer invariant test root',
  },
  {
    file: 'packages/local/src/project/transaction/_tests_/semantic-project-diff.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'project source and consumer invariant test root',
  },
  {
    file: 'packages/local/src/project/transaction/_tests_/transactional-writer.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'project source and consumer invariant test root',
  },
  {
    file: 'packages/local/src/run/_tests_/run-configuration.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'project source and consumer invariant test root',
  },
  {
    file: 'packages/local/src/internal/_tests_/private-file.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'private filesystem publication interruption and confinement invariant tests',
  },
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
  {
    file: 'packages/contracts/src/_tests_/error.test.ts',
    operations: ['Effect.runSyncExit', 'Effect.runPromiseExit'],
    owner: 'contracts owned-error invariant tests',
  },
  {
    file: 'packages/local/src/_tests_/support/project-transaction.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'transaction and caller invariant test root',
  },
  {
    file: 'packages/local/src/cloud/_tests_/sync.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'transaction and caller invariant test root',
  },
  {
    file: 'packages/local/src/commands/project/_tests_/load-command-project.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'transaction and caller invariant test root',
  },
  {
    file: 'packages/local/src/project/transaction/_tests_/journal-boundary.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'transaction and caller invariant test root',
  },
  {
    file: 'packages/local/src/project/transaction/_tests_/project-lock.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'transaction and caller invariant test root',
  },
  {
    file: 'packages/local/src/project/transaction/_tests_/transaction-lifecycle.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'transaction and caller invariant test root',
  },
  {
    file: 'packages/local/src/commands/agent/_tests_/support/agent-project.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'native resource command fixture execution root',
  },
  {
    file: 'packages/local/src/commands/metric/_tests_/metric-test-command.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'native resource command fixture execution root',
  },
  {
    file: 'packages/local/src/commands/test/import/_tests_/tabular-import-adapter.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'native resource command fixture execution root',
  },
  {
    file: 'packages/local/src/run-control/_tests_/run-launcher.test.ts',
    operations: ['Effect.runSync', 'Effect.runPromiseExit'],
    owner: 'native launcher fixture and assertion roots',
  },
  {
    file: 'packages/local/src/commands/project/_tests_/manifest-publication.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'no-overwrite publication and rollback fence invariant root',
  },
  {
    file: 'packages/local/src/commands/shared/_tests_/command-effects.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'command cleanup and typed failure invariant test root',
  },
  {
    file: 'packages/local/src/commands/agent/_tests_/callback-session.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S7 B1 native adapter invariant tests',
  },
  {
    file: 'packages/local/src/commands/eval/_tests_/eval-lifecycle.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S7 B1 native adapter invariant tests',
  },
  {
    file: 'packages/local/src/commands/eval/_tests_/hook-command.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S7 B1 native adapter invariant tests',
  },
  {
    file: 'packages/local/src/commands/eval/_tests_/sandbox-lifecycle.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S7 B1 native adapter invariant tests',
  },
  {
    file: 'packages/runtime/src/eval/_tests_/execute-eval.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'S7a native eval test root',
  },
  {
    file: 'packages/runtime/src/eval/_tests_/scheduler.test.ts',
    operations: ['Effect.runPromise'],
    owner: 'S7a native eval test root',
  },
  {
    file: 'packages/runtime/src/eval/_tests_/native-lifecycle.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'S7a native eval test root',
  },
  {
    file: 'packages/local/src/commands/eval/_tests_/eval-cancellation.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'native cancellation generation invariant test root',
  },
  {
    file: 'packages/local/src/run/_tests_/eval-application-fixture.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'native eval application test root',
  },
  {
    file: 'packages/cli/src/run-cli.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'CLI application composition root',
  },
];

const effectExecutionBlock = ({ file, operations }) => {
  const dataOnly =
    /^(packages\/core\/src\/(records|analytics)\/|packages\/api\/src\/contract\/)/.test(file);

  const browser =
    dataOnly ||
    /^(packages\/api\/src\/client\/|packages\/web\/src\/|packages\/client\/src\/(index\.ts$|runner\/))/.test(
      file,
    );

  const options = { operations, dataOnly, browser };

  return { files: [file], rules: { 'anti-slop/effect-boundaries': ['error', options] } };
};

const effectExecutionBlocks = effectRoots.map(effectExecutionBlock);

export { effectRoots, effectExecutionBlock };

export default tseslint.config(
  ...antiSlopConfig,
  {
    ignores: [
      '.agent-sources/**',
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
    files: ['packages/contracts/src/schema/parse.ts', 'packages/contracts/src/project/shared.ts'],
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
