import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, link, mkdir, open, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  COMMAND_REQUEST_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  commandRequestSchema,
  type CommandRequest,
  type ProjectResources,
} from '@attest/contracts';

import { AttestCliError } from '../../errors.js';
import { hashCanonicalContent, type JsonValue } from '../../project/canonical-project.js';
import { loadProject } from '../../project/load-project.js';
import { prepareProjectCandidate } from '../../project/transaction/index.js';
import type { CommandResult } from '../command-result.js';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

type ProjectInitRequest = Extract<CommandRequest, { command: 'project.init' }>;

type ProjectInitCommandOptions = {
  createProjectId?: () => string;
  directory?: string;
  dryRun?: boolean;
  expectedProjectHash?: string;
  fromJson?: string;
  interactive: boolean;
  name?: string;
  prompt?: (question: string) => Promise<string>;
  publishObserver?: () => Promise<void> | void;
  readStdin: () => Promise<string>;
  workingDirectory: string;
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
      hint: `Provide one ${COMMAND_REQUEST_SCHEMA_VERSION} document.`,
      cause: error,
    });
  }
  const parsed = commandRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttestCliError('cli_usage', 'The command request does not match its schema.', {
      path: '--from-json',
      hint: `Provide one ${COMMAND_REQUEST_SCHEMA_VERSION} project.init document.`,
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
    schema: PROJECT_SCHEMA_VERSION,
    project_id: projectId,
    name,
    resources: { agents: [], datasets: [], metrics: [], tests: [] },
  },
  tests: [],
});

/** Publishes the empty-project manifest as one atomic, no-overwrite filesystem commit. */
const publishProjectManifest = async (root: string, contents: string): Promise<void> => {
  const manifestPath = join(root, 'attest.project.json');
  const temporaryPath = join(root, `.attest-project-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o644);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  let published = false;
  try {
    // Hard-link publication fails rather than replacing a manifest created by a racing process.
    await link(temporaryPath, manifestPath);
    published = true;
    await unlink(temporaryPath);
    const directoryHandle = await open(root, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    if (published) {
      await unlink(manifestPath).catch(() => undefined);
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

const rollbackPublishedManifest = async (root: string, expectedContents: string): Promise<void> => {
  const manifestPath = join(root, 'attest.project.json');
  try {
    if ((await readFile(manifestPath, 'utf8')) === expectedContents) {
      await unlink(manifestPath);
    }
  } catch (error: unknown) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
};

/** Initializes one canonical v2 project from flags, stdin, or a guided TTY prompt. */
const runProjectInitCommand = async (
  options: ProjectInitCommandOptions,
): Promise<CommandResult> => {
  const request =
    options.fromJson === undefined
      ? undefined
      : await readProjectInitRequest(options.fromJson, options.workingDirectory, options.readStdin);
  const requestedDirectory = options.directory ?? request?.directory ?? '.';
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
    await publishProjectManifest(inspected.root, manifest.contents);
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
        await rollbackPublishedManifest(inspected.root, manifest.contents);
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
      await rmdir(inspected.root).catch(() => undefined);
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

export { createProjectId, runProjectInitCommand, type ProjectInitCommandOptions };
