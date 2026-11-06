import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ESLint } from 'eslint';
import { RuleTester } from './runtime.mjs';
import { coreModules, effectBoundariesRule } from '../rules/effect-boundaries.mjs';
import { effectRoots, effectMigrationBridges, effectExecutionBlock } from '../../../eslint.config.mjs';

const tester = new RuleTester();
const error = { messageId: 'boundary' };
tester.run('Effect execution and import ownership', effectBoundariesRule, {
  valid: [
    {
      code: "import { Stream } from 'effect';\n// EFFECT-BRIDGE(S9a)\nStream.toReadableStream(stream);",
      options: [{ operations: ['Stream.toReadableStream'], removalSlice: 'S9a' }],
    },
    {
      code: "import { FiberSet } from 'effect'; FiberSet.runtimePromise(set)();",
      options: [{ operations: ['FiberSet.runtimePromise'] }],
    },
    {
      code: "import { Effect } from 'effect';\n/* EFFECT-BRIDGE(S2) */\nEffect.runPromise(job);",
      options: [{ operations: ['Effect.runPromise'], removalSlice: 'S2' }],
    },
    {
      code: "import { runPromise as execute } from 'effect/Effect';\n// EFFECT-BRIDGE(S2)\nexecute(job);",
      options: [{ operations: ['Effect.runPromise'], removalSlice: 'S2' }],
    },
    "import { Effect as E } from 'effect'; E.succeed(1);",
    "import { succeed } from 'effect/Effect'; succeed(1);",
    "import * as S from 'effect/Schema'; S.String;",
    { code: "import { Schema } from 'effect'; Schema.String;", options: [{ dataOnly: true }] },
    {
      code: "import { Effect } from 'effect'; Effect.runPromise(job);",
      options: [{ operations: ['Effect.runPromise'] }],
    },
    {
      code: "import { Effect } from 'effect';\n// EFFECT-BRIDGE(S2)\nEffect.runPromise(job);",
      options: [{ operations: ['Effect.runPromise'], removalSlice: 'S2' }],
    },
    "import { Effect } from 'effect'; function f(Effect) { Effect.runPromise(job); }",
  ],
  invalid: [
    { code: "import { NodeRuntime } from '@effect/platform-node';", errors: [error] },
    { code: "export * from '@effect/platform';", errors: [error] },
    { code: "require('@effect/platform-bun');", errors: [error] },
    { code: "import(modulePath);", errors: [error] },
    { code: "require(modulePath);", errors: [error] },
    { code: '// EFFECT-BRIDGE(S2\nfoo();', errors: [error] },
    {
      code: "import { Effect } from 'effect';\n// EFFECT-BRIDGE(S2\nEffect.runPromise(job);",
      options: [{ operations: ['Effect.runPromise'], removalSlice: 'S2' }],
      errors: [error, error],
    },
    {
      code: "import { Effect } from 'effect';\n// EFFECT-BRIDGE(S2) EFFECT-BRIDGE(S2\nEffect.runPromise(job);",
      options: [{ operations: ['Effect.runPromise'], removalSlice: 'S2' }],
      errors: [error],
    },
    ...[
      ['Runtime', 'makeRunMain'],
      ...['FiberSet', 'FiberMap', 'FiberHandle'].flatMap((module) =>
        ['runtime', 'runtimePromise'].map((name) => [module, name]),
      ),
      ...[
        'toReadableStream',
        'toReadableStreamWith',
        'toReadableStreamEffect',
        'toAsyncIterable',
        'toAsyncIterableWith',
        'toAsyncIterableEffect',
      ].map((name) => ['Stream', name]),
    ].map(([module, name]) => ({
      code: `import { ${module} } from 'effect'; ${module}.${name}(job);`,
      errors: [error],
    })),
    {
      code: "import { Effect } from 'effect';\nexport const results = [\n  'EFFECT-BRIDGE(S2)',\n  Effect.runPromise(Effect.succeed(1)),\n];",
      options: [{ operations: ['Effect.runPromise'], removalSlice: 'S2' }],
      errors: [error],
    },
    {
      code: "import { Effect } from 'effect';\n// EFFECT-BRIDGE(S2) EFFECT-BRIDGE(S3)\nexport const result = Effect.runPromise(Effect.succeed(1));",
      options: [{ operations: ['Effect.runPromise'], removalSlice: 'S2' }],
      errors: [error],
    },
    ...['runPromise', 'runSync', 'runForkWith', 'runPromiseExitWith'].map((name) => ({
      code: `import { Effect as E } from 'effect'; const run = E.${name};`,
      errors: [error],
    })),
    {
      code: "import { runPromise as execute } from 'effect/Effect'; execute(job);",
      errors: [error],
    },
    {
      code: "import { ManagedRuntime as M } from 'effect'; const create = M.make;",
      errors: [error],
    },
    { code: "import * as FX from 'effect'; FX.Effect['runSync'](job);", errors: [error] },
    { code: "import * as E from 'effect/Effect'; const { runPromise: run } = E;", errors: [error] },
    { code: "import { Effect } from 'effect'; const E = Effect;", errors: [error] },
    {
      code: "import { Effect } from 'effect'; (Effect as typeof Effect).runPromise(job);",
      errors: [error],
    },
    { code: "import { Effect } from 'effect'; const E = Effect!;", errors: [error] },
    { code: "import { Effect } from 'effect'; Effect[name](job);", errors: [error] },
    ...[
      'http',
      'http-api',
      'sql',
      'process',
      'cli',
      'rpc',
      'socket',
      'cluster',
      'workflow',
      'ai',
      'persistence',
      'workers',
      'http/HttpClient',
      'unknown',
      'internal/effect',
      'package.json',
    ].map((name) => ({ code: `import * as M from 'effect/${name}';`, errors: [error] })),
    { code: "import { Effect } from 'effect';", options: [{ dataOnly: true }], errors: [error] },
    {
      code: "import * as F from 'effect'; F.Effect.succeed(1);",
      options: [{ dataOnly: true }],
      errors: [error, error],
    },
    { code: "import * as E from 'effect/Effect';", options: [{ dataOnly: true }], errors: [error] },
    { code: "import fs from 'fs';", options: [{ browser: true }], errors: [error] },
    { code: "import fs from 'node:fs';", options: [{ browser: true }], errors: [error] },
    { code: "import('effect/Effect');", errors: [error] },
    { code: "const E = require('effect');", errors: [error] },
    { code: "export { runPromise } from 'effect/Effect';", errors: [error] },
    { code: '// EFFECT-BRIDGE(S2)\nfoo();', errors: [error] },
    {
      code: "import { Effect } from 'effect';\n// EFFECT-BRIDGE(S2)\nEffect.runPromise(job);\n// EFFECT-BRIDGE(S2)\nfoo();",
      options: [{ operations: ['Effect.runPromise'], removalSlice: 'S2' }],
      errors: [error],
    },
    {
      code: "import { Effect } from 'effect'; Effect.runPromise(job);",
      options: [{ operations: ['Effect.runPromise'], removalSlice: 'S2' }],
      errors: [error],
    },
    {
      code: '// EFFECT-BRIDGE(S2)\nfoo();',
      options: [{ operations: ['Effect.runPromise'], removalSlice: 'S2' }],
      errors: [error, error],
    },
  ],
});

// Synthetic entries exercise the production ledger mapper even when ledgers are empty.
for (const [file, dataOnly, browser] of [
  ['packages/core/src/records/probe.ts', true, true],
  ['packages/core/src/analytics/probe.ts', true, true],
  ['packages/api/src/contract/probe.ts', true, true],
  ['packages/api/src/client/probe.ts', false, true],
  ['packages/web/src/probe.tsx', false, true],
  ['packages/client/src/runner/probe.ts', false, true],
  ['packages/client/src/index.ts', false, true],
  ['packages/local/src/probe.ts', false, false],
]) {
  const block = effectExecutionBlock({ file, operations: ['Effect.runPromise'], removalSlice: 'S2' });
  assert.deepEqual(block.rules['anti-slop/effect-boundaries'][1], {
    operations: ['Effect.runPromise'], dataOnly, browser, removalSlice: 'S2',
  });
}

// Check actual flat-config routing, including tests, rather than just rule options.
const eslint = new ESLint();
for (const file of [
  'packages/core/src/records/probe.ts',
  'packages/core/src/analytics/probe.ts',
  'packages/api/src/contract/probe.ts',
]) {
  const config = await eslint.calculateConfigForFile(file);
  assert.equal(config.rules['anti-slop/effect-boundaries'][1].dataOnly, true, file);
}
for (const file of [
  'packages/web/src/probe.tsx',
  'packages/api/src/client/probe.ts',
  'packages/client/src/runner/probe.ts',
]) {
  const config = await eslint.calculateConfigForFile(file);
  assert.equal(config.rules['anti-slop/effect-boundaries'][1].browser, true, file);
}
const testConfig = await eslint.calculateConfigForFile('packages/local/src/_tests_/probe.ts');
assert.equal(testConfig.rules['anti-slop/effect-boundaries'][0], 2);
assert.equal(testConfig.rules['anti-slop/effect-boundaries'][1]?.operations, undefined);
const installed = readFileSync(
  new URL('../../effect-probe/node_modules/effect/src/index.ts', import.meta.url),
  'utf8',
);
assert.deepEqual(
  [...coreModules],
  [...installed.matchAll(/export \* as (\w+) from/g)].map((match) => match[1]),
);
const files = new Set();
for (const entry of [...effectRoots, ...effectMigrationBridges]) {
  assert.match(entry.file, /^(packages|tools)\/.+\.[cm]?[jt]sx?$/);
  assert.doesNotMatch(entry.file, /[*?{}!]/);
  assert.ok(!files.has(entry.file), 'One ownership entry per file');
  files.add(entry.file);
  assert.ok(entry.owner?.trim());
  assert.ok(entry.operations.length);
  if (effectMigrationBridges.includes(entry))
    assert.match(entry.removalSlice, /^S(?:[1-9]|10)[a-z]?(?:\.[0-9])?$/);
  readFileSync(entry.file, 'utf8');
  const results = await eslint.lintFiles(entry.file);
  assert.equal(
    results
      .flatMap((result) => result.messages)
      .filter((message) => message.ruleId === 'anti-slop/effect-boundaries').length,
    0,
  );
}
console.log('Effect import, execution, flat-config and bridge ledger checks passed.');
