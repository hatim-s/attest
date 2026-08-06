import type { z } from 'zod';

/**
 * Reports the shared exclusive-field invariant used by contract envelopes.
 */
const requireExactlyOne = (
  value: Readonly<Record<string, unknown>>,
  fieldNames: readonly [string, string],
  context: z.RefinementCtx,
): void => {
  const presentFieldCount = fieldNames.filter((fieldName) =>
    Object.hasOwn(value, fieldName),
  ).length;
  if (presentFieldCount === 1) {
    return;
  }

  context.addIssue({
    code: 'custom',
    path: [fieldNames[0]],
    message: `exactly one of ${fieldNames[0]} or ${fieldNames[1]} must be present`,
  });
};

export { requireExactlyOne };
