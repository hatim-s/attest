import { valueFromExit } from '../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import {
  applyProjectMutation,
  type ProjectMutationRequest,
  type ProjectMutationResult,
} from '../../project/transaction/index.js';

type PreparedProjectMutation = Omit<ProjectMutationRequest, 'dryRun'>;

type ExecuteProjectMutationOptions = {
  confirm?: (preview: ProjectMutationResult) => Promise<void> | void;
  dryRun: boolean;
  mutation: PreparedProjectMutation;
};

/**
 * Previews one complete project mutation and publishes only the exact project state that was
 * reviewed. Dry runs remain write-free; committed writes recheck the preview hash under the lock.
 */
const executeProjectMutation = async (
  options: ExecuteProjectMutationOptions,
): Promise<ProjectMutationResult> => {
  // EFFECT-BRIDGE(S8b)
  const preview = await Effect.runPromiseExit(
    applyProjectMutation({ ...options.mutation, dryRun: true }),
  ).then((exit) => valueFromExit(exit));

  if (options.dryRun) return preview;

  await options.confirm?.(preview);

  // EFFECT-BRIDGE(S8b)
  return Effect.runPromiseExit(
    applyProjectMutation({
      ...options.mutation,
      dryRun: false,
      expectedProjectHash: preview.projectHashBefore,
    }),
  ).then((exit) => valueFromExit(exit));
};

export { executeProjectMutation };
