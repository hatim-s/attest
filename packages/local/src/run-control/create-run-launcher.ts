import { COMMAND_REQUEST_SCHEMA_ID, evalCancelRequestSchema } from '@attest/contracts';
import { StoreError, type ProjectCatalog, type RunControl } from '@attest/core';

import { LocalError } from '../errors/local-error.js';
import { cancelConfiguration } from '../run/run-configuration.js';
import { toEvalRunDocument } from './eval-run-document.js';
import { listProjectTests } from './list-project-tests.js';
import { spawnEvalRun, type CliCommand } from './spawn-eval-run.js';

type RunLauncherOptions = {
  catalog: ProjectCatalog;
  /** The attest CLI to spawn for each run; `run-view-command.ts` resolves the running one. */
  command: CliCommand;
};

/** A project that does not load cannot start a run; say why in the CLI's own terms. */
const toStartFailure = (error: LocalError): StoreError => {
  const { code, message, path, hint, details } = error;

  return new StoreError('RUN_START_FAILED', message, {
    cause: error,
    details: { code, message, path, hint, details },
  });
};

/**
 * Starts runs by spawning the attest CLI in the project root and cancels them through the
 * cross-process cancellation registry, so the dashboard can cancel runs a terminal started.
 * Every catalog project with a local root can be controlled.
 */
const createRunLauncher = ({ catalog, command }: RunLauncherOptions): RunControl => {
  const projectRoot = async (projectKey: string): Promise<string> => {
    const project = (await catalog.listProjects()).find(({ key }) => key === projectKey);

    if (project === undefined) {
      throw new StoreError('PROJECT_NOT_FOUND', `Project ${projectKey} is not served here.`);
    }

    if (project.root === undefined) {
      throw new StoreError(
        'CONTROL_UNAVAILABLE',
        `Project ${projectKey} has no local directory to run in.`,
      );
    }

    return project.root;
  };

  return {
    listTests: async (projectKey) => {
      const root = await projectRoot(projectKey);

      try {
        return await listProjectTests(root);
      } catch (error: unknown) {
        if (error instanceof LocalError) throw toStartFailure(error);

        throw error;
      }
    },
    startRun: async (projectKey, request) =>
      spawnEvalRun({
        command,
        projectRoot: await projectRoot(projectKey),
        document: toEvalRunDocument(request),
      }),
    cancelRun: async (projectKey, runId) => {
      const root = await projectRoot(projectKey);
      // Run ids name registry files; anything but a run id cannot name a run.
      const parsed = evalCancelRequestSchema.shape.run_id.safeParse(runId);

      if (!parsed.success) throw new StoreError('RUN_NOT_FOUND', `Run ${runId} was not found.`);

      try {
        const { status } = await cancelConfiguration(
          {
            schema: COMMAND_REQUEST_SCHEMA_ID,
            command: 'eval.cancel',
            run_id: parsed.data,
            output: 'json',
          },
          { project: root, workingDirectory: root },
        );

        return { outcome: status };
      } catch (error: unknown) {
        if (error instanceof LocalError && error.code === 'resource_not_found') {
          throw new StoreError('RUN_NOT_FOUND', error.message, { cause: error });
        }

        throw error;
      }
    },
  };
};

export { createRunLauncher, type RunLauncherOptions };
