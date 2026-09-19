import { resolve } from 'node:path';

import { diffRuns, StoreError, type RunDiff } from '@attest/core';

import { withReadonlyRunStoreFile } from '../commands/run-store/readonly-run-store.js';
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
  let diff: RunDiff | undefined;
  try {
    diff = await withReadonlyRunStoreFile(storePath, (store) =>
      diffRuns(store, options.baseRunId, options.candidateRunId),
    );
  } catch (error) {
    if (error instanceof StoreError && error.code === 'RUN_NOT_FOUND') {
      throw new LocalError('resource_not_found', error.message, { cause: error });
    }
    throw error;
  }
  if (diff === undefined) {
    throw new LocalError('resource_not_found', 'The run store does not exist.', {
      path: storePath,
    });
  }
  return diff;
};

export { compareLocalRuns, type CompareLocalRunsOptions };
