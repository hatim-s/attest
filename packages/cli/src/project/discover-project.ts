import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  ProjectLoadError,
  createLegacyV1ProjectError,
  type ProjectDiagnostic,
} from './project-errors.js';

const PROJECT_MANIFEST_FILE = 'attest.project.json' as const;
const LEGACY_CONFIG_FILES = [
  'attest.config.json',
  'attest.config.yaml',
  'attest.config.yml',
] as const;

type DiscoverProjectOptions = {
  project?: string;
  workingDirectory?: string;
};

type DiscoveredProject = {
  manifestPath: string;
  root: string;
};

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

const missingDiagnostic = (source: string, message: string): ProjectDiagnostic => ({
  code: 'source_missing',
  message,
  source,
});

/** Resolves an existing directory once so symlink aliases cannot change traversal boundaries. */
const resolveDirectory = async (directory: string, source: string): Promise<string> => {
  try {
    const resolvedDirectory = await realpath(directory);
    if (!(await stat(resolvedDirectory)).isDirectory()) {
      throw new ProjectLoadError('project_read_failed', 'Could not inspect project path.', [
        {
          code: 'source_unreadable',
          message: 'expected a directory',
          source,
        },
      ]);
    }
    return resolvedDirectory;
  } catch (error: unknown) {
    if (error instanceof ProjectLoadError) {
      throw error;
    }
    const code = getErrorCode(error);
    const diagnostic =
      code === 'ENOENT'
        ? missingDiagnostic(source, 'directory does not exist')
        : ({
            code: 'source_unreadable',
            message: 'directory is not readable',
            source,
          } satisfies ProjectDiagnostic);
    throw new ProjectLoadError('project_read_failed', 'Could not inspect project path.', [
      diagnostic,
    ]);
  }
};

/** Checks for an authored path without following it or swallowing permission failures. */
const pathExists = async (path: string, source: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw new ProjectLoadError('project_read_failed', 'Could not inspect project path.', [
      {
        code: 'source_unreadable',
        message: 'path is not readable',
        source,
      },
    ]);
  }
};

/** Finds the first historical v1 config name in deterministic precedence order. */
const findLegacyConfig = async (directory: string): Promise<string | undefined> => {
  for (const fileName of LEGACY_CONFIG_FILES) {
    if (await pathExists(join(directory, fileName), fileName)) return fileName;
  }
  return undefined;
};

/** Compares mount identities without leaking raw filesystem errors through discovery. */
const sharesDevice = async (directory: string, parent: string): Promise<boolean> => {
  try {
    const [directoryStats, parentStats] = await Promise.all([stat(directory), stat(parent)]);
    return directoryStats.dev === parentStats.dev;
  } catch {
    throw new ProjectLoadError('project_read_failed', 'Could not inspect project boundary.', [
      {
        code: 'source_unreadable',
        message: 'directory boundary is not readable',
        source: directory,
      },
    ]);
  }
};

/** Discovers a v2 project without crossing a mount or Git worktree boundary implicitly. */
const discoverProject = async (
  options: DiscoverProjectOptions = {},
): Promise<DiscoveredProject> => {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  if (options.project !== undefined) {
    const requestedRoot = await resolveDirectory(
      resolve(workingDirectory, options.project),
      options.project,
    );
    const manifestPath = join(requestedRoot, PROJECT_MANIFEST_FILE);
    if (!(await pathExists(manifestPath, PROJECT_MANIFEST_FILE))) {
      const legacyConfig = await findLegacyConfig(requestedRoot);
      if (legacyConfig !== undefined) {
        throw createLegacyV1ProjectError('project_not_found', legacyConfig);
      }
      throw new ProjectLoadError('project_not_found', 'No Attest v2 project was found.', [
        missingDiagnostic(PROJECT_MANIFEST_FILE, 'manifest does not exist in the explicit project'),
      ]);
    }
    return { manifestPath, root: requestedRoot };
  }

  let current = await resolveDirectory(workingDirectory, workingDirectory);
  while (true) {
    const manifestPath = join(current, PROJECT_MANIFEST_FILE);
    if (await pathExists(manifestPath, PROJECT_MANIFEST_FILE)) {
      return { manifestPath, root: current };
    }
    const legacyConfig = await findLegacyConfig(current);
    if (legacyConfig !== undefined) {
      throw createLegacyV1ProjectError('project_not_found', legacyConfig);
    }

    // A .git file denotes a linked worktree or submodule; a directory denotes a regular worktree.
    if (await pathExists(join(current, '.git'), '.git')) {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    if (!(await sharesDevice(current, parent))) {
      break;
    }
    current = parent;
  }

  throw new ProjectLoadError('project_not_found', 'No Attest v2 project was found.', [
    missingDiagnostic(
      PROJECT_MANIFEST_FILE,
      `manifest was not found from ${basename(workingDirectory)} to the discovery boundary`,
    ),
  ]);
};

export {
  LEGACY_CONFIG_FILES,
  PROJECT_MANIFEST_FILE,
  discoverProject,
  type DiscoverProjectOptions,
  type DiscoveredProject,
};
