import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { cliResultSchema, isJsonObject } from '@attest/contracts';
import { describe, expect, inject, it, onTestFinished } from 'vitest';

import { REPOSITORY_ROOT, runPackedCommand } from './packed-cli.js';
import {
  documentedJourneys,
  type CommandExpectation,
  type Journey,
} from './fixtures/documented-journeys.js';
import { snapshotTree, type TreeSnapshot } from './snapshot-tree.js';

const changedTreePaths = (before: TreeSnapshot, after: TreeSnapshot): string[] =>
  [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();

/** Writes the journey's seed files into a clean directory removed after the test. */
const seedJourney = async (journey: Journey): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `attest-journey-${journey.id}-`));
  onTestFinished(() => rm(root, { force: true, recursive: true }));

  for (const [path, contents] of Object.entries(journey.seed_files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }

  return root;
};

/** Checks one command's result document and the files it created, changed, or left alone. */
const assertCommand = async (
  expectation: CommandExpectation,
  result: { exitCode: number; stderr: string; stdout: string },
  root: string,
  treeBefore: TreeSnapshot,
): Promise<void> => {
  const label = expectation.display;
  expect(result.exitCode, label).toBe(expectation.exit_code);
  expect(result.stderr, label).toBe('');
  const document = cliResultSchema.parse(JSON.parse(result.stdout.trim()));
  expect(document, label).toMatchObject({ ok: expectation.ok, command: expectation.command });

  if (expectation.error_code !== undefined) {
    expect(document.ok ? undefined : document.error.code, label).toBe(expectation.error_code);
  }

  if (expectation.result_schema !== undefined) {
    expect(document.ok ? document.result : undefined, label).toMatchObject({
      schema: expectation.result_schema,
    });
  }

  if (expectation.result_verdict !== undefined) {
    expect(document.ok ? document.result : undefined, label).toMatchObject({
      verdict: expectation.result_verdict,
    });
  }

  if (expectation.result_run_id === true) {
    const runId = document.ok && isJsonObject(document.result) ? document.result.run_id : undefined;

    expect(runId, label).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
  }

  expect(changedTreePaths(treeBefore, await snapshotTree(root)), label).toEqual(
    [...expectation.tree_changes].sort(),
  );

  for (const path of expectation.artifacts_present) {
    await expect(lstat(join(root, path)), label).resolves.toBeDefined();
  }

  for (const path of expectation.artifacts_absent) {
    await expect(lstat(join(root, path)), label).rejects.toMatchObject({ code: 'ENOENT' });
  }

  for (const [path, expected] of Object.entries(expectation.artifact_documents)) {
    const artifact: unknown = JSON.parse(await readFile(join(root, path), 'utf8'));
    expect(artifact, `${label}: ${path}`).toMatchObject(expected);
  }
};

const isInside = (root: string, path: string): boolean => {
  const relativePath = relative(root, path);

  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`);
};

describe('documented journeys through the packed CLI', () => {
  it('materializes packed workspace dependencies without ambient repository links', async () => {
    const packed = inject('packedCli');
    const realRuntime = await realpath(packed.root);
    const realRepository = await realpath(REPOSITORY_ROOT);
    const nodeModules = await lstat(join(packed.root, 'node_modules'));
    expect(nodeModules.isDirectory()).toBe(true);
    expect(nodeModules.isSymbolicLink()).toBe(false);

    for (const packageName of Object.keys(packed.archivePaths)) {
      const packageRoot = await realpath(join(packed.root, 'node_modules', packageName));
      expect(isInside(realRuntime, packageRoot), packageName).toBe(true);
      expect(isInside(realRepository, packageRoot), packageName).toBe(false);
    }

    const help = await runPackedCommand(
      packed,
      ['help', 'agent', 'add', '--output', 'json'],
      packed.root,
    );

    expect(help.exitCode, help.stderr || help.stdout).toBe(0);
    expect(help.stderr).toBe('');
    expect(cliResultSchema.parse(JSON.parse(help.stdout))).toMatchObject({
      ok: true,
      command: 'help',
    });
  });

  it('runs every documented journey in a clean directory', async () => {
    const packed = inject('packedCli');

    for (const journey of documentedJourneys.journeys) {
      const root = await seedJourney(journey);

      for (const command of journey.commands) {
        const treeBefore = await snapshotTree(root);
        const argv = command.argv.map((argument) => argument.replace('$NODE', process.execPath));
        const result = await runPackedCommand(packed, argv, root);
        await assertCommand(command, result, root, treeBefore);
      }
    }
  }, 180_000);
});
