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
    file: 'packages/cli/src/commands/eval/eval-command.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise CLI parent of native cloud operations',
    bridges: [
      { operation: 'Effect.runPromiseExit', removalSlice: 'S9b', owner: 'S9b CLI composition' },
    ],
  },
  {
    file: 'packages/cli/src/commands/cloud/register-cloud-commands.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise CLI parent of native cloud operations',
    bridges: [
      { operation: 'Effect.runPromiseExit', removalSlice: 'S9b', owner: 'S9b CLI composition' },
    ],
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
    owner: 'Hono request read execution roots; host retains catalog lifetime',
  },
  {
    file: 'packages/api/src/client/_tests_/api-client.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'API HTTP comparison fixture test root',
  },
  {
    file: 'packages/api/src/server/_tests_/create-api-app.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'API comparison fixture test root',
  },
  {
    file: 'packages/cli/src/commands/register-root-commands.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Commander report, trace convert and diff action roots',
  },
  {
    file: 'packages/cli/src/commands/projects/register-projects-commands.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Commander projects list action root',
  },
  {
    file: 'packages/cli/src/_tests_/run-cli.test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'CLI scoped persisted report and diff fixture root',
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
];

// Each file declares its operations and per-operation removal slices in bridges. Removed in S10.
const effectMigrationBridges = [
  {
    file: 'packages/local/src/commands/eval/eval-agent-runner.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise parent of native S6 metrics',
    bridges: [
      { operation: 'Effect.runPromiseExit', removalSlice: 'S7b', owner: 'S7b parent lifetime' },
    ],
  },

  {
    file: 'packages/runtime/src/eval/hooks.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise environment caller until S7a',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S7a',
        owner: 'S7a native caller migration',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/agent/adapter/process-session.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'local Promise eval retains native process session scope',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S7b',
        owner: 'local eval process session lifetime',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/agent/adapter/websocket-session.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'local WebSocket run lifetime',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S7b',
        owner: 'local WebSocket run lifetime',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/agent/adapter/callback-session.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'local callback session owns its receiver scope and joins accepted invocations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S7b',
        owner: 'native local invocation session ownership',
      },
    ],
  },

  {
    file: 'packages/local/src/commands/agent/adapter/invoke-resolved-agent.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'local agent dispatch awaits native executor evidence',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S7b',
        owner: 'local agent dispatch awaits native executor evidence',
      },
    ],
  },

  {
    file: 'packages/local/src/commands/eval/hook-command.ts',
    operations: ['Effect.runPromise'],
    owner: 'eval hook process lifetime',
    bridges: [
      { operation: 'Effect.runPromise', removalSlice: 'S7b', owner: 'eval hook process lifetime' },
    ],
  },
  {
    file: 'packages/local/src/run-control/spawn-eval-run.ts',
    operations: ['Effect.runPromise'],
    owner: 'run admission process lifetime',
    bridges: [
      {
        operation: 'Effect.runPromise',
        removalSlice: 'S9a',
        owner: 'run admission process lifetime',
      },
    ],
  },

  {
    file: 'packages/local/src/internal/promise-store-owner.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'temporary owner handshake for later Promise application lifetimes',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S9a',
        owner: 'view server and catalog lifetime',
      },
    ],
  },
  {
    file: 'packages/local/src/run-control/create-run-launcher.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise RunControl native catalog read',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S9a',
        owner: 'RunControl catalog consumer',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/agent/adapter/resolve-native-agent.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'unmigrated Promise parent of Phase A project operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S7b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/agent/import.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'unmigrated Promise parent of Phase A project operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/project/project-init-command.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'unmigrated Promise parent of Phase A project operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },

  {
    file: 'packages/local/src/commands/eval/eval-lifecycle.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'unmigrated Promise parent of Phase A project operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S7b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/eval/eval-cancellation.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'unmigrated Promise parent of Phase A project operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S7b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/eval/eval-persistence.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'unmigrated Promise parent of Phase A project operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S7b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/run/run-configuration.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'unmigrated Promise parent of Phase A project operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S7b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/metric/metric-mutation-command.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'unmigrated Promise parent of Phase A project operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/test/test-mutation-command.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'unmigrated Promise parent of Phase A project operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/agent/authoring/resource-import.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'temporary Promise parent of native S1c file operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'foreign command or registry write parent',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/agent/test.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'temporary Promise parent of native S1c file operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/metric/authoring/resource-readers.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'temporary Promise parent of native S1c file operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'foreign command or registry write parent',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/metric/authoring/value-parsers.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'temporary Promise parent of native S1c file operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'foreign command or registry write parent',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/shared/command-request.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'temporary Promise parent of native S1c file operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'foreign command or registry write parent',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/agent/add.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/agent/remove.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/agent/rename.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/list/list-command.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/metric/metric-test-command.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/project/manifest-publish.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/project/project-inspection-command.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/shared/project-mutation.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/show/show-command.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/commands/test/test-read-command.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/local/src/run-control/list-project-tests.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S9a',
        owner: 'declared migration owner',
      },
    ],
  },
  {
    file: 'packages/cli/src/commands/metric/guided-metric-add.ts',
    operations: ['Effect.runPromiseExit'],
    owner: 'Promise caller of native local operations',
    bridges: [
      {
        operation: 'Effect.runPromiseExit',
        removalSlice: 'S8b',
        owner: 'declared migration owner',
      },
    ],
  },
];

const effectExecutionBlock = ({ file, operations, removalSlice, bridges }) => {
  const dataOnly =
    /^(packages\/core\/src\/(records|analytics)\/|packages\/api\/src\/contract\/)/.test(file);

  const browser =
    dataOnly ||
    /^(packages\/api\/src\/client\/|packages\/web\/src\/|packages\/client\/src\/(index\.ts$|runner\/))/.test(
      file,
    );

  const options = { operations, dataOnly, browser };

  if (removalSlice) options.removalSlice = removalSlice;

  if (bridges) options.bridges = bridges;

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
