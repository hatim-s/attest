import { isRecord, isString, parseCliResult, parseManifest } from './release-json.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Installs packed releases outside the workspace and exercises their public entry points with Node. */
const checkRelease = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-consumer-'));
  // `attest project init` registers the project; keep that out of the developer's ~/.attest.
  const env = { ...process.env, ATTEST_HOME: join(directory, 'attest-home') };

  try {
    await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
    const releaseDirectory = join(root, 'dist/release');

    const tarballs = (await readdir(releaseDirectory))
      .filter((file) => file.endsWith('.tgz'))
      .map((file) => join(releaseDirectory, file));

    assert.equal(tarballs.length, 10, 'Expected all ten release packages.');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
      cwd: directory,
      stdio: 'inherit',
      timeout: 180_000,
    });
    const cli = join(directory, 'node_modules/.bin/attest');
    const projectDirectory = join(directory, 'demo');

    const runCli = (...args: string[]): string =>
      execFileSync(cli, args, { cwd: directory, encoding: 'utf8', env, timeout: 30_000 });

    const metadata = parseManifest(await readFile(join(root, 'packages/cli/package.json'), 'utf8'));

    assert.equal(runCli('--version').trim(), metadata.version);
    assert.match(runCli('--help'), /Usage: attest/);

    const initialized = parseCliResult(
      runCli('project', 'init', 'demo', '--name', 'Release check', '--output', 'json'),
    );

    assert.equal(initialized.ok, true);
    await cp(
      join(root, 'packages/cli/src/acceptance/_tests_/fixtures/quickstart/native-agent.mjs'),
      join(projectDirectory, 'agent.mjs'),
    );
    await cp(
      join(root, 'packages/cli/src/acceptance/_tests_/fixtures/quickstart/agent-cases.jsonl'),
      join(projectDirectory, 'cases.jsonl'),
    );

    const projectCli = (...args: string[]): string =>
      execFileSync(cli, args, { cwd: projectDirectory, encoding: 'utf8', env, timeout: 30_000 });

    for (const args of [
      ['agent', 'add', 'support', '--argv-json', '["node","./agent.mjs"]', '--timeout', '5s'],
      ['metric', 'add', 'exact', '--preset', 'output-contains', '--value', '"policy"'],
      ['test', 'add', 'smoke', '--agent', 'support', '--metric', 'exact'],
      ['test', 'case', 'import', 'smoke', './cases.jsonl'],
    ]) {
      assert.equal(parseCliResult(projectCli(...args, '--output', 'json')).ok, true);
    }

    const evaluation = parseCliResult(projectCli('eval', 'run', 'smoke', '--output', 'json'));

    assert.equal(evaluation.ok, true);
    assert(evaluation.ok && isRecord(evaluation.result));
    assert.equal(evaluation.result.verdict, 'pass');
    assert(isString(evaluation.result.run_id));
    assert.ok(evaluation.result.run_id);
    projectCli('report', evaluation.result.run_id, '--output', 'report.html');
    assert.match(await readFile(join(projectDirectory, 'report.html'), 'utf8'), /<html/);

    // Resolve only installed packages. This catches workspace symlink and missing asset mistakes.
    await writeFile(
      join(directory, 'verify.mjs'),
      `import { Effect } from 'effect';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cliResultSchema, parseWithSchema } from '@attest/contracts';
import { openStore, withStoreScope } from '@attest/local/store';
import { startViewServer } from '@attest/local/view-server';
import { invokeAgent } from '@attest/executor';
import { createAgentRunner } from '@attest/client';
import { collectArtifacts, serveAgentRunner } from '@attest/client/node';
import { createPiHandler } from '@attest/client/pi';
import { executeResolvedEvalPlan } from '@attest/runtime';
import { createSingleProjectCatalog, selectCases } from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';
import { runCli } from '@attest/cli';
assert.equal(typeof runCli, 'function');
assert.equal(typeof invokeAgent, 'function');
assert.equal(typeof collectArtifacts, 'function');
assert.equal(typeof createPiHandler(), 'function');
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
const runner = yield* createAgentRunner({ handler: () => Effect.succeed({ output: null }), triggerToken: 'release-check' });
const served = yield* serveAgentRunner(runner, { port: 0 });
yield* Effect.promise(async () => {
try {
  const trigger = await fetch(served.url, { method: 'POST', headers: { authorization: 'Bearer release-check', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(trigger.status, 400);
} finally {
  // The outer scope owns listener and runner disposal.
}
});
yield* runner.close();
})));
assert.equal(typeof executeResolvedEvalPlan, 'function');
assert.equal(typeof selectCases, 'function');
assert.equal(parseWithSchema(cliResultSchema, {}).ok, false);
assert.ok(dashboardHtml.includes('<html'));
const schema = JSON.parse(await readFile(new URL(import.meta.resolve('@attest/schemas/generated/project.json')), 'utf8'));
assert.ok(schema.$schema);
await Effect.runPromise(withStoreScope((owner) => Effect.gen(function* () {
const store = yield* openStore('release-check.db', owner);
assert.deepEqual(yield* store.runs.listRuns(), { items: [] });
// Join the foreign server lifetime before the store owner releases its handles.
yield* Effect.promise(async () => {
const server = await startViewServer({
  catalog: createSingleProjectCatalog({ key: 'release', name: 'Release' }, store.runs),
  close: async () => {},
  indexHtml: dashboardHtml,
  port: 0,
});
try {
  const response = await fetch(server.url);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('window.__ATTEST_BOOTSTRAP__='));
  const runs = await fetch(new URL('/api/projects/release/runs', server.url));
  assert.deepEqual(await runs.json(), { items: [] });
} finally {
  await server.close();
}
});
})));
`,
    );
    execFileSync('node', ['verify.mjs'], {
      cwd: directory,
      stdio: 'inherit',
      timeout: 30_000,
    });
    console.log(
      `Release ${metadata.version} passed isolated npm installation, CLI evaluation, persisted report, SQLite, schemas, and dashboard checks.`,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

await checkRelease();
