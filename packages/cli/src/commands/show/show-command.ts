import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { openStore, StoreError } from '@attest/core';

import { AttestCliError } from '../../errors.js';
import type { JsonValue } from '../../project/canonical-project.js';
import { loadProject, type LoadedProject } from '../../project/load-project.js';
import type { CommandResult } from '../command-result.js';
import { toSafeRunSummary } from '../list/list-command.js';

type ShowResourceType = 'agent' | 'dataset' | 'metric' | 'run' | 'test';

type ShowCommandOptions = {
  id: string;
  project?: string;
  resourceType: ShowResourceType;
  workingDirectory: string;
};

const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;

const missingResource = (type: ShowResourceType, id: string): AttestCliError =>
  new AttestCliError('resource_not_found', `${type} ${id} was not found.`, {
    path: id,
    hint: `Run \`attest list ${type === 'run' ? 'runs' : `${type}s`}\` to inspect available ids.`,
  });

const showRun = async (project: LoadedProject, id: string): Promise<JsonValue> => {
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
      throw missingResource('run', id);
    }
    throw error;
  }

  const store = await openStore(storePath);
  try {
    const run = await store.runs.getRun(id);
    return toSafeRunSummary(run);
  } catch (error: unknown) {
    if (error instanceof StoreError && error.code === 'RUN_NOT_FOUND') {
      throw missingResource('run', id);
    }
    throw error;
  } finally {
    await store.close();
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
    if (resource !== undefined) return resource;
  } else if (type === 'test') {
    const resource = project.tests.find((candidate) => candidate.id === id);
    if (resource !== undefined) return resource;
  } else if (type === 'metric') {
    const resource = project.metrics.find((candidate) => candidate.id === id);
    if (resource !== undefined) return resource;
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
  const project = await loadProject({
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
