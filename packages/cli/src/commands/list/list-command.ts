import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { openStore, type RunRecord } from '@attest/core';

import { AttestCliError } from '../../errors.js';
import type { JsonValue } from '../../project/canonical-project.js';
import { loadProject, type LoadedProject } from '../../project/load-project.js';
import type { CommandResult } from '../command-result.js';

type ListResourceType = 'agents' | 'datasets' | 'metrics' | 'runs' | 'tests';

type ListCommandOptions = {
  project?: string;
  resourceType: ListResourceType;
  workingDirectory: string;
};

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

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
  const storePath = join(project.root, '.attest', 'runs.db');
  try {
    const metadata = await lstat(storePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new AttestCliError('project_read_failed', 'The project run store is not a safe file.', {
        path: storePath,
      });
    }
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const store = await openStore(storePath);
  try {
    return (await store.runs.listRuns()).map(toSafeRunSummary);
  } finally {
    await store.close();
  }
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
  const project = await loadProject({
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
