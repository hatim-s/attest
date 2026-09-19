import { diffRuns, StoreError, type RunDiff } from '@attest/core';

import { prepareEvalProjectFile } from '../commands/eval/eval-project-path.js';
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
  const storePath = await prepareEvalProjectFile(
    options.workingDirectory,
    options.storePath ?? '.attest/runs.db',
    {
      allowAbsolute: true,
      errorCode: 'project_read_failed',
      message: 'The comparison run store is not a safe file.',
    },
  );
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
