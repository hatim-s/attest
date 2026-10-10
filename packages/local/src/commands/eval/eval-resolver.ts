import type { EvalRunRequest } from '@attest/contracts';
import {
  resolveEvalRun as resolve,
  EvalResolutionError,
  type EvalResolverOptions,
  type ResolvedEvalCaseInput,
} from '@attest/core';
import type { LoadedProject } from '../../project/project-loader/index.js';
import { LocalError, type LocalErrorOptions } from '../../errors/index.js';

/** Maps domain resolution failures into the local application's error contract. */
const resolveEvalRun = (
  project: LoadedProject,
  request: EvalRunRequest,
  options: EvalResolverOptions,
) => {
  try {
    return resolve(project, request, options);
  } catch (error) {
    if (!(error instanceof EvalResolutionError)) throw error;

    const details: LocalErrorOptions = {
      cause: error,
    };

    if (error.details !== undefined) {
      details.details = error.details;
    }

    if (error.hint !== undefined) {
      details.hint = error.hint;
    }

    if (error.path !== undefined) {
      details.path = error.path;
    }

    throw new LocalError(error.code, error.message, details);
  }
};

export { resolveEvalRun, type ResolvedEvalCaseInput };
