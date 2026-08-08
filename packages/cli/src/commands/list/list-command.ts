import type { RunRecord } from '@attest/core';

import type { JsonValue } from '../../project/canonical-project.js';
import type { LoadedProject } from '../../project/load-project.js';
import type { CommandResult } from '../command-result.js';
import { loadCommandProject } from '../project/load-command-project.js';
import { withReadonlyRunStore } from '../run-store/readonly-run-store.js';

type ListResourceType = 'agents' | 'datasets' | 'metrics' | 'runs' | 'tests';

type ListCommandOptions = {
  project?: string;
  resourceType: ListResourceType;
  workingDirectory: string;
};

/** Removes the persisted config document from generic run inspection output. */
const toSafeRunSummary = (run: RunRecord): JsonValue => ({
  id: run.id,
  createdAt: run.createdAt,
  status: run.status,
  configVersion: run.configVersion,
  configHash: run.configHash,
  ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  ...(run.gitSha === undefined ? {} : { gitSha: run.gitSha }),
  ...(run.gitBranch === undefined ? {} : { gitBranch: run.gitBranch }),
  ...(run.labels === undefined ? {} : { labels: run.labels }),
  ...(run.summary === undefined
    ? {}
    : {
        summary: {
          totalCases: run.summary.totalCases,
          passedCases: run.summary.passedCases,
          failedCases: run.summary.failedCases,
          errorCases: run.summary.errorCases,
          metricErrorCount: run.summary.metricErrorCount,
        },
      }),
});

const listRuns = async (project: LoadedProject): Promise<JsonValue[]> => {
  return (
    (await withReadonlyRunStore(project.root, async (store) =>
      (await store.listRuns()).map(toSafeRunSummary),
    )) ?? []
  );
};

const listResourceSummaries = async (
  project: LoadedProject,
  resourceType: ListResourceType,
): Promise<JsonValue[]> => {
  if (resourceType === 'runs') {
    return await listRuns(project);
  }
  if (resourceType === 'agents') {
    return project.agents.map(({ id, name, schema, transport }) => ({
      id,
      name,
      schema,
      transport: transport.kind,
    }));
  }
  if (resourceType === 'tests') {
    return project.tests.map(({ agent_id, cases, datasets, id, metrics, name, schema }) => ({
      id,
      name,
      schema,
      agent_id,
      case_count: cases.length,
      dataset_count: datasets.length,
      metric_count: metrics.length,
    }));
  }
  if (resourceType === 'datasets') {
    return project.datasets.map(({ metadata }) => ({
      id: metadata.id,
      name: metadata.name,
      schema: metadata.schema,
      case_count: metadata.case_count,
    }));
  }
  return project.metrics.map(({ definition, id, name, schema }) => ({
    id,
    name,
    schema,
    kind: definition.kind,
  }));
};

/** Lists deterministic resource summaries without creating missing local state. */
const runListCommand = async (options: ListCommandOptions): Promise<CommandResult> => {
  const project = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  const items = await listResourceSummaries(project, options.resourceType);
  const human =
    items.length === 0
      ? `No ${options.resourceType}.`
      : items
          .map((item) => {
            const value = item as Record<string, JsonValue>;
            const id = typeof value.id === 'string' ? value.id : '';
            return `  ${id}${typeof value.name === 'string' ? `  ${value.name}` : ''}`;
          })
          .join('\n');
  return {
    human,
    projectHashBefore: project.projectHash,
    projectHashAfter: project.projectHash,
    result: { resource_type: options.resourceType, items },
  };
};

export { runListCommand, toSafeRunSummary, type ListCommandOptions, type ListResourceType };
