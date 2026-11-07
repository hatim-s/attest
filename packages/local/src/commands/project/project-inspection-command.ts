import { valueFromExit } from '../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
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
  // EFFECT-BRIDGE(S8b)
  const loaded = await Effect.runPromiseExit(
    loadCommandProject({
      project: options.project,
      workingDirectory: options.workingDirectory,
    }),
  ).then((exit) => valueFromExit(exit));

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
  // EFFECT-BRIDGE(S8b)
  const loaded = await Effect.runPromiseExit(
    loadCommandProject({
      project: options.project,
      workingDirectory: options.workingDirectory,
    }),
  ).then((exit) => valueFromExit(exit));

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
