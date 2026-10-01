/** Rejects a caller-supplied bound that would disable a cap or deadline. */
const requirePositiveInteger = (label: string, value: number): void => {
  if (Number.isSafeInteger(value) && value >= 1) return;
  throw new TypeError(`${label} must be a positive integer.`);
};

export { requirePositiveInteger };
