type CleanupStep = () => Promise<void>;

/**
 * Attempts every cleanup step even after one fails, so a failed close never leaves copied data
 * or an open descriptor behind, then throws the first cleanup failure.
 */
const runCleanupSteps = async (steps: readonly CleanupStep[]): Promise<void> => {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
};

/**
 * Attempts every cleanup step after a primary failure and rethrows that primary failure. Cleanup
 * failures are dropped because the primary failure explains why the operation stopped.
 */
const rethrowAfterCleanup = async (
  failure: unknown,
  steps: readonly CleanupStep[],
): Promise<never> => {
  await runCleanupSteps(steps).catch(() => undefined);
  throw failure;
};

export { rethrowAfterCleanup, runCleanupSteps, type CleanupStep };
