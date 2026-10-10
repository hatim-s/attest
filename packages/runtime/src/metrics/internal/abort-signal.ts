/** Distinguishes the two ways a composed signal can abort. */
type AbortReason = 'timeout' | 'cancelled';

/** Keep source deadlines alive while callers retain a composed signal on Node 22.15. */
const composedSources = new WeakMap<AbortSignal, readonly AbortSignal[]>();

/** Combines optional caller cancellation with an optional deadline into the one signal a call watches. */
const composeAbortSignal = (signal?: AbortSignal, timeoutMs?: number): AbortSignal => {
  const signals: AbortSignal[] = [];

  if (signal !== undefined) {
    signals.push(signal);
  }

  if (timeoutMs !== undefined) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }

  const soleSignal = signals[0];

  if (signals.length === 1 && soleSignal !== undefined) {
    return soleSignal;
  }

  const combined = AbortSignal.any(signals);

  if (!combined.aborted) {
    // Node 22.15 keeps any() sources weakly: GC can discard a live timeout before it fires.
    // The weak key ties source ownership to the caller-held combined signal, then releases on abort.
    composedSources.set(combined, signals);
    combined.addEventListener('abort', () => composedSources.delete(combined), { once: true });
  }

  return combined;
};

/** AbortSignal.timeout aborts with a TimeoutError; any other reason came from the caller. */
const abortReasonOf = (signal: AbortSignal): AbortReason =>
  signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
    ? 'timeout'
    : 'cancelled';

export { abortReasonOf, composeAbortSignal, type AbortReason };
