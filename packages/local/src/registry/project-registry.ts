import { anchoredCall } from '../internal/open-anchored.js';
import * as Effect from 'effect/Effect';
import { utcTimestampSchema } from '../internal/utc-timestamp.js';
import { parseWithSchemaSync } from '@attest/contracts';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { projectKeySchema } from '@attest/core/records';
import * as Schema from 'effect/Schema';
import { LocalError } from '../errors/index.js';
import { errnoCode } from '../internal/errno-code.js';
import { readPrivateFile, writePrivateFile } from '../internal/private-file.js';
import { uniqueProjectKey } from '../project/project-key.js';
import { withRegistryLock } from './registry-lock.js';

const REGISTRY_SCHEMA_ID = 'attest.projects.v1';

const registryEntrySchema = Schema.Struct({
  key: projectKeySchema,
  name: Schema.String.check(Schema.isMinLength(1)),
  root: Schema.String.check(
    Schema.makeFilter(isAbsolute, { message: 'Project roots must be absolute paths.' }),
  ),
  projectId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  registeredAt: utcTimestampSchema,
});

const registrySchema = Schema.Struct({
  schema: Schema.Literal(REGISTRY_SCHEMA_ID),
  projects: Schema.Array(registryEntrySchema),
}).check(
  Schema.makeFilter(
    ({ projects }) =>
      new Set(projects.map(({ key }) => key)).size === projects.length &&
      new Set(projects.map(({ root }) => root)).size === projects.length,
    { message: 'Registry keys and roots must be unique.' },
  ),
);

type ProjectRegistry = typeof registrySchema.Type;

type RegistryEntry = typeof registryEntrySchema.Type;

type RegisterProjectOptions = {
  registryPath: string;
  root: string;
  name?: string;
  projectId?: string;
};

type UnregisterProjectOptions = {
  registryPath: string;
  keyOrRoot: string;
  workingDirectory: string;
};

const EMPTY_REGISTRY: ProjectRegistry = { schema: REGISTRY_SCHEMA_ID, projects: [] };

const invalidRegistry = (registryPath: string, cause: unknown): LocalError =>
  new LocalError('registry_invalid', 'The project registry is unreadable or invalid.', {
    path: registryPath,
    hint: 'The registry must be a private file (mode 0600) and neither it nor its parent directories may be symbolic links. Fix or delete the file, then register projects again with `attest projects add <dir>`.',
    cause,
  });

/**
 * Reads the global project registry. A missing file or missing parent directory is an empty
 * registry; a symlinked ancestor, a symlinked or group-accessible file, or malformed content is
 * `registry_invalid`.
 */
const readRegistry = Effect.fn('readRegistry')(function* (registryPath: string) {
  const text = yield* readPrivateFile(registryPath).pipe(
    Effect.catch((cause) =>
      errnoCode(cause) === 'ENOENT'
        ? Effect.succeed(undefined)
        : Effect.fail(invalidRegistry(registryPath, cause)),
    ),
  );

  if (text === undefined) return EMPTY_REGISTRY;

  return yield* Effect.try({
    try: () => parseWithSchemaSync(registrySchema, JSON.parse(text)),
    catch: (cause) => invalidRegistry(registryPath, cause),
  });
});

/** Replaces the registry atomically with a private temporary file and a rename. */
const writeRegistry = Effect.fn('writeRegistry')(function* (
  registryPath: string,
  registry: ProjectRegistry,
) {
  return yield* Effect.gen(function* () {
    yield* writePrivateFile(registryPath, `${JSON.stringify(registry, undefined, 2)}\n`);
  }).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        return yield* Effect.fail(
          new LocalError('registry_write_failed', 'Could not save the project registry.', {
            path: registryPath,
            hint: 'Check that the registry directory is writable and that no parent is a symbolic link, then retry.',
            cause,
          }),
        );
      }),
    ),
  );
});

/** Resolves an existing project directory to the realpath the registry stores. */
const resolveProjectRoot = Effect.fn('resolveProjectRoot')(function* (root: string) {
  return yield* Effect.gen(function* () {
    return yield* anchoredCall('realpath', 'cloud/registry', () => realpath(root));
  }).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        return yield* Effect.fail(
          new LocalError('project_read_failed', 'The project directory does not exist.', {
            path: root,
            hint: 'Pass an existing project directory.',
            cause,
          }),
        );
      }),
    ),
  );
});

/**
 * Adds a project root to the registry. Registering a root that is already present returns the
 * stored entry unchanged, including its name and key. New keys are the slug of the name,
 * deduplicated against existing keys. The name defaults to the directory basename.
 */
const registerProject = Effect.fn('registerProject')(function* (options: RegisterProjectOptions) {
  const root = yield* resolveProjectRoot(options.root);

  return yield* withRegistryLock(
    options.registryPath,
    Effect.fn(function* () {
      const registry = yield* readRegistry(options.registryPath);
      const existing = registry.projects.find((entry) => entry.root === root);

      if (existing !== undefined) return existing;
      const name = options.name ?? basename(root);

      let entry: RegistryEntry = {
        key: uniqueProjectKey(name, new Set(registry.projects.map(({ key }) => key))),
        name,
        root,
        registeredAt: new Date().toISOString(),
      };

      // Absent stays absent: the entry is also a CLI JSON result, which has no `undefined`.
      if (options.projectId !== undefined) entry = { ...entry, projectId: options.projectId };
      yield* writeRegistry(options.registryPath, {
        ...registry,
        projects: [...registry.projects, entry],
      });

      return entry;
    }),
  );
});

/**
 * Removes one entry, matched by key first and then by directory. A directory that no longer
 * exists still matches the root it was registered with.
 */
const unregisterProject = Effect.fn('unregisterProject')(function* (
  options: UnregisterProjectOptions,
) {
  const directory = resolve(options.workingDirectory, options.keyOrRoot);

  const root = yield* anchoredCall('realpath', directory, () => realpath(directory)).pipe(
    Effect.catch(() => Effect.succeed(directory)),
  );

  return yield* withRegistryLock(
    options.registryPath,
    Effect.fn(function* () {
      const registry = yield* readRegistry(options.registryPath);

      const entry =
        registry.projects.find(({ key }) => key === options.keyOrRoot) ??
        registry.projects.find((candidate) => candidate.root === root);

      if (entry === undefined) {
        return yield* Effect.fail(
          new LocalError(
            'resource_not_found',
            `No registered project matches ${options.keyOrRoot}.`,
            {
              path: options.keyOrRoot,
              hint: 'Run `attest projects list` and pass a listed key or root.',
            },
          ),
        );
      }

      yield* writeRegistry(options.registryPath, {
        ...registry,
        projects: registry.projects.filter(({ key }) => key !== entry.key),
      });

      return entry;
    }),
  );
});

export { readRegistry, registerProject, unregisterProject, type RegistryEntry };
