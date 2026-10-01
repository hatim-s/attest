import type {
  CommandResult,
  ProjectShowResult,
  ProjectValidateResult,
} from '../shared/command-result.js';
import { loadCommandProject } from './load-command-project.js';

type ProjectInspectionOptions = {
  project?: string;
  workingDirectory: string;
};

/** Returns the canonical manifest and committed hash for project inspection. */
const runProjectShowCommand = async (
  options: ProjectInspectionOptions,
): Promise<CommandResult<'project-show', ProjectShowResult>> => {
  const loaded = await loadCommandProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  return {
    operation: 'project-show',
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: {
      root: loaded.root,
      project_hash: loaded.projectHash,
      project: loaded.project,
    },
  };
};

/** Validates every authored resource and reports the aggregate project counts. */
const runProjectValidateCommand = async (
  options: ProjectInspectionOptions,
): Promise<CommandResult<'project-validate', ProjectValidateResult>> => {
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
    operation: 'project-validate',
    projectHashBefore: loaded.projectHash,
    projectHashAfter: loaded.projectHash,
    result: { valid: true, project_hash: loaded.projectHash, counts },
  };
};

export { runProjectShowCommand, runProjectValidateCommand, type ProjectInspectionOptions };
