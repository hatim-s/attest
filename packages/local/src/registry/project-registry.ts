import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { projectKeySchema } from '@attest/core/records';
import { z } from 'zod';

import { LocalError } from '../errors/index.js';
import { errnoCode } from '../internal/errno-code.js';
import { readPrivateFile, writePrivateFile } from '../internal/private-file.js';
import { uniqueProjectKey } from './project-key.js';

const REGISTRY_SCHEMA_ID = 'attest.projects.v1';

const registryEntrySchema = z.strictObject({
  key: projectKeySchema,
  name: z.string().min(1),
  root: z.string().min(1),
  projectId: z.string().min(1).optional(),
  registeredAt: z.iso.datetime(),
});

const registrySchema = z
  .strictObject({
    schema: z.literal(REGISTRY_SCHEMA_ID),
    projects: z.array(registryEntrySchema),
  })
  .refine(
    ({ projects }) =>
      new Set(projects.map(({ key }) => key)).size === projects.length &&
      new Set(projects.map(({ root }) => root)).size === projects.length,
    { message: 'Registry keys and roots must be unique.' },
  );

type ProjectRegistry = z.infer<typeof registrySchema>;

type RegistryEntry = z.infer<typeof registryEntrySchema>;

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
const readRegistry = async (registryPath: string): Promise<ProjectRegistry> => {
  let text: string;

  try {
    text = await readPrivateFile(registryPath);
  } catch (cause: unknown) {
    if (errnoCode(cause) === 'ENOENT') return EMPTY_REGISTRY;
    throw invalidRegistry(registryPath, cause);
  }

  try {
    return registrySchema.parse(JSON.parse(text));
  } catch (cause: unknown) {
    throw invalidRegistry(registryPath, cause);
  }
};

/** Replaces the registry atomically with a private temporary file and a rename. */
const writeRegistry = async (registryPath: string, registry: ProjectRegistry): Promise<void> => {
  try {
    await writePrivateFile(registryPath, `${JSON.stringify(registry, undefined, 2)}\n`);
  } catch (cause: unknown) {
    throw new LocalError('registry_write_failed', 'Could not save the project registry.', {
      path: registryPath,
      hint: 'Check that the registry directory is writable and that no parent is a symbolic link, then retry.',
      cause,
    });
  }
};

/** Resolves an existing project directory to the realpath the registry stores. */
const resolveProjectRoot = async (root: string): Promise<string> => {
  try {
    return await realpath(root);
  } catch (cause: unknown) {
    throw new LocalError('project_read_failed', 'The project directory does not exist.', {
      path: root,
      hint: 'Pass an existing project directory.',
      cause,
    });
  }
};

/**
 * Adds a project root to the registry. Registering a root that is already present returns the
 * stored entry unchanged, including its name and key. New keys are the slug of the name,
 * deduplicated against existing keys. The name defaults to the directory basename.
 */
const registerProject = async (options: RegisterProjectOptions): Promise<RegistryEntry> => {
  const root = await resolveProjectRoot(options.root);
  const registry = await readRegistry(options.registryPath);
  const existing = registry.projects.find((entry) => entry.root === root);

  if (existing !== undefined) return existing;

  const name = options.name ?? basename(root);

  const entry: RegistryEntry = {
    key: uniqueProjectKey(name, new Set(registry.projects.map(({ key }) => key))),
    name,
    root,
    registeredAt: new Date().toISOString(),
  };

  // Absent stays absent: the entry is also a CLI JSON result, which has no `undefined`.
  if (options.projectId !== undefined) entry.projectId = options.projectId;

  await writeRegistry(options.registryPath, {
    ...registry,
    projects: [...registry.projects, entry],
  });

  return entry;
};

/**
 * Removes one entry, matched by key first and then by directory. A directory that no longer
 * exists still matches the root it was registered with.
 */
const unregisterProject = async (options: UnregisterProjectOptions): Promise<RegistryEntry> => {
  const registry = await readRegistry(options.registryPath);
  const directory = resolve(options.workingDirectory, options.keyOrRoot);
  const root = await realpath(directory).catch(() => directory);

  const entry =
    registry.projects.find(({ key }) => key === options.keyOrRoot) ??
    registry.projects.find((candidate) => candidate.root === root);

  if (entry === undefined) {
    throw new LocalError(
      'resource_not_found',
      `No registered project matches ${options.keyOrRoot}.`,
      {
        path: options.keyOrRoot,
        hint: 'Run `attest projects list` and pass a listed key or root.',
      },
    );
  }

  await writeRegistry(options.registryPath, {
    ...registry,
    projects: registry.projects.filter(({ key }) => key !== entry.key),
  });

  return entry;
};

export {
  readRegistry,
  registerProject,
  unregisterProject,
  type ProjectRegistry,
  type RegisterProjectOptions,
  type RegistryEntry,
  type UnregisterProjectOptions,
};
