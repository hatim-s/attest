import * as Effect from 'effect/Effect';
import { anchoredCall } from '../internal/open-anchored.js';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { ProjectLoadError, type ProjectDiagnostic } from './project-errors.js';

const PROJECT_MANIFEST_FILE = 'attest.project.json' as const;

type DiscoverProjectOptions = {
  project?: string;
  workingDirectory?: string;
};

type DiscoveredProject = {
  manifestPath: string;
  root: string;
};

const missingDiagnostic = (source: string, message: string): ProjectDiagnostic => ({
  code: 'source_missing',
  message,
  source,
});

/** Resolves an existing directory once so symlink aliases cannot change traversal boundaries. */
const resolveDirectory = Effect.fn('discoverProject.resolveDirectory')(function* (
  directory: string,
  source: string,
) {
  const inspected = yield* Effect.result(
    Effect.gen(function* () {
      const resolved = yield* anchoredCall('realpath', directory, () => realpath(directory));
      const metadata = yield* anchoredCall('stat', resolved, () => stat(resolved));

      return { resolved, metadata };
    }),
  );

  if (inspected._tag === 'Failure')
    return yield* Effect.fail(
      new ProjectLoadError(
        'project_read_failed',
        'Could not inspect project path.',
        [
          inspected.failure.code === 'ENOENT'
            ? missingDiagnostic(source, 'directory does not exist')
            : { code: 'source_unreadable', message: 'directory is not readable', source },
        ],
        { cause: inspected.failure },
      ),
    );

  if (!inspected.success.metadata.isDirectory())
    return yield* Effect.fail(
      new ProjectLoadError('project_read_failed', 'Could not inspect project path.', [
        { code: 'source_unreadable', message: 'expected a directory', source },
      ]),
    );

  return inspected.success.resolved;
});

/** Distinguishes missing paths from unreadable paths without following symlinks. */
const pathExists = Effect.fn('discoverProject.pathExists')(function* (
  path: string,
  source: string,
) {
  return yield* anchoredCall('lstat', path, () => lstat(path)).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.code === 'ENOENT'
        ? Effect.succeed(false)
        : Effect.fail(
            new ProjectLoadError(
              'project_read_failed',
              'Could not inspect project path.',
              [{ code: 'source_unreadable', message: 'path is not readable', source }],
              { cause: error },
            ),
          ),
    ),
  );
});

/** Compares mount identities without exposing raw syscall errors. */
const sharesDevice = Effect.fn('discoverProject.sharesDevice')(function* (
  directory: string,
  parent: string,
) {
  return yield* Effect.gen(function* () {
    const directoryStats = yield* anchoredCall('stat', directory, () => stat(directory));
    const parentStats = yield* anchoredCall('stat', parent, () => stat(parent));

    return directoryStats.dev === parentStats.dev;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectLoadError(
          'project_read_failed',
          'Could not inspect project boundary.',
          [
            {
              code: 'source_unreadable',
              message: 'directory boundary is not readable',
              source: directory,
            },
          ],
          { cause },
        ),
    ),
  );
});

/** Discovers a project without crossing a mount or Git worktree boundary implicitly. */
const discoverProject = Effect.fn('discoverProject')(function* (
  options: DiscoverProjectOptions = {},
): Effect.fn.Return<DiscoveredProject, ProjectLoadError> {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());

  if (options.project !== undefined) {
    const requestedRoot = yield* resolveDirectory(
      resolve(workingDirectory, options.project),
      options.project,
    );

    const manifestPath = join(requestedRoot, PROJECT_MANIFEST_FILE);

    if (!(yield* pathExists(manifestPath, PROJECT_MANIFEST_FILE))) {
      return yield* Effect.fail(
        new ProjectLoadError('project_not_found', 'No Attest project was found.', [
          missingDiagnostic(
            PROJECT_MANIFEST_FILE,
            'manifest does not exist in the explicit project',
          ),
        ]),
      );
    }

    return { manifestPath, root: requestedRoot };
  }

  let current = yield* resolveDirectory(workingDirectory, workingDirectory);

  while (true) {
    const manifestPath = join(current, PROJECT_MANIFEST_FILE);

    if (yield* pathExists(manifestPath, PROJECT_MANIFEST_FILE)) {
      return { manifestPath, root: current };
    }

    // A .git file denotes a linked worktree or submodule; a directory denotes a regular worktree.
    if (yield* pathExists(join(current, '.git'), '.git')) {
      break;
    }

    const parent = dirname(current);

    if (parent === current) {
      break;
    }

    if (!(yield* sharesDevice(current, parent))) {
      break;
    }

    current = parent;
  }

  return yield* Effect.fail(
    new ProjectLoadError('project_not_found', 'No Attest project was found.', [
      missingDiagnostic(
        PROJECT_MANIFEST_FILE,
        `manifest was not found from ${basename(workingDirectory)} to the discovery boundary`,
      ),
    ]),
  );
});

export { PROJECT_MANIFEST_FILE, discoverProject, type DiscoverProjectOptions };
