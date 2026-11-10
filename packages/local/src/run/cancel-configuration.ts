import * as Effect from 'effect/Effect';
import type { EvalCancelRequest } from '@attest/contracts';
import type { StoreError } from '@attest/core';
import {
  CancellationRegistry,
  signalRegisteredEvalRun,
} from '../commands/eval/eval-cancellation.js';
import { loadCommandProject } from '../commands/project/load-command-project.js';
import { LocalError } from '../errors/index.js';
import type { AnchoredCleanupFailure, AnchoredFileFailure } from '../internal/open-anchored.js';
import type { ProcessPresenceFailure } from '../internal/process-presence.js';
import { projectStorePath } from '../project/project-store-path.js';
import { readStoredRun } from './read-stored-run.js';

type CancelConfigurationOptions = {
  project?: string;
  workingDirectory: string;
};

type CancelConfigurationResult = {
  projectHash: string;
  runId: string;
  status: 'cancellation_requested' | 'already_cancelled' | 'already_terminal';
};

/** Requests cancellation through the active registry, then reports persisted terminal state. */
const cancelConfiguration = Effect.fn('cancelConfiguration')(function* (
  request: EvalCancelRequest,
  options: CancelConfigurationOptions,
): Effect.fn.Return<
  CancelConfigurationResult,
  LocalError | StoreError | AnchoredFileFailure | AnchoredCleanupFailure | ProcessPresenceFailure,
  CancellationRegistry
> {
  const project = yield* loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });

  const result = { projectHash: project.projectHash, runId: request.run_id };
  const requested = yield* signalRegisteredEvalRun(project.root, request.run_id);

  if (requested === 'cancellation_requested') return { ...result, status: requested };
  const run = yield* readStoredRun(projectStorePath(project.root), request.run_id);

  return {
    ...result,
    status: run.status === 'cancelled' ? 'already_cancelled' : 'already_terminal',
  };
});

export { cancelConfiguration, type CancelConfigurationOptions };
