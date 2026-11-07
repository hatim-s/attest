import { LocalError } from '../../errors/index.js';
import * as Effect from 'effect/Effect';
import {
  applyProjectMutation,
  type ProjectMutationRequest,
  type ProjectMutationResult,
} from '../../project/transaction/index.js';

type PreparedProjectMutation = Omit<ProjectMutationRequest, 'dryRun'>;

type ExecuteProjectMutationOptions = {
  confirm?: (preview: ProjectMutationResult) => Effect.Effect<void, LocalError>;
  dryRun: boolean;
  mutation: PreparedProjectMutation;
};

/**
 * Previews one complete project mutation and publishes only the exact project state that was
 * reviewed. Dry runs remain write-free; committed writes recheck the preview hash under the lock.
 */
const executeProjectMutation = Effect.fn('executeProjectMutation')(function* (
  options: ExecuteProjectMutationOptions,
) {
  try {
    const preview = yield* applyProjectMutation({ ...options.mutation, dryRun: true });

    if (options.dryRun) return preview;

    if (options.confirm !== undefined) yield* options.confirm(preview);

    return yield* applyProjectMutation({
      ...options.mutation,
      dryRun: false,
      expectedProjectHash: preview.projectHashBefore,
    });
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

export { executeProjectMutation };
