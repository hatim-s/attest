import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, link, mkdir, open, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_ID,
  PROJECT_SCHEMA_ID,
  commandRequestSchema,
  type CommandRequest,
  type ProjectResources,
} from '@attest/contracts';

import { AttestCliError } from '../../errors/index.js';
import { hashCanonicalContent, type JsonValue } from '../../project/canonical-project.js';
import { loadProject } from '../../project/load-project.js';
import { prepareProjectCandidate } from '../../project/transaction/index.js';
import type { CommandResult } from '../shared/command-result.js';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

type ProjectInitRequest = Extract<CommandRequest, { command: 'project.init' }>;

type ProjectInitFileStep =
  | 'directory_close'
  | 'directory_open'
  | 'directory_sync'
  | 'manifest_link'
  | 'rollback_manifest_unlink'
  | 'temporary_close'
  | 'temporary_open'
  | 'temporary_sync'
  | 'temporary_unlink'
  | 'temporary_write';

type ProjectInitCommandOptions = {
  createProjectId?: () => string;
  directory?: string;
  dryRun?: boolean;
  expectedProjectHash?: string;
  faultInjector?: (step: ProjectInitFileStep) => Promise<void> | void;
  fromJson?: string;
  interactive: boolean;
  name?: string;
  prompt?: (question: string) => Promise<string>;
  projectDirectory?: string;
  publishObserver?: () => Promise<void> | void;
  readStdin: () => Promise<string>;
  workingDirectory: string;
  yes?: boolean;
};

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

/** Generates a standards-compliant time-sortable identity without adding a runtime package. */
const createProjectId = (): string => {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  randomBytes(10).copy(bytes, 6);
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    encoded = `${ULID_ALPHABET[Number(value & 31n)]}${encoded}`;
    value >>= 5n;
  }
  return encoded;
};

const requestDiagnostics = (
  issues: readonly { message: string; path: PropertyKey[] }[],
): JsonValue => issues.map(({ message, path }) => ({ message, path: `/${path.join('/')}` }));

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
  throw new AttestCliError('cli_usage', 'Project initialization inputs overlap.', {
    path: options.fromJson === undefined ? 'directory' : '--from-json',
    hint:
      options.fromJson === undefined
        ? 'Pass either the positional directory or `--project`, not both.'
        : 'Pass project values in either the command request or CLI flags, not both.',
    details: { conflicting_fields: conflictingFields },
  });
};

/** Reads one request document without reflecting its source text into failures. */
const readProjectInitRequest = async (
  source: string,
  workingDirectory: string,
  readStdin: () => Promise<string>,
): Promise<ProjectInitRequest> => {
  let text: string;
  try {
    text =
      source === '-'
        ? await readStdin()
        : await readFile(resolve(workingDirectory, source), 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', `Could not read command request from ${source}.`, {
      path: '--from-json',
      hint: 'Pass a readable JSON file or `-` for stdin.',
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new AttestCliError('cli_usage', 'The command request is not valid JSON.', {
      path: '--from-json',
      hint: `Provide one ${COMMAND_REQUEST_SCHEMA_ID} document.`,
      cause: error,
    });
  }
  const parsed = commandRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The command request does not match its schema.', {
      path: '--from-json',
      hint: `Provide one ${COMMAND_REQUEST_SCHEMA_ID} project.init document.`,
      details: { diagnostics: requestDiagnostics(parsed.error.issues) },
    });
  }
  if (parsed.data.command !== 'project.init') {
    throw new AttestCliError('cli_usage', 'The command request targets another command.', {
      path: '/command',
      hint: 'Set `command` to `project.init`.',
    });
  }
  return parsed.data;
};

const inspectTargetDirectory = async (
  targetDirectory: string,
): Promise<{ exists: boolean; root: string }> => {
  try {
    const metadata = await lstat(targetDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new AttestCliError(
        'init_conflict',
        'The initialization target is not a safe directory.',
        {
          path: targetDirectory,
          hint: 'Choose a real directory rather than a file or symbolic link.',
        },
      );
    }
    return { exists: true, root: await realpath(targetDirectory) };
  } catch (error: unknown) {
    if (error instanceof AttestCliError) {
      throw error;
    }
    if (getErrorCode(error) !== 'ENOENT') {
      throw new AttestCliError('init_failed', 'Could not inspect the initialization target.', {
        path: targetDirectory,
        cause: error,
      });
    }
    // Resolve the existing parent before any write so symlink aliases cannot change the target root.
    try {
      const parent = await realpath(dirname(targetDirectory));
      return { exists: false, root: join(parent, basename(targetDirectory)) };
    } catch (parentError: unknown) {
      throw new AttestCliError(
        'init_failed',
        'The initialization parent directory is unavailable.',
        {
          path: dirname(targetDirectory),
          hint: 'Create the parent directory and verify its permissions before retrying.',
          cause: parentError,
        },
      );
    }
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const assertUninitialized = async (root: string): Promise<void> => {
  const manifestPath = join(root, 'attest.project.json');
  if (await pathExists(manifestPath)) {
    throw new AttestCliError('init_conflict', 'An Attest project already exists at the target.', {
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

const injectFileFault = async (
  faultInjector: ProjectInitCommandOptions['faultInjector'],
  step: ProjectInitFileStep,
): Promise<void> => {
  await faultInjector?.(step);
};

/** Fsyncs a directory entry after manifest publication or rollback. */
const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Publishes the empty-project manifest as one atomic, no-overwrite filesystem commit. */
const publishProjectManifest = async (
  root: string,
  contents: string,
  faultInjector?: ProjectInitCommandOptions['faultInjector'],
): Promise<void> => {
  const manifestPath = join(root, 'attest.project.json');
  const temporaryPath = join(root, `.attest-project-${randomUUID()}.tmp`);
  let temporaryHandle;
  let directoryHandle;
  let temporaryExists = false;
  let manifestPublished = false;
  try {
    await injectFileFault(faultInjector, 'temporary_open');
    temporaryHandle = await open(temporaryPath, 'wx', 0o644);
    temporaryExists = true;
    await injectFileFault(faultInjector, 'temporary_write');
    await temporaryHandle.writeFile(contents, 'utf8');
    await injectFileFault(faultInjector, 'temporary_sync');
    await temporaryHandle.sync();
    await injectFileFault(faultInjector, 'temporary_close');
    await temporaryHandle.close();
    temporaryHandle = undefined;
    // Hard-link publication fails rather than replacing a manifest created by a racing process.
    await injectFileFault(faultInjector, 'manifest_link');
    await link(temporaryPath, manifestPath);
    manifestPublished = true;
    await injectFileFault(faultInjector, 'temporary_unlink');
    await unlink(temporaryPath);
    temporaryExists = false;
    await injectFileFault(faultInjector, 'directory_open');
    directoryHandle = await open(root, 'r');
    await injectFileFault(faultInjector, 'directory_sync');
    await directoryHandle.sync();
    await injectFileFault(faultInjector, 'directory_close');
    await directoryHandle.close();
    directoryHandle = undefined;
  } catch (error: unknown) {
    await directoryHandle?.close().catch(() => undefined);
    await temporaryHandle?.close().catch(() => undefined);
    let cleanupFailure: unknown;
    if (temporaryExists) {
      try {
        await unlink(temporaryPath);
      } catch (unlinkError: unknown) {
        if (getErrorCode(unlinkError) !== 'ENOENT') cleanupFailure = unlinkError;
      }
    }
    if (manifestPublished) {
      try {
        await injectFileFault(faultInjector, 'rollback_manifest_unlink');
        await unlink(manifestPath);
        await syncDirectory(root);
      } catch (rollbackError: unknown) {
        cleanupFailure = rollbackError;
      }
    }
    if (cleanupFailure !== undefined) {
      throw new AttestCliError(
        'project_recovery_required',
        'Initialization failed and temporary publication state could not be removed.',
        {
          path: manifestPath,
          hint: 'Preserve the target directory and reconcile its manifest and temporary files.',
          cause: cleanupFailure,
        },
      );
    }
    if (getErrorCode(error) === 'EEXIST') {
      throw new AttestCliError('init_conflict', 'Another process initialized this project first.', {
        path: manifestPath,
        hint: 'Inspect the existing project before retrying.',
        cause: error,
      });
    }
    throw error;
  }
};

/** Removes only the exact manifest published by this initialization attempt. */
const rollbackPublishedManifest = async (
  root: string,
  expectedContents: string,
  faultInjector?: ProjectInitCommandOptions['faultInjector'],
): Promise<void> => {
  const manifestPath = join(root, 'attest.project.json');
  try {
    if ((await readFile(manifestPath, 'utf8')) !== expectedContents) {
      throw new AttestCliError(
        'project_recovery_required',
        'The published manifest changed before initialization rollback.',
        { path: manifestPath },
      );
    }
    await injectFileFault(faultInjector, 'rollback_manifest_unlink');
    await unlink(manifestPath);
    await syncDirectory(root);
  } catch (error: unknown) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
};

/** Initializes one canonical project from flags, stdin, or a guided TTY prompt. */
const runProjectInitCommand = async (
  options: ProjectInitCommandOptions,
): Promise<CommandResult> => {
  assertUnambiguousInitSources(options);
  const request =
    options.fromJson === undefined
      ? undefined
      : await readProjectInitRequest(options.fromJson, options.workingDirectory, options.readStdin);
  const requestedDirectory =
    options.directory ?? options.projectDirectory ?? request?.directory ?? '.';
  const inspected = await inspectTargetDirectory(
    resolve(options.workingDirectory, requestedDirectory),
  );
  const defaultName = basename(inspected.root);
  let name = options.name ?? request?.name;
  if (name === undefined && options.interactive) {
    if (options.prompt === undefined) {
      throw new AttestCliError('cli_missing_input', 'Interactive input is unavailable.', {
        path: '--name',
        hint: 'Pass `--name <name>` or a complete `--from-json` request.',
      });
    }
    name = (await options.prompt(`Project name [${defaultName}]: `)).trim() || defaultName;
  }
  name = (name ?? defaultName).trim();
  if (name.length === 0) {
    throw new AttestCliError('cli_missing_input', 'Project name cannot be empty.', {
      path: '--name',
      hint: 'Pass a non-empty project display name.',
    });
  }

  const dryRun = options.dryRun ?? request?.dry_run ?? false;
  const expectedProjectHash = options.expectedProjectHash ?? request?.if_project_hash;
  if (expectedProjectHash !== undefined) {
    throw new AttestCliError('project_changed', 'The initialization target has no project hash.', {
      path: '--if-project-hash',
      hint: 'Remove the stale expected hash and initialize an unclaimed directory.',
      details: { current_hash: null, expected_hash: expectedProjectHash },
    });
  }
  if (inspected.exists) {
    await assertUninitialized(inspected.root);
  }

  const prepared = prepareProjectCandidate(
    emptyProject((options.createProjectId ?? createProjectId)(), name),
  );
  const manifest = prepared.files.get('attest.project.json');
  if (manifest === undefined) {
    throw new AttestCliError('internal_error', 'The project candidate omitted its manifest.');
  }
  const result: JsonValue = {
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
      human: `Dry run: would initialize Attest project "${name}" in ${inspected.root}.\nProject hash: ${prepared.projectHash}`,
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
    await publishProjectManifest(inspected.root, manifest.contents, options.faultInjector);
    published = true;
    await options.publishObserver?.();
    const loaded = await loadProject({ project: inspected.root });
    if (loaded.projectHash !== prepared.projectHash) {
      throw new AttestCliError('init_failed', 'Published project verification failed.', {
        details: { current_hash: loaded.projectHash, expected_hash: prepared.projectHash },
      });
    }
  } catch (error: unknown) {
    if (published) {
      try {
        await rollbackPublishedManifest(inspected.root, manifest.contents, options.faultInjector);
      } catch (rollbackError: unknown) {
        throw new AttestCliError(
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
        throw new AttestCliError(
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
    if (error instanceof AttestCliError) {
      throw error;
    }
    throw new AttestCliError('init_failed', 'Could not initialize the Attest project.', {
      path: inspected.root,
      hint: 'Check the target permissions and retry in an uninitialized directory.',
      cause: error,
      details: { staged_content_hash: hashCanonicalContent(manifest.contents) },
    });
  }

  return {
    human: `Initialized Attest project "${name}" in ${inspected.root}.\nProject hash: ${prepared.projectHash}`,
    projectHashBefore: null,
    projectHashAfter: prepared.projectHash,
    result,
  };
};

export {
  createProjectId,
  runProjectInitCommand,
  type ProjectInitCommandOptions,
  type ProjectInitFileStep,
};
