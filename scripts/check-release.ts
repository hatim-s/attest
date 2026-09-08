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
  try {
    await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
    const releaseDirectory = join(root, 'dist/release');
    const tarballs = (await readdir(releaseDirectory))
      .filter((file) => file.endsWith('.tgz'))
      .map((file) => join(releaseDirectory, file));
    assert.equal(tarballs.length, 5, 'Expected all five release packages.');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
      cwd: directory,
      stdio: 'inherit',
      timeout: 180_000,
    });
    const cli = join(directory, 'node_modules/.bin/attest');
    const projectDirectory = join(directory, 'demo');
    const runCli = (...args: string[]): string =>
      execFileSync(cli, args, { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    const metadata = JSON.parse(
      await readFile(join(root, 'packages/cli/package.json'), 'utf8'),
    ) as { version: string };
    assert.equal(runCli('--version').trim(), metadata.version);
    assert.match(runCli('--help'), /Usage: attest/);
    const initialized = JSON.parse(
      runCli('project', 'init', 'demo', '--name', 'Release check', '--output', 'json'),
    ) as { ok: boolean };
    assert.equal(initialized.ok, true);
    await cp(join(root, 'examples/native-cli/agent.mjs'), join(projectDirectory, 'agent.mjs'));
    await cp(join(root, 'examples/native-cli/cases.jsonl'), join(projectDirectory, 'cases.jsonl'));
    const projectCli = (...args: string[]): string =>
      execFileSync(cli, args, { cwd: projectDirectory, encoding: 'utf8', timeout: 30_000 });
    for (const args of [
      ['agent', 'add', 'support', '--argv-json', '["node","./agent.mjs"]', '--timeout', '5s'],
      ['metric', 'add', 'exact', '--preset', 'output-equals', '--value', '"refund policy"'],
      ['test', 'add', 'smoke', '--agent', 'support', '--metric', 'exact'],
      ['test', 'case', 'import', 'smoke', './cases.jsonl'],
    ]) {
      assert.equal(
        (JSON.parse(projectCli(...args, '--output', 'json')) as { ok: boolean }).ok,
        true,
      );
    }
    const evaluation = JSON.parse(projectCli('eval', 'run', 'smoke', '--output', 'json')) as {
      ok: boolean;
      result: { verdict: string; run_id: string };
    };
    assert.equal(evaluation.ok, true);
    assert.equal(evaluation.result.verdict, 'pass');
    assert.ok(evaluation.result.run_id);
    projectCli('report', evaluation.result.run_id, '--output', 'report.html');
    assert.match(await readFile(join(projectDirectory, 'report.html'), 'utf8'), /<html/);

    // Resolve only installed packages. This catches workspace symlink and missing asset mistakes.
    await writeFile(
      join(directory, 'verify.mjs'),
      `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cliResultSchema } from '@attest/contracts';
import { openStore, startViewServer } from '@attest/core';
import { dashboardHtml } from '@attest/web/embedded';
import { runCli } from '@attest/cli';
assert.equal(typeof runCli, 'function');
assert.equal(typeof cliResultSchema.parse, 'function');
assert.ok(dashboardHtml.includes('<html'));
const schema = JSON.parse(await readFile(new URL(import.meta.resolve('@attest/schemas/generated/project.json')), 'utf8'));
assert.ok(schema.$schema);
const store = await openStore('release-check.db');
assert.deepEqual(await store.runs.listRuns(), []);
await store.close();
const server = await startViewServer({ storePath: 'release-check.db', indexHtml: dashboardHtml, port: 0 });
try {
  const response = await fetch(server.url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), dashboardHtml);
} finally {
  await server.close();
}
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
