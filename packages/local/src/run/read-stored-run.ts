import * as Effect from 'effect/Effect';
import { LocalError } from '../errors/index.js';
import { withReadonlyRunStoreFile } from '../commands/run-store/readonly-run-store.js';
import { withRunNotFound } from '../commands/run-store/run-not-found.js';

/** Reads one run from a read-only store; a missing store or run is `resource_not_found`. */
const readStoredRun = Effect.fn('readStoredRun')(function* (storePath: string, runId: string) {
  const runNotFound = (cause?: unknown): LocalError =>
    new LocalError('resource_not_found', `Eval run ${runId} was not found.`, {
      path: runId,
      cause,
    });

  const run = yield* withReadonlyRunStoreFile(storePath, (store) =>
    withRunNotFound(() => store.getRun(runId), runNotFound),
  );

  if (run === undefined) return yield* runNotFound();

  return run;
});

export { readStoredRun };
