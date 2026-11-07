import { LocalError } from '../../errors/index.js';
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
const runProjectShowCommand = Effect.fn('runProjectShowCommand')(function* (
  options: ProjectInspectionOptions,
) {
  try {
    const loaded = yield* loadCommandProject({
      project: options.project,
      workingDirectory: options.workingDirectory,
    });

    return {
      operation: 'project-show' as const,
      projectHashBefore: loaded.projectHash,
      projectHashAfter: loaded.projectHash,
      result: {
        root: loaded.root,
        project_hash: loaded.projectHash,
        project: loaded.project,
      },
    } satisfies CommandResult<'project-show', ProjectShowResult>;
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

/** Validates every authored resource and reports the aggregate project counts. */
const runProjectValidateCommand = Effect.fn('runProjectValidateCommand')(function* (
  options: ProjectInspectionOptions,
) {
  try {
    const loaded = yield* loadCommandProject({
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
      operation: 'project-validate' as const,
      projectHashBefore: loaded.projectHash,
      projectHashAfter: loaded.projectHash,
      result: { valid: true as const, project_hash: loaded.projectHash, counts },
    } satisfies CommandResult<'project-validate', ProjectValidateResult>;
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

export { runProjectShowCommand, runProjectValidateCommand, type ProjectInspectionOptions };
