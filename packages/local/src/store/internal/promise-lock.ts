interface PromiseLock {
  acquire(): Promise<() => void>;
}

/** Serializes async ownership because SQLite connections and migrations are single-writer seams. */
const createLock = (): PromiseLock => {
  let tail = Promise.resolve();

  return {
    async acquire() {
      const previous = tail;
      let release = (): void => undefined;

      const current = new Promise<void>((resolve) => {
        release = resolve;
      });

      tail = previous.then(() => current);
      await previous;

      return release;
    },
  };
};

export { createLock };
