/**
 * Serializes access to a single shared connection without exposing queue mechanics to the driver.
 */
class ConnectionMutex {
  #tail: Promise<void> = Promise.resolve();
  #releaseCurrent: (() => void) | undefined;

  /** Waits for every earlier holder before installing the next release slot. */
  async acquire(): Promise<void> {
    const previous = this.#tail;
    let releaseSlot: (() => void) | undefined;
    const slot = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    this.#tail = previous.then(() => slot);
    await previous;
    this.#releaseCurrent = releaseSlot;
  }

  /** Advances the promise chain after the current holder has finished with the connection. */
  release(): void {
    const releaseCurrent = this.#releaseCurrent;
    if (!releaseCurrent) {
      throw new Error('Cannot release a connection that is not acquired.');
    }

    this.#releaseCurrent = undefined;
    releaseCurrent();
  }
}

export { ConnectionMutex };
