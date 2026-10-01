/** Distinguishes the two ways a composed signal can abort. */
type AbortReason = 'timeout' | 'cancelled';

/** Combines optional caller cancellation with an optional deadline into the one signal a call watches. */
const composeAbortSignal = (signal?: AbortSignal, timeoutMs?: number): AbortSignal => {
  const signals: AbortSignal[] = [];
  if (signal !== undefined) {
    signals.push(signal);
  }
  if (timeoutMs !== undefined) {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  return AbortSignal.any(signals);
};

/** AbortSignal.timeout aborts with a TimeoutError; any other reason came from the caller. */
const abortReasonOf = (signal: AbortSignal): AbortReason =>
  signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
    ? 'timeout'
    : 'cancelled';

export { abortReasonOf, composeAbortSignal, type AbortReason };
