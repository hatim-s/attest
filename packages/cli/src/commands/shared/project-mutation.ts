import {
  applyProjectMutation,
  type ProjectMutationRequest,
  type ProjectMutationResult,
  type PublishObserver,
} from '../../project/transaction/index.js';

type PreparedProjectMutation = Omit<ProjectMutationRequest, 'dryRun'>;

type ExecuteProjectMutationOptions = {
  confirm?: (preview: ProjectMutationResult) => Promise<void> | void;
  dryRun: boolean;
  mutation: PreparedProjectMutation;
  publishObserver?: PublishObserver;
};

/**
 * Previews one complete project mutation and publishes only the exact project state that was
 * reviewed. Dry runs remain write-free; committed writes recheck the preview hash under the lock.
 */
const executeProjectMutation = async (
  options: ExecuteProjectMutationOptions,
): Promise<ProjectMutationResult> => {
  const preview = await applyProjectMutation({ ...options.mutation, dryRun: true });
  if (options.dryRun) return preview;

  await options.confirm?.(preview);
  return applyProjectMutation(
    {
      ...options.mutation,
      dryRun: false,
      expectedProjectHash: preview.projectHashBefore,
    },
    { publishObserver: options.publishObserver },
  );
};

export { executeProjectMutation, type ExecuteProjectMutationOptions, type PreparedProjectMutation };
