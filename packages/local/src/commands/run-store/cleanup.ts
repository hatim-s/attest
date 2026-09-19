type CleanupFailure = {
  error: unknown;
};

type CleanupStep = () => Promise<void>;

/** Captures a thrown value without losing explicit undefined failures. */
const captureCleanupFailure = (error: unknown): CleanupFailure => ({ error });

/** Attempts every cleanup step while retaining the primary or first cleanup failure. */
const runCleanupSteps = async (
  initialFailure: CleanupFailure | undefined,
  steps: readonly CleanupStep[],
): Promise<CleanupFailure | undefined> => {
  let failure = initialFailure;
  for (const step of steps) {
    try {
      await step();
    } catch (error: unknown) {
      failure ??= captureCleanupFailure(error);
    }
  }
  return failure;
};

export { captureCleanupFailure, runCleanupSteps, type CleanupFailure, type CleanupStep };
