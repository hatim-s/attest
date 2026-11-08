import * as Effect from 'effect/Effect';
import { AgentInvocationError } from '../../errors.js';

/** Keeps the accepted foreign read until close joins it, even if its observer was interrupted. */
const makeStreamReader = (next: () => Promise<IteratorResult<Uint8Array>>) => {
  let pending: Promise<IteratorResult<Uint8Array>> | undefined;

  const read = Effect.suspend(() => {
    // A synchronous throw from `next` is a defect. Only foreign Promise rejection is a read failure.
    const accepted = next();
    pending = accepted;

    return Effect.tryPromise({
      try: () => accepted,
      catch: (cause) => new AgentInvocationError('network', 'Streaming body failed.', { cause }),
    });
  });

  const awaitRead = Effect.suspend(() => {
    const accepted = pending;

    if (accepted === undefined) return Effect.void;

    // Either settlement confirms the read joined. A rejected read does not undo body release.
    return Effect.tryPromise({
      try: () => accepted,
      catch: (cause) => new AgentInvocationError('network', 'Streaming body failed.', { cause }),
    }).pipe(
      Effect.match({ onSuccess: () => undefined, onFailure: () => undefined }),
      Effect.interruptible,
      Effect.timeout(100),
    );
  });

  return { read, awaitRead };
};

export { makeStreamReader };
