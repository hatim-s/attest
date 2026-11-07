import * as Effect from 'effect/Effect';
import { LocalError } from '../../errors/index.js';

/** Adapts one host prompt callback, keeping unexpected failures as defects. */
const promptEffect = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: (error) => error }).pipe(
    Effect.catch((error) => (error instanceof LocalError ? Effect.fail(error) : Effect.die(error))),
  );

export { promptEffect };
