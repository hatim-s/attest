import * as Effect from 'effect/Effect';
import { valueFromExit } from './effect-exit.js';

/** Runs fixture Effects with original typed errors and complete defect Causes. */
const run = <A, E extends Error>(operation: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(operation).then(valueFromExit);

export { run };
