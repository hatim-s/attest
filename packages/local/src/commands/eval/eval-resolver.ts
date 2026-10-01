import type { EvalRunRequest } from '@attest/contracts';
import {
  resolveEvalRun as resolve,
  EvalResolutionError,
  type EvalResolverOptions,
  type ResolvedEvalCaseInput,
} from '@attest/core';
import type { LoadedProject } from '../../project/project-loader/index.js';
import { LocalError } from '../../errors/index.js';

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
    throw new LocalError(error.code, error.message, {
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.path === undefined ? {} : { path: error.path }),
      cause: error,
    });
  }
};
export { resolveEvalRun, type ResolvedEvalCaseInput };
