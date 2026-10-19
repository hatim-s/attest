import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { StoreError, type ProjectCatalog, type RunSource, type RunStore } from '@attest/core';

import { errnoCode } from '../internal/errno-code.js';
import { openReadonlyRunStore } from '../store/index.js';
import { readRegistry, type RegistryEntry } from './project-registry.js';

type RegistryCatalog = ProjectCatalog & { close: () => Promise<void> };

const runNotFound = (runId: string): Promise<never> =>
  Promise.reject(new StoreError('RUN_NOT_FOUND', `Run ${runId} was not found.`));

/** Serves a project that has never recorded a run without creating its database. */
const emptySource: RunSource = {
  listRuns: () => Promise.resolve({ items: [] }),
  getRun: runNotFound,
  listCaseSummaries: runNotFound,
  getCase: runNotFound,
  getRunWithCases: runNotFound,
};

/** Lists the registry entry as the read API's project record. */
const toProjectRecord = ({ key, name, root, projectId }: RegistryEntry) => ({
  key,
  name,
  root,
  projectId,
});

/**
 * A catalog over every registered project. The registry file is read on each call, so a project
 * added from another terminal appears without a restart. Stores open read-only on first use,
 * are never created or migrated, and stay open until `close()`; a project without a store reads
 * as empty until its first run.
 */
const createRegistryCatalog = ({ registryPath }: { registryPath: string }): RegistryCatalog => {
  // Keyed by root: a key removed and re-added for another directory must not reuse the handle.
  const opened = new Map<string, Promise<RunStore>>();

  const findEntry = async (key: string): Promise<RegistryEntry> => {
    const entry = (await readRegistry(registryPath)).projects.find(
      (candidate) => candidate.key === key,
    );

    if (entry === undefined) {
      throw new StoreError('PROJECT_NOT_FOUND', `Project ${key} is not registered.`);
    }

    return entry;
  };

  return {
    listProjects: async () =>
      (await readRegistry(registryPath)).projects
        .map(toProjectRecord)
        .sort((left, right) => left.key.localeCompare(right.key)),
    openProject: async (key) => {
      const { root } = await findEntry(key);
      const storePath = join(root, '.attest', 'runs.db');
      // Checked after the await: parallel first requests must share one handle.
      let store = opened.get(root);

      if (store === undefined) {
        store = openReadonlyRunStore(storePath);
        opened.set(root, store);
        // A failed open is not cached, so the next request retries it.
        store.catch(() => opened.delete(root));
      }

      try {
        return await store;
      } catch (error: unknown) {
        // A read-only open never creates the file, so asking after the failure cannot race it.
        const missing = await lstat(storePath).then(
          () => false,
          (cause: unknown) => errnoCode(cause) === 'ENOENT',
        );

        if (missing) return emptySource;
        throw error;
      }
    },
    close: async () => {
      const stores = await Promise.allSettled(opened.values());
      opened.clear();
      await Promise.all(
        stores.flatMap((result) => (result.status === 'fulfilled' ? [result.value.close()] : [])),
      );
    },
  };
};

export { createRegistryCatalog, type RegistryCatalog };
