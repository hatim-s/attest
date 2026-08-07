import type { JsonValue } from '../../project/canonical-project.js';
import type { CommandResult } from '../command-result.js';
import { loadCommandProject } from './load-command-project.js';

type ProjectInspectionOptions = {
  project?: string;
  workingDirectory: string;
};

/** Returns the canonical manifest and committed hash for project inspection. */
const runProjectShowCommand = async (options: ProjectInspectionOptions): Promise<CommandResult> => {
  const loaded = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  return {
    human: [
      `Project ${loaded.project.name}`,
      `  id: ${loaded.project.project_id}`,
      `  root: ${loaded.root}`,
      `  hash: ${loaded.projectHash}`,
      `  agents: ${loaded.agents.length}`,
      `  tests: ${loaded.tests.length}`,
      `  datasets: ${loaded.datasets.length}`,
      `  metrics: ${loaded.metrics.length}`,
    ].join('\n'),
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: {
      root: loaded.root,
      project_hash: loaded.projectHash,
      project: loaded.project as JsonValue,
    },
  };
};

/** Validates every authored resource and reports the aggregate project counts. */
const runProjectValidateCommand = async (
  options: ProjectInspectionOptions,
): Promise<CommandResult> => {
  const loaded = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  const counts = {
    agents: loaded.agents.length,
    datasets: loaded.datasets.length,
    metrics: loaded.metrics.length,
    tests: loaded.tests.length,
  };
  return {
    human: `Project is valid.\nHash: ${loaded.projectHash}\nResources: ${counts.agents} agents, ${counts.tests} tests, ${counts.datasets} datasets, ${counts.metrics} metrics`,
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: { valid: true, project_hash: loaded.projectHash, counts },
  };
};

export { runProjectShowCommand, runProjectValidateCommand, type ProjectInspectionOptions };
