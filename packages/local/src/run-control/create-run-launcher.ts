import * as Effect from 'effect/Effect';
import {
  parseWithSchema,
  COMMAND_REQUEST_SCHEMA_ID,
  evalCancelRequestSchema,
} from '@attest/contracts';
import { StoreError, type ProjectCatalog, type RunControl } from '@attest/core';

import { LocalError } from '../errors/local-error.js';
import { CancellationRegistry } from '../commands/eval/eval-cancellation.js';
import { cancelConfiguration } from '../run/run-configuration.js';
import { toEvalRunDocument } from './eval-run-document.js';
import { listProjectTests } from './list-project-tests.js';
import { spawnEvalRun, START_TIMEOUT_MS, type CliCommand } from './spawn-eval-run.js';

type RunLauncherOptions = {
  catalog: ProjectCatalog;
  /** The attest CLI to spawn for each run; `run-view-command.ts` resolves the running one. */
  command: CliCommand;
};

/** Says why the project could not be loaded or changed, in the CLI's own terms. */
const toProjectUnloadable = (error: LocalError): StoreError => {
  const { code, message, path, hint, details } = error;

  return new StoreError('PROJECT_UNLOADABLE', message, {
    cause: error,
    details: { code, message, path, hint, details },
  });
};

/**
 * Maps a LocalError to `PROJECT_UNLOADABLE`. Any other failure is unexpected and becomes a defect,
 * so the API answers 500 `INTERNAL_ERROR` as the Promise launcher did.
 */
const failProjectUnloadable = (error: Error): Effect.Effect<never, StoreError> =>
  error instanceof LocalError ? Effect.fail(toProjectUnloadable(error)) : Effect.die(error);

/**
 * Starts runs by spawning the attest CLI in the project root and cancels them through the
 * cross-process cancellation registry, so the dashboard can cancel runs a terminal started.
 * Every catalog project with a local root can be controlled.
 */
const createRunLauncher = Effect.fn('createRunLauncher')(function* ({
  catalog,
  command,
}: RunLauncherOptions) {
  const cancellationRegistry = yield* CancellationRegistry;

  const projectRoot = Effect.fn('launcher.projectRoot')(function* (projectKey: string) {
    const project = (yield* catalog.listProjects()).find(({ key }) => key === projectKey);

    if (project === undefined)
      return yield* Effect.fail(
        new StoreError('PROJECT_NOT_FOUND', `Project ${projectKey} is not served here.`),
      );

    if (project.root === undefined)
      return yield* Effect.fail(
        new StoreError(
          'CONTROL_UNAVAILABLE',
          `Project ${projectKey} has no local directory to run in.`,
        ),
      );

    return project.root;
  });

  return {
    listTests: Effect.fn('launcher.listTests')(function* (projectKey) {
      const root = yield* projectRoot(projectKey);

      return yield* listProjectTests(root).pipe(Effect.catch(failProjectUnloadable));
    }),
    startRun: Effect.fn('launcher.startRun')(function* (projectKey, request) {
      const root = yield* projectRoot(projectKey);

      return yield* spawnEvalRun({
        command,
        projectRoot: root,
        document: toEvalRunDocument(request),
        startTimeoutMs: START_TIMEOUT_MS,
      });
    }, Effect.uninterruptible),
    cancelRun: Effect.fn('launcher.cancelRun')(function* (projectKey, runId) {
      const root = yield* projectRoot(projectKey);
      // Run ids name registry files; validate before resolving a registry path.
      const parsed = parseWithSchema(evalCancelRequestSchema.fields.run_id, runId);

      if (!parsed.ok)
        return yield* Effect.fail(new StoreError('RUN_NOT_FOUND', `Run ${runId} was not found.`));

      const { status } = yield* cancelConfiguration(
        {
          schema: COMMAND_REQUEST_SCHEMA_ID,
          command: 'eval.cancel',
          run_id: parsed.value,
          output: 'json',
        },
        { project: root, workingDirectory: root },
      ).pipe(
        Effect.provideService(CancellationRegistry, cancellationRegistry),
        Effect.catch((error) =>
          error instanceof LocalError && error.code === 'resource_not_found'
            ? Effect.fail(new StoreError('RUN_NOT_FOUND', error.message, { cause: error }))
            : failProjectUnloadable(error),
        ),
      );

      return { outcome: status };
    }),
  } satisfies RunControl;
});

export { createRunLauncher };
