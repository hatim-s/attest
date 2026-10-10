import type { EvalEvent } from '@attest/contracts';

type PendingRead = {
  reject: (cause: unknown) => void;
  resolve: (result: IteratorResult<EvalEvent>) => void;
};

/** Bridges engine callbacks to a single-consumer async iterable without buffering the complete run. */
class EvalEventQueue implements AsyncIterable<EvalEvent>, AsyncIterator<EvalEvent> {
  readonly #events: EvalEvent[] = [];
  readonly #reads: PendingRead[] = [];
  #closed = false;
  #failure: Error | undefined;
  #iterated = false;

  /** Delivers one validated event immediately or retains it until the CLI asks for the next line. */
  push(event: EvalEvent): void {
    if (this.#closed) throw new Error('Cannot append to a closed eval event stream.');
    const pending = this.#reads.shift();

    if (pending === undefined) this.#events.push(event);
    else pending.resolve({ done: false, value: event });
  }

  /** Completes every pending read after the engine has emitted its terminal result. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    for (const pending of this.#reads.splice(0)) pending.resolve({ done: true, value: undefined });
  }

  /** Rejects pending and future reads when setup or orchestration unexpectedly escapes its boundary. */
  fail(cause: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure =
      cause instanceof Error ? cause : new Error('Eval event production failed.', { cause: cause });

    for (const pending of this.#reads.splice(0)) pending.reject(this.#failure);
  }

  /** Returns the next event in callback order and never permits two consumers to split the stream. */
  next(): Promise<IteratorResult<EvalEvent>> {
    const event = this.#events.shift();

    if (event !== undefined) return Promise.resolve({ done: false, value: event });

    if (this.#failure !== undefined) return Promise.reject(this.#failure);

    if (this.#closed) return Promise.resolve({ done: true, value: undefined });

    return new Promise((resolve, reject) => this.#reads.push({ reject, resolve }));
  }

  /** Claims the one stream consumer expected by the command renderer. */
  [Symbol.asyncIterator](): AsyncIterator<EvalEvent> {
    if (this.#iterated) throw new Error('Eval event streams can only be consumed once.');
    this.#iterated = true;

    return this;
  }
}

export { EvalEventQueue };
