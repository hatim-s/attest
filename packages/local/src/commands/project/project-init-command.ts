import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PROJECT_SCHEMA_ID, type ProjectResources } from '@attest/contracts';
import { hashCanonicalContent } from '@attest/core';
import { ulid } from 'ulid';
import { errnoCode } from '../../internal/errno-code.js';
import { LocalError } from '../../errors/index.js';
import { loadProject } from '../../project/project-loader/index.js';
import { prepareProjectCandidate } from '../../project/transaction/index.js';
import { registerProject } from '../../registry/index.js';
import { readCommandRequest } from '../shared/command-request.js';
import type { ProjectInitResult } from '../shared/command-result.js';
import type { Prompt } from '../shared/prompt.js';
import { publishProjectManifest, rollbackPublishedManifest } from './manifest-publish.js';

type ProjectInitCommandOptions = {
  directory?: string;
  dryRun?: boolean;
  expectedProjectHash?: string;
  fromJson?: string;
  interactive: boolean;
  name?: string;
  prompt?: Prompt;
  projectDirectory?: string;
  readStdin: () => Promise<string>;
  /** Global project registry the initialized project joins. */
  registryPath: string;
  workingDirectory: string;
  yes?: boolean;
};

/** Rejects overlapping request sources before reading stdin or applying precedence. */
const assertUnambiguousInitSources = Effect.fn('projectInit.assertUnambiguousSources')(function* (
  options: ProjectInitCommandOptions,
) {
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

    conflicts.push(...flagFields.flatMap(([field, value]) => (value === undefined ? [] : [field])));
  }

  if (conflicts.length === 0) return;
  const conflictingFields = [...new Set(conflicts)].sort();

  return yield* new LocalError('cli_usage', 'Project initialization inputs overlap.', {
    path: options.fromJson === undefined ? 'directory' : '--from-json',
    hint:
      options.fromJson === undefined
        ? 'Pass either the positional directory or `--project`, not both.'
        : 'Pass project values in either the command request or CLI flags, not both.',
    details: { conflicting_fields: conflictingFields },
  });
});

/** Resolves an existing safe target or anchors a missing target to its real parent. */
const inspectTargetDirectory = Effect.fn('projectInit.inspectTargetDirectory')(function* (
  targetDirectory: string,
) {
  const inspected = yield* Effect.gen(function* () {
    const metadata = yield* Effect.tryPromise({
      try: () => lstat(targetDirectory),
      catch: (cause) => cause,
    });

    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return yield* new LocalError(
        'init_conflict',
        'The initialization target is not a safe directory.',
        {
          path: targetDirectory,
          hint: 'Choose a real directory rather than a file or symbolic link.',
        },
      );
    }

    const root = yield* Effect.tryPromise({
      try: () => realpath(targetDirectory),
      catch: (cause) => cause,
    });

    return { exists: true, root };
  }).pipe(Effect.catch((cause) => Effect.succeed({ cause })));

  if (!('cause' in inspected)) return inspected;
  const { cause } = inspected;

  if (cause instanceof LocalError) return yield* cause;

  if (errnoCode(cause) !== 'ENOENT') {
    return yield* new LocalError('init_failed', 'Could not inspect the initialization target.', {
      path: targetDirectory,
      cause,
    });
  }

  // Both lstat and realpath can observe removal; anchor either missing target to its parent.
  const parent = yield* Effect.tryPromise({
    try: () => realpath(dirname(targetDirectory)),
    catch: (parentError) =>
      new LocalError('init_failed', 'The initialization parent directory is unavailable.', {
        path: dirname(targetDirectory),
        hint: 'Create the parent directory and verify its permissions before retrying.',
        cause: parentError,
      }),
  });

  return { exists: false, root: join(parent, basename(targetDirectory)) };
});

/** Checks one path while preserving non-ENOENT filesystem failures. */
const pathExists = Effect.fn('projectInit.pathExists')(function* (path: string) {
  return yield* Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      errnoCode(cause) === 'ENOENT' ? Effect.succeed(false) : Effect.fail(cause),
    ),
  );
});

/** Rejects a target that already contains an Attest manifest. */
const assertUninitialized = Effect.fn('projectInit.assertUninitialized')(function* (root: string) {
  const manifestPath = join(root, 'attest.project.json');

  if (yield* pathExists(manifestPath)) {
    return yield* new LocalError(
      'init_conflict',
      'An Attest project already exists at the target.',
      {
        path: manifestPath,
        hint: 'Use `attest project show` to inspect the existing project.',
      },
    );
  }
});

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
const runProjectInitCommand = Effect.fn('runProjectInitCommand')(function* (
  options: ProjectInitCommandOptions,
) {
  yield* assertUnambiguousInitSources(options);

  const request =
    options.fromJson === undefined
      ? undefined
      : yield* readCommandRequest('project.init', options.fromJson, {
          readStdin: options.readStdin,
          workingDirectory: options.workingDirectory,
        });

  const requestedDirectory =
    options.directory ?? options.projectDirectory ?? request?.directory ?? '.';

  const inspected = yield* inspectTargetDirectory(
    resolve(options.workingDirectory, requestedDirectory),
  );

  const defaultName = basename(inspected.root);
  let name = options.name ?? request?.name;

  if (name === undefined && options.interactive) {
    if (options.prompt === undefined) {
      return yield* new LocalError('cli_missing_input', 'Interactive input is unavailable.', {
        path: '--name',
        hint: 'Pass `--name <name>` or a complete `--from-json` request.',
      });
    }

    name = (yield* options.prompt(`Project name [${defaultName}]: `)).trim() || defaultName;
  }

  name = (name ?? defaultName).trim();

  if (name.length === 0) {
    return yield* new LocalError('cli_missing_input', 'Project name cannot be empty.', {
      path: '--name',
      hint: 'Pass a non-empty project display name.',
    });
  }

  const dryRun = options.dryRun ?? request?.dry_run ?? false;
  const expectedProjectHash = options.expectedProjectHash ?? request?.if_project_hash;

  if (expectedProjectHash !== undefined) {
    return yield* new LocalError(
      'project_changed',
      'The initialization target has no project hash.',
      {
        path: '--if-project-hash',
        hint: 'Remove the stale expected hash and initialize an unclaimed directory.',
        details: { current_hash: null, expected_hash: expectedProjectHash },
      },
    );
  }

  if (inspected.exists) {
    yield* assertUninitialized(inspected.root);
  }

  const prepared = prepareProjectCandidate(emptyProject(ulid(), name));
  const manifest = prepared.files.get('attest.project.json');

  if (manifest === undefined) {
    return yield* new LocalError('internal_error', 'The project candidate omitted its manifest.');
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
      operation: 'project-init' as const,
      projectHashBefore: null,
      projectHashAfter: prepared.projectHash,
      result,
    };
  }

  const initFailure = (cause: unknown) =>
    cause instanceof LocalError
      ? cause
      : new LocalError('init_failed', 'Could not initialize the Attest project.', {
          path: inspected.root,
          hint: 'Check the target permissions and retry in an uninitialized directory.',
          cause,
          details: { staged_content_hash: hashCanonicalContent(manifest.contents) },
        });

  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      let createdDirectory = false;
      let published = false;
      // Set once the published manifest is verified. From then on the manifest stays, even if
      // registration fails, and the error tells the user to run `attest projects add`.
      let verified = false;

      // Only expected failures map to init codes. A defect keeps its Die so the CLI reports
      // `internal_error`, and the rollback below still runs for every non-success Exit.
      const primary = yield* Effect.exit(
        Effect.gen(function* () {
          if (!inspected.exists) {
            yield* Effect.tryPromise({
              try: () => mkdir(inspected.root),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }).pipe(Effect.mapError(initFailure));
            createdDirectory = true;
          }

          yield* assertUninitialized(inspected.root).pipe(Effect.mapError(initFailure));
          yield* publishProjectManifest(inspected.root, manifest.contents).pipe(
            Effect.mapError(initFailure),
          );
          published = true;

          const loaded = yield* restore(
            loadProject({ project: inspected.root }).pipe(Effect.mapError(initFailure)),
          );

          if (loaded.projectHash !== prepared.projectHash)
            return yield* new LocalError('init_failed', 'Published project verification failed.', {
              details: {
                current_hash: loaded.projectHash,
                expected_hash: prepared.projectHash,
              },
            });
          verified = true;
          // Registration runs masked, so interruption cannot split it. A registry failure keeps
          // the verified manifest, matching the documented `project init` behaviour.
          yield* registerProject({
            registryPath: options.registryPath,
            root: inspected.root,
            name: prepared.project.project.name,
            projectId: prepared.project.project.project_id,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new LocalError(
                  'registry_write_failed',
                  'The project was initialized but not registered.',
                  {
                    path: options.registryPath,
                    hint: `Run \`attest projects add ${inspected.root}\` to register it.`,
                    cause,
                  },
                ),
            ),
          );
        }),
      );

      if (Exit.isSuccess(primary)) return;

      if (verified) return yield* Effect.failCause(primary.cause);
      const releases: Exit.Exit<void, LocalError>[] = [];

      // Restoration is a release: capture every failure, defects included, as recovery work
      // while keeping both the primary and the release Cause.
      const recoveryRequired = (message: string, path: string, hint: string) =>
        Effect.catchCause((release: Cause.Cause<unknown>) =>
          Effect.fail(
            new LocalError('project_recovery_required', message, {
              path,
              hint,
              cause: Cause.combine(primary.cause, release),
            }),
          ),
        );

      if (published)
        releases.push(
          yield* Effect.exit(
            rollbackPublishedManifest(inspected.root, manifest.contents).pipe(
              recoveryRequired(
                'Initialization failed and the published manifest could not be rolled back.',
                join(inspected.root, 'attest.project.json'),
                'Preserve the manifest and reconcile it before retrying.',
              ),
            ),
          ),
        );

      if (createdDirectory)
        releases.push(
          yield* Effect.exit(
            Effect.tryPromise({
              try: () => rmdir(inspected.root),
              catch: (cause) => cause,
            }).pipe(
              recoveryRequired(
                'Initialization failed and the new target directory could not be removed.',
                inspected.root,
                'Preserve and inspect the target directory before retrying.',
              ),
            ),
          ),
        );

      // Recovery failures take precedence because retrying could overwrite unresolved state.
      const failedRelease = releases.find(Exit.isFailure);

      return yield* Effect.failCause(
        failedRelease !== undefined && Exit.isFailure(failedRelease)
          ? releases.reduce(
              (cause, release) =>
                Exit.isFailure(release) && release !== failedRelease
                  ? Cause.combine(cause, release.cause)
                  : cause,
              Cause.combine(failedRelease.cause, primary.cause),
            )
          : primary.cause,
      );
    }),
  );

  return {
    operation: 'project-init' as const,
    projectHashBefore: null,
    projectHashAfter: prepared.projectHash,
    result,
  };
});

export { runProjectInitCommand, type ProjectInitCommandOptions };
