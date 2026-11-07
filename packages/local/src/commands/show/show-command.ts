import { LocalError } from '../../errors/index.js';
import * as Effect from 'effect/Effect';
import type { JsonValue } from '@attest/contracts';

import type { LoadedProject } from '../../project/project-loader/index.js';
import type { CommandResult, ResourceShowResult } from '../shared/command-result.js';
import { toSafeRunSummary } from '../list/list-command.js';
import { loadCommandProject } from '../project/load-command-project.js';
import { missingResource } from '../shared/resource-lookup.js';
import { withReadonlyRunStore } from '../run-store/readonly-run-store.js';
import { withRunNotFound } from '../run-store/run-not-found.js';
import { redactAgentResource, redactMetricResource } from './redact-resource.js';

type ShowResourceType = 'agent' | 'dataset' | 'metric' | 'run' | 'test';

type ShowCommandOptions = {
  id: string;
  project?: string;
  resourceType: ShowResourceType;
  workingDirectory: string;
};

const showRun = Effect.fn('showRun')(function* (project: LoadedProject, id: string) {
  try {
    const run = yield* withRunNotFound(
      () => withReadonlyRunStore(project.root, (store) => store.getRun(id)),
      () => missingResource('run', id),
    );

    if (run === undefined) throw missingResource('run', id);

    return toSafeRunSummary(run);
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

const showResource = Effect.fn('showResource')(function* (
  project: LoadedProject,
  type: ShowResourceType,
  id: string,
) {
  try {
    if (type === 'run') {
      return yield* showRun(project, id);
    }

    if (type === 'agent') {
      const resource = project.agents.find((candidate) => candidate.id === id);

      if (resource !== undefined) return redactAgentResource(resource);
    } else if (type === 'test') {
      const resource = project.tests.find((candidate) => candidate.id === id);

      if (resource !== undefined) return resource;
    } else if (type === 'metric') {
      const resource = project.metrics.find((candidate) => candidate.id === id);

      if (resource !== undefined) return redactMetricResource(resource);
    } else {
      const resource = project.datasets.find(({ metadata }) => metadata.id === id);

      if (resource !== undefined) {
        return { metadata: resource.metadata, cases: resource.cases } satisfies JsonValue;
      }
    }

    throw missingResource(type, id);
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

/** Shows one validated canonical resource through the shared output envelope. */
const runShowCommand = Effect.fn('runShowCommand')(function* (options: ShowCommandOptions) {
  try {
    const project = yield* loadCommandProject({
      project: options.project,
      workingDirectory: options.workingDirectory,
    });

    const resource = yield* showResource(project, options.resourceType, options.id);

    return {
      operation: 'show' as const,
      projectHashBefore: project.projectHash,
      projectHashAfter: project.projectHash,
      result: { resource_type: options.resourceType, resource },
    } satisfies CommandResult<'show', ResourceShowResult>;
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

export { runShowCommand, type ShowCommandOptions, type ShowResourceType };
