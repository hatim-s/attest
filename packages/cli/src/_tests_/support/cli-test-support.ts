import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cliResultSchema, type CliResult } from '@attest/contracts';
import { expect, onTestFinished } from 'vitest';

import type { CliInteraction } from '../../commands/shared/cli-interaction.js';
import type { CliIo } from '../../commands/shared/command-context.js';
import { runCli } from '../../run-cli.js';
import { writeFixtureProject } from './project-fixture.js';

type CollectedIo = {
  errors: string[];
  io: CliIo;
  output: string[];
};

type CliRun = CollectedIo & { exitCode: number };

type JsonCliRun = CliRun & { document: CliResult };

type RunOptions = {
  /** Interaction overrides on top of a non-interactive terminal. */
  interaction?: Partial<CliInteraction>;
  /** Text returned by both stdin readers. */
  stdin?: string;
};

/** Creates a temporary directory that is removed when the current test finishes. */
const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));
  return directory;
};

/** Captures stdout and stderr lines written through the CLI io. */
const collectIo = (): CollectedIo => {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    errors,
    output,
    io: { error: (message) => errors.push(message), output: (message) => output.push(message) },
  };
};

/** A terminal that is not a TTY, rejects prompts, and serves `stdin` to both stdin readers. */
const nonInteractive = (stdin = ''): Partial<CliInteraction> => ({
  ci: false,
  inputIsTTY: false,
  outputIsTTY: false,
  prompt: () => Promise.reject(new Error('prompt must not be called')),
  readStdin: () => Promise.resolve(stdin),
  readImportStdin: async function* readImportStdin() {
    yield await Promise.resolve(stdin);
  },
});

/** Runs the CLI in `root` and returns its exit code and captured output. */
const runCommand = async (
  root: string,
  argv: readonly string[],
  options: RunOptions = {},
): Promise<CliRun> => {
  const collected = collectIo();
  const exitCode = await runCli([...argv], {
    interaction: { ...nonInteractive(options.stdin), ...options.interaction },
    io: collected.io,
    workingDirectory: root,
  });
  return { ...collected, exitCode };
};

/** Runs a command with `--output json` and parses its single result document. */
const runJson = async (
  root: string,
  argv: readonly string[],
  options: RunOptions = {},
): Promise<JsonCliRun> => {
  const run = await runCommand(root, [...argv, '--output', 'json'], options);
  expect(run.errors).toEqual([]);
  expect(run.output).toHaveLength(1);
  return { ...run, document: cliResultSchema.parse(JSON.parse(run.output[0] ?? '')) };
};

/** Reads every file below `root` as base64, keyed by sorted `/`-separated relative paths. */
const snapshotTree = async (root: string): Promise<Record<string, string>> => {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relative);
      else snapshot[relative] = (await readFile(path)).toString('base64');
    }
  };
  await visit(root, '');
  return snapshot;
};

/** Initializes an empty project through `attest project init` and returns its root. */
const createEmptyProject = async (): Promise<string> => {
  const parent = await temporaryDirectory('attest-cli-project-');
  const init = await runJson(parent, ['project', 'init', 'demo', '--name', 'Demo']);
  expect(init.exitCode).toBe(0);
  return join(parent, 'demo');
};

/** Writes the shared agent, test, dataset, and metric fixture project and returns its root. */
const createFixtureProject = async (): Promise<string> => {
  const root = await temporaryDirectory('attest-cli-fixture-');
  await writeFixtureProject(root);
  return root;
};

export {
  collectIo,
  createEmptyProject,
  createFixtureProject,
  nonInteractive,
  runCommand,
  runJson,
  snapshotTree,
  temporaryDirectory,
  type CliRun,
  type JsonCliRun,
};
