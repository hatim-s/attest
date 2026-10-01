import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import type { TestProject } from 'vitest/node';

import { materializePackedRuntime } from './packed-runtime.js';

type PackedCli = {
  /** Packed archive path per workspace package name. */
  archivePaths: Record<string, string>;
  cliPath: string;
  root: string;
};

type PackedCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

declare module 'vitest' {
  export interface ProvidedContext {
    packedCli: PackedCli;
  }
}

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACKED_PACKAGE_ROOTS = [
  'packages/contracts',
  'packages/core',
  'packages/executor',
  'packages/runtime',
  'packages/local',
  'packages/web',
  'packages/cli',
] as const;

/** Packs one workspace package from its built dist and returns the archive path by name. */
const packPackage = async (
  packageRoot: string,
  archiveDirectory: string,
): Promise<[string, string]> => {
  const { stdout } = await execFileAsync(
    'bun',
    ['pm', 'pack', '--quiet', '--destination', archiveDirectory],
    { cwd: join(REPOSITORY_ROOT, packageRoot), encoding: 'utf8', timeout: 30_000 },
  );
  const archivePath = resolve(stdout.trim());
  const { stdout: manifest } = await execFileAsync(
    'tar',
    ['-xOf', archivePath, 'package/package.json'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const { name } = JSON.parse(manifest) as { name: string };
  return [name, archivePath];
};

/**
 * Packs each runtime workspace and copies its installed dependency closure into a clean prefix. The packages must already be built; `bun run test:acceptance` builds first.
 */
const createPackedCli = async (): Promise<PackedCli> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-acceptance-packed-'));
  const archiveDirectory = join(root, 'archives');
  await mkdir(archiveDirectory);
  const archivePaths: Record<string, string> = {};
  for (const packageRoot of PACKED_PACKAGE_ROOTS) {
    const [name, archivePath] = await packPackage(packageRoot, archiveDirectory);
    archivePaths[name] = archivePath;
  }
  const cliPath = await materializePackedRuntime(
    root,
    Object.fromEntries(
      PACKED_PACKAGE_ROOTS.map((packageRoot) => {
        const name = `@attest/${packageRoot.split('/')[1]}`;
        return [name, { archive: archivePaths[name]!, source: join(REPOSITORY_ROOT, packageRoot) }];
      }),
    ),
  );
  await access(cliPath, constants.X_OK);
  return { archivePaths, cliPath, root };
};

/** Vitest global setup: installs one packed CLI for every acceptance file, then removes it. */
const setup = async (project: TestProject): Promise<() => Promise<void>> => {
  const packed = await createPackedCli();
  project.provide('packedCli', packed);
  return () => rm(packed.root, { force: true, recursive: true });
};

/** Runs the installed CLI under Node and keeps stdout and the exit code of failed commands. */
const runPackedCommand = async (
  cliPath: string,
  argv: readonly string[],
  workingDirectory: string,
  timeout = 30_000,
): Promise<PackedCommandResult> => {
  try {
    const { stderr, stdout } = await execFileAsync(
      process.execPath,
      ['--no-warnings', cliPath, ...argv],
      { cwd: workingDirectory, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout },
    );
    return { exitCode: 0, stderr, stdout };
  } catch (error: unknown) {
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stderr: failure.stderr ?? '',
      stdout: failure.stdout ?? '',
    };
  }
};

export { REPOSITORY_ROOT, runPackedCommand, setup, type PackedCli, type PackedCommandResult };
