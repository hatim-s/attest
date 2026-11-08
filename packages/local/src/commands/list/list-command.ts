import * as Effect from 'effect/Effect';
import type { RunRecord } from '@attest/core';

import type { LoadedProject } from '../../project/project-loader/index.js';
import type { CommandResult, ResourceListResult, RunListItem } from '../shared/command-result.js';
import { loadCommandProject } from '../project/load-command-project.js';
import { withReadonlyRunStore } from '../run-store/readonly-run-store.js';

type ListResourceType = 'agents' | 'datasets' | 'metrics' | 'runs' | 'tests';

type ListCommandOptions = {
  project?: string;
  resourceType: ListResourceType;
  workingDirectory: string;
};

/** Removes the persisted config document from generic run inspection output. */
const toSafeRunSummary = (run: RunRecord): RunListItem => {
  let assembledFields: RunListItem = {
    id: run.id,
    createdAt: run.createdAt,
    status: run.status,
    schemaId: run.schemaId,
    configHash: run.configHash,
  };

  if (run.status !== 'running') {
    assembledFields = { ...assembledFields, finishedAt: run.finishedAt };
  }

  if (run.gitSha !== undefined) {
    assembledFields = { ...assembledFields, gitSha: run.gitSha };
  }

  if (run.gitBranch !== undefined) {
    assembledFields = { ...assembledFields, gitBranch: run.gitBranch };
  }

  if (run.labels !== undefined) {
    assembledFields = { ...assembledFields, labels: run.labels };
  }

  if (run.summary !== undefined) {
    assembledFields = {
      ...assembledFields,
      summary: {
        totalCases: run.summary.totalCases,
        passedCases: run.summary.passedCases,
        failedCases: run.summary.failedCases,
        errorCases: run.summary.errorCases,
        metricErrorCount: run.summary.metricErrorCount,
      },
    };
  }

  return assembledFields;
};

const listRuns = Effect.fn('listRuns')(function* (project: LoadedProject) {
  return (
    (yield* withReadonlyRunStore(project.root, (store) =>
      Effect.gen(function* () {
        const items: RunListItem[] = [];
        let cursor: string | undefined;

        do {
          const page = yield* store.listRuns({ cursor });
          items.push(...page.items.map(toSafeRunSummary));
          cursor = page.nextCursor;
        } while (cursor !== undefined);

        return items;
      }),
    )) ?? []
  );
});

const listResourceSummaries = Effect.fn('listResourceSummaries')(function* (
  project: LoadedProject,
  resourceType: ListResourceType,
) {
  if (resourceType === 'runs') {
    return {
      resource_type: 'runs' as const,
      items: yield* listRuns(project),
    } satisfies ResourceListResult;
  }

  if (resourceType === 'agents') {
    return {
      resource_type: 'agents' as const,
      items: project.agents.map(({ id, name, schema, transport }) => ({
        id,
        name,
        schema,
        transport: transport.kind,
      })),
    } satisfies ResourceListResult;
  }

  if (resourceType === 'tests') {
    return {
      resource_type: 'tests' as const,
      items: project.tests.map(({ agent_id, cases, datasets, id, metrics, name, schema }) => ({
        id,
        name,
        schema,
        agent_id,
        case_count: cases.length,
        dataset_count: datasets.length,
        metric_count: metrics.length,
      })),
    } satisfies ResourceListResult;
  }

  if (resourceType === 'datasets') {
    return {
      resource_type: 'datasets' as const,
      items: project.datasets.map(({ metadata }) => ({
        id: metadata.id,
        name: metadata.name,
        schema: metadata.schema,
        case_count: metadata.case_count,
      })),
    } satisfies ResourceListResult;
  }

  return {
    resource_type: 'metrics' as const,
    items: project.metrics.map(({ definition, id, name, schema }) => ({
      id,
      name,
      schema,
      kind: definition.kind,
    })),
  } satisfies ResourceListResult;
});

/** Lists deterministic resource summaries without creating missing local state. */
const runListCommand = Effect.fn('runListCommand')(function* (options: ListCommandOptions) {
  const project = yield* loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });

  const result = yield* listResourceSummaries(project, options.resourceType);

  return {
    operation: 'list' as const,
    projectHashBefore: project.projectHash,
    projectHashAfter: project.projectHash,
    result,
  } satisfies CommandResult<'list', ResourceListResult>;
});

export { runListCommand, toSafeRunSummary, type ListCommandOptions, type ListResourceType };
