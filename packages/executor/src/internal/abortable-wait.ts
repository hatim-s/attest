/**
 * Sleeps for `delayMs` unless `signal` aborts first. Each transport classifies its own aborts, so
 * the caller supplies the error to reject with; an already aborted signal rejects immediately.
 */
const abortableWait = async (
  delayMs: number,
  signal: AbortSignal | undefined,
  abortError: () => Error,
): Promise<void> => {
  if (signal?.aborted === true) throw abortError();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
};

export { abortableWait };
