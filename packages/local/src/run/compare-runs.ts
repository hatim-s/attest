import { resolve } from 'node:path';

import { diffRuns, type RunDiff } from '@attest/core';

import { withReadonlyRunStoreFile } from '../commands/run-store/readonly-run-store.js';
import { withRunNotFound } from '../commands/run-store/run-not-found.js';
import { LocalError } from '../errors/index.js';

type CompareLocalRunsOptions = {
  baseRunId: string;
  candidateRunId: string;
  storePath?: string;
  workingDirectory: string;
};

/** Compares a consistent store snapshot without creating or migrating the source database. */
const compareLocalRuns = async (options: CompareLocalRunsOptions): Promise<RunDiff> => {
  const configuredStorePath = options.storePath ?? '.attest/runs.db';
  const storePath = resolve(options.workingDirectory, configuredStorePath);
  const diff = await withRunNotFound(
    () =>
      withReadonlyRunStoreFile(storePath, (store) =>
        diffRuns(store, options.baseRunId, options.candidateRunId),
      ),
    (error) => new LocalError('resource_not_found', error.message, { cause: error }),
  );
  if (diff === undefined) {
    throw new LocalError('resource_not_found', 'The run store does not exist.', {
      path: storePath,
    });
  }
  return diff;
};

export { compareLocalRuns, type CompareLocalRunsOptions };
