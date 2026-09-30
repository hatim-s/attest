/**
 * Runs one command with SIGINT and SIGTERM turned into an abort signal. The listeners are removed
 * afterwards so an embedding process keeps its own signal handling.
 */
const withProcessSignals = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await run(controller.signal);
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
};

export { withProcessSignals };
