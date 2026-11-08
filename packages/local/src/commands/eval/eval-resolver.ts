import * as Effect from 'effect/Effect';

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
const resolveEvalRun = Effect.fn('resolveEvalRun')(function* (
  project: LoadedProject,
  request: EvalRunRequest,
  options: EvalResolverOptions,
) {
  return yield* Effect.try({
    try: () => resolve(project, request, options),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      if (!(cause instanceof EvalResolutionError)) return Effect.die(cause);

      const details: LocalErrorOptions = {
        cause,
      };

      if (cause.details !== undefined) {
        details.details = cause.details;
      }

      if (cause.hint !== undefined) {
        details.hint = cause.hint;
      }

      if (cause.path !== undefined) {
        details.path = cause.path;
      }

      return Effect.fail(new LocalError(cause.code, cause.message, details));
    }),
  );
});

export { resolveEvalRun, type ResolvedEvalCaseInput };
