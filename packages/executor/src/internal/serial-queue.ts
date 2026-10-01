/**
 * Creates a queue that runs tasks one at a time in submission order. Sessions with serial agents
 * use it so a peer never sees overlapping requests; a failed task never blocks later ones.
 */
const createSerialQueue = (): (<Value>(task: () => Promise<Value>) => Promise<Value>) => {
  let tail: Promise<void> = Promise.resolve();
  return <Value>(task: () => Promise<Value>): Promise<Value> => {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
};

export { createSerialQueue };
