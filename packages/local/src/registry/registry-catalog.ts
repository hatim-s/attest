import * as Effect from 'effect/Effect';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { StoreError, type ProjectCatalog, type RunSource } from '@attest/core';

import { storeDecode } from '../store/internal/store-effect.js';
import { activityBounds } from '../store/internal/dashboard-boundary.js';
import { errnoCode } from '../internal/errno-code.js';
import { openReadonlyRunStore, type StoreScope } from '../store/index.js';
import { readRegistry, type RegistryEntry } from './project-registry.js';

const runNotFound = (runId: string) =>
  Effect.fail(new StoreError('RUN_NOT_FOUND', `Run ${runId} was not found.`));

const emptySource: RunSource = {
  getProjectOverview: () =>
    Effect.succeed({
      evals: { items: [] },
      runningRunCount: 0,
      runningRunCountTruncated: false,
      lastRunAt: null,
    }),
  listEvals: () => Effect.succeed({ items: [] }),
  listEvalRuns: () => Effect.succeed({ items: [] }),
  getEvalCaseWindow: () => Effect.succeed({ runs: [], items: [] }),
  getCaseHistory: () => Effect.succeed({ items: [] }),
  getActivity: (query) =>
    storeDecode('Invalid activity interval.', () => {
      const { from, to } = activityBounds(query);

      return {
        coveredFrom: from,
        coveredTo: to,
        timezone: 'UTC' as const,
        days: [],
        truncated: false,
      };
    }),
  listRunSuites: runNotFound,
  listRuns: () => Effect.succeed({ items: [] }),
  getRun: runNotFound,
  listCaseSummaries: runNotFound,
  getCase: runNotFound,
  getRunWithCases: runNotFound,
};

const toProjectRecord = ({ key, name, root, projectId }: RegistryEntry) => ({
  key,
  name,
  root,
  projectId,
});

/** Reads the registry afresh while the supplied owner caches successful readonly opens by path. */
const createRegistryCatalog = (
  { registryPath }: { registryPath: string },
  owner: StoreScope,
): ProjectCatalog => {
  const registry = () =>
    owner
      .run(readRegistry(registryPath))
      .pipe(
        Effect.mapError(
          (cause) =>
            new StoreError('READ_FAILED', 'The project registry could not be read.', { cause }),
        ),
      );

  return {
    listProjects: Effect.fn('catalog.listProjects')(function* () {
      return (yield* registry()).projects
        .map(toProjectRecord)
        .sort((left, right) => left.key.localeCompare(right.key));
    }),
    openProject: Effect.fn('catalog.openProject')(function* (key) {
      const entry = (yield* registry()).projects.find((candidate) => candidate.key === key);

      if (entry === undefined)
        return yield* Effect.fail(
          new StoreError('PROJECT_NOT_FOUND', `Project ${key} is not registered.`),
        );
      const path = join(entry.root, '.attest', 'runs.db');

      // Only absence observed before opening is empty. Failed opens retain schema and release evidence.
      const exists = yield* Effect.tryPromise({
        try: () => lstat(path),
        catch: (cause) => cause,
      }).pipe(
        Effect.map(() => true),
        Effect.catch((cause) =>
          errnoCode(cause) === 'ENOENT'
            ? Effect.succeed(false)
            : Effect.fail(
                new StoreError('READ_FAILED', 'Could not inspect the project store.', { cause }),
              ),
        ),
      );

      return exists ? yield* openReadonlyRunStore(path, owner) : emptySource;
    }),
  };
};

export { createRegistryCatalog };
