/**
 * Starts a monotonic duration timer so wall-clock adjustments cannot corrupt recorded runner timing.
 * This implements the deterministic timing requirement in docs/specs/agent-contract.md.
 */
const startTimer = (): (() => number) => {
  const startedAt = performance.now();
  return () => Math.max(0, performance.now() - startedAt);
};

export { startTimer };
