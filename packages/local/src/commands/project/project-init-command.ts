import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { PROJECT_SCHEMA_ID, type ProjectResources } from '@attest/contracts';
import { ulid } from 'ulid';

import { errnoCode } from '../../internal/errno-code.js';
import { LocalError } from '../../errors/index.js';
import { hashCanonicalContent } from '../../project/canonical-project.js';
import { loadProject } from '../../project/project-loader/index.js';
import { prepareProjectCandidate } from '../../project/transaction/index.js';
import { readCommandRequest } from '../shared/command-request.js';
import type { CommandResult, ProjectInitResult } from '../shared/command-result.js';
import { publishProjectManifest, rollbackPublishedManifest } from './manifest-publish.js';

type ProjectInitCommandOptions = {
  directory?: string;
  dryRun?: boolean;
  expectedProjectHash?: string;
  fromJson?: string;
  interactive: boolean;
  name?: string;
  prompt?: (question: string) => Promise<string>;
  projectDirectory?: string;
  readStdin: () => Promise<string>;
  workingDirectory: string;
  yes?: boolean;
};

/** Rejects overlapping request sources before reading stdin or applying precedence. */
const assertUnambiguousInitSources = (options: ProjectInitCommandOptions): void => {
  const conflicts: string[] = [];
  if (options.directory !== undefined && options.projectDirectory !== undefined) {
    conflicts.push('directory', 'project');
  }
  if (options.fromJson !== undefined) {
    const flagFields = [
      ['directory', options.directory],
      ['project', options.projectDirectory],
      ['name', options.name],
      ['dry-run', options.dryRun],
      ['if-project-hash', options.expectedProjectHash],
      ['yes', options.yes],
    ] as const;
    conflicts.push(
      ...flagFields.filter(([, value]) => value !== undefined).map(([field]) => field),
    );
  }
  if (conflicts.length === 0) return;
  const conflictingFields = [...new Set(conflicts)].sort();
  throw new LocalError('cli_usage', 'Project initialization inputs overlap.', {
    path: options.fromJson === undefined ? 'directory' : '--from-json',
    hint:
      options.fromJson === undefined
        ? 'Pass either the positional directory or `--project`, not both.'
        : 'Pass project values in either the command request or CLI flags, not both.',
    details: { conflicting_fields: conflictingFields },
  });
};

const inspectTargetDirectory = async (
  targetDirectory: string,
): Promise<{ exists: boolean; root: string }> => {
  try {
    const metadata = await lstat(targetDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new LocalError('init_conflict', 'The initialization target is not a safe directory.', {
        path: targetDirectory,
        hint: 'Choose a real directory rather than a file or symbolic link.',
      });
    }
    return { exists: true, root: await realpath(targetDirectory) };
  } catch (error: unknown) {
    if (error instanceof LocalError) {
      throw error;
    }
    if (errnoCode(error) !== 'ENOENT') {
      throw new LocalError('init_failed', 'Could not inspect the initialization target.', {
        path: targetDirectory,
        cause: error,
      });
    }
    // Resolve the existing parent before any write so symlink aliases cannot change the target root.
    try {
      const parent = await realpath(dirname(targetDirectory));
      return { exists: false, root: join(parent, basename(targetDirectory)) };
    } catch (parentError: unknown) {
      throw new LocalError('init_failed', 'The initialization parent directory is unavailable.', {
        path: dirname(targetDirectory),
        hint: 'Create the parent directory and verify its permissions before retrying.',
        cause: parentError,
      });
    }
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const assertUninitialized = async (root: string): Promise<void> => {
  const manifestPath = join(root, 'attest.project.json');
  if (await pathExists(manifestPath)) {
    throw new LocalError('init_conflict', 'An Attest project already exists at the target.', {
      path: manifestPath,
      hint: 'Use `attest project show` to inspect the existing project.',
    });
  }
};

const emptyProject = (projectId: string, name: string): ProjectResources => ({
  agents: [],
  datasets: [],
  metrics: [],
  project: {
    schema: PROJECT_SCHEMA_ID,
    project_id: projectId,
    name,
    resources: { agents: [], datasets: [], metrics: [], tests: [] },
  },
  tests: [],
});

/** Initializes one canonical project from flags, stdin, or a guided TTY prompt. */
const runProjectInitCommand = async (
  options: ProjectInitCommandOptions,
): Promise<CommandResult<'project-init', ProjectInitResult>> => {
  assertUnambiguousInitSources(options);
  const request =
    options.fromJson === undefined
      ? undefined
      : await readCommandRequest('project.init', options.fromJson, {
          readStdin: options.readStdin,
          workingDirectory: options.workingDirectory,
        });
  const requestedDirectory =
    options.directory ?? options.projectDirectory ?? request?.directory ?? '.';
  const inspected = await inspectTargetDirectory(
    resolve(options.workingDirectory, requestedDirectory),
  );
  const defaultName = basename(inspected.root);
  let name = options.name ?? request?.name;
  if (name === undefined && options.interactive) {
    if (options.prompt === undefined) {
      throw new LocalError('cli_missing_input', 'Interactive input is unavailable.', {
        path: '--name',
        hint: 'Pass `--name <name>` or a complete `--from-json` request.',
      });
    }
    name = (await options.prompt(`Project name [${defaultName}]: `)).trim() || defaultName;
  }
  name = (name ?? defaultName).trim();
  if (name.length === 0) {
    throw new LocalError('cli_missing_input', 'Project name cannot be empty.', {
      path: '--name',
      hint: 'Pass a non-empty project display name.',
    });
  }

  const dryRun = options.dryRun ?? request?.dry_run ?? false;
  const expectedProjectHash = options.expectedProjectHash ?? request?.if_project_hash;
  if (expectedProjectHash !== undefined) {
    throw new LocalError('project_changed', 'The initialization target has no project hash.', {
      path: '--if-project-hash',
      hint: 'Remove the stale expected hash and initialize an unclaimed directory.',
      details: { current_hash: null, expected_hash: expectedProjectHash },
    });
  }
  if (inspected.exists) {
    await assertUninitialized(inspected.root);
  }

  const prepared = prepareProjectCandidate(emptyProject(ulid(), name));
  const manifest = prepared.files.get('attest.project.json');
  if (manifest === undefined) {
    throw new LocalError('internal_error', 'The project candidate omitted its manifest.');
  }
  const result: ProjectInitResult = {
    committed: !dryRun,
    dry_run: dryRun,
    project: {
      id: prepared.project.project.project_id,
      name: prepared.project.project.name,
      root: inspected.root,
    },
    operations: [
      {
        op: 'add',
        resource: { id: prepared.project.project.project_id, type: 'project' },
        changes: [],
        new_content_hash: prepared.projectHash,
        references_added: [],
        references_removed: [],
      },
    ],
  };
  if (dryRun) {
    return {
      operation: 'project-init',
      projectHashBefore: null,
      projectHashAfter: prepared.projectHash,
      result,
    };
  }

  let createdDirectory = false;
  let published = false;
  try {
    if (!inspected.exists) {
      await mkdir(inspected.root);
      createdDirectory = true;
    }
    await assertUninitialized(inspected.root);
    await publishProjectManifest(inspected.root, manifest.contents);
    published = true;
    const loaded = await loadProject({ project: inspected.root });
    if (loaded.projectHash !== prepared.projectHash) {
      throw new LocalError('init_failed', 'Published project verification failed.', {
        details: { current_hash: loaded.projectHash, expected_hash: prepared.projectHash },
      });
    }
  } catch (error: unknown) {
    if (published) {
      try {
        await rollbackPublishedManifest(inspected.root, manifest.contents);
      } catch (rollbackError: unknown) {
        throw new LocalError(
          'project_recovery_required',
          'Initialization failed and the published manifest could not be rolled back.',
          {
            path: join(inspected.root, 'attest.project.json'),
            hint: 'Preserve the manifest and reconcile it before retrying.',
            cause: rollbackError,
          },
        );
      }
    }
    if (createdDirectory) {
      try {
        await rmdir(inspected.root);
      } catch (cleanupError: unknown) {
        throw new LocalError(
          'project_recovery_required',
          'Initialization failed and the new target directory could not be removed.',
          {
            path: inspected.root,
            hint: 'Preserve and inspect the target directory before retrying.',
            cause: cleanupError,
          },
        );
      }
    }
    if (error instanceof LocalError) {
      throw error;
    }
    throw new LocalError('init_failed', 'Could not initialize the Attest project.', {
      path: inspected.root,
      hint: 'Check the target permissions and retry in an uninitialized directory.',
      cause: error,
      details: { staged_content_hash: hashCanonicalContent(manifest.contents) },
    });
  }

  return {
    operation: 'project-init',
    projectHashBefore: null,
    projectHashAfter: prepared.projectHash,
    result,
  };
};

export { runProjectInitCommand, type ProjectInitCommandOptions };
