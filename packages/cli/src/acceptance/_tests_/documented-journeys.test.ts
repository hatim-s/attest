import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliResultSchema } from '@attest/contracts';
import { describe, expect, inject, it, onTestFinished } from 'vitest';

import { REPOSITORY_ROOT, runPackedCommand } from './packed-cli.js';

type CommandExpectation = {
  argv: string[];
  artifact_documents: Record<string, Record<string, unknown>>;
  artifacts_absent: string[];
  artifacts_present: string[];
  command: string;
  display: string;
  error_code?: string;
  exit_code: number;
  ok: boolean;
  result_schema?: string;
  tree_changes: string[];
};

type Journey = {
  commands: CommandExpectation[];
  id: string;
  seed_files: Record<string, string>;
};

type TreeSnapshot = Map<string, string>;

const JOURNEYS_PATH = fileURLToPath(
  new URL('./fixtures/documented-journeys.json', import.meta.url),
);

const readJourneys = async (): Promise<Journey[]> =>
  (JSON.parse(await readFile(JOURNEYS_PATH, 'utf8')) as { journeys: Journey[] }).journeys;

/** Hashes every file and symlink target, and records every directory, below a journey root. */
const snapshotTree = async (root: string): Promise<TreeSnapshot> => {
  const snapshot: TreeSnapshot = new Map();
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        snapshot.set(relativePath, `symlink:${await readlink(absolutePath)}`);
      } else if (entry.isDirectory()) {
        snapshot.set(`${relativePath}/`, 'directory');
        await visit(absolutePath);
      } else {
        const hash = createHash('sha256')
          .update(await readFile(absolutePath))
          .digest('hex');
        snapshot.set(relativePath, hash);
      }
    }
  };
  await visit(root);
  return snapshot;
};

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
    const artifact = JSON.parse(await readFile(join(root, path), 'utf8')) as unknown;
    expect(artifact, `${label}: ${path}`).toMatchObject(expected);
  }
};

const isInside = (root: string, path: string): boolean => {
  const relativePath = relative(root, path);
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`);
};

describe('documented journeys through the packed CLI', () => {
  it('installs packed workspace dependencies without ambient repository links', async () => {
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
      packed.cliPath,
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
    for (const journey of await readJourneys()) {
      const root = await seedJourney(journey);
      for (const command of journey.commands) {
        const treeBefore = await snapshotTree(root);
        const argv = command.argv.map((argument) => argument.replace('$NODE', process.execPath));
        const result = await runPackedCommand(packed.cliPath, argv, root);
        await assertCommand(command, result, root, treeBefore);
      }
    }
  }, 180_000);
});
