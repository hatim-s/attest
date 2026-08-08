import { StoreError } from '@attest/core';

import { AttestCliError } from '../../errors.js';
import type { JsonValue } from '../../project/canonical-project.js';
import type { LoadedProject } from '../../project/load-project.js';
import type { CommandResult } from '../command-result.js';
import { toSafeRunSummary } from '../list/list-command.js';
import { loadCommandProject } from '../project/load-command-project.js';
import { withReadonlyRunStore } from '../run-store/readonly-run-store.js';
import { redactAgentResource, redactMetricResource } from './redact-resource.js';

type ShowResourceType = 'agent' | 'dataset' | 'metric' | 'run' | 'test';

type ShowCommandOptions = {
  id: string;
  project?: string;
  resourceType: ShowResourceType;
  workingDirectory: string;
};

const missingResource = (type: ShowResourceType, id: string): AttestCliError =>
  new AttestCliError('resource_not_found', `${type} ${id} was not found.`, {
    path: id,
    hint: `Run \`attest list ${type === 'run' ? 'runs' : `${type}s`}\` to inspect available ids.`,
  });

const showRun = async (project: LoadedProject, id: string): Promise<JsonValue> => {
  try {
    const run = await withReadonlyRunStore(project.root, async (store) => store.getRun(id));
    if (run === undefined) throw missingResource('run', id);
    return toSafeRunSummary(run);
  } catch (error: unknown) {
    if (error instanceof StoreError && error.code === 'RUN_NOT_FOUND') {
      throw missingResource('run', id);
    }
    throw error;
  }
};

const findResource = async (
  project: LoadedProject,
  type: ShowResourceType,
  id: string,
): Promise<JsonValue> => {
  if (type === 'run') {
    return await showRun(project, id);
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
      return { metadata: resource.metadata as JsonValue, cases: resource.cases as JsonValue };
    }
  }
  throw missingResource(type, id);
};

/** Shows one validated canonical resource through the shared output envelope. */
const runShowCommand = async (options: ShowCommandOptions): Promise<CommandResult> => {
  const project = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  const resource = await findResource(project, options.resourceType, options.id);
  return {
    human: JSON.stringify(resource, undefined, 2),
    projectHashBefore: project.projectHash,
    projectHashAfter: project.projectHash,
    result: { resource_type: options.resourceType, resource },
  };
};

export { runShowCommand, type ShowCommandOptions, type ShowResourceType };
