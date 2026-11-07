import { open } from 'node:fs/promises';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

import {
  anchoredCall,
  AnchoredCleanup,
  AnchoredCleanupFailure,
  type AnchoredFileFailure,
} from './open-anchored.js';

/** Joins fsync before closing, including directory fsync required for durable entry changes. */
const syncPath = Effect.fn('syncPath')(function* (path: string) {
  let cleanup: Exit.Exit<unknown, AnchoredFileFailure> = Exit.void;

  const primary = yield* Effect.exit(
    Effect.acquireUseRelease(
      anchoredCall('open', path, () => open(path, 'r')),
      (handle) => anchoredCall('fsync', path, () => handle.sync()),
      (handle) =>
        Effect.gen(function* () {
          cleanup = yield* Effect.exit(anchoredCall('close', path, () => handle.close()));
        }),
    ),
  );

  if (Exit.isFailure(cleanup)) {
    if (Exit.isFailure(primary))
      return yield* Effect.failCause(
        Cause.annotate(primary.cause, Context.make(AnchoredCleanup, cleanup.cause)),
      );

    return yield* Effect.fail(new AnchoredCleanupFailure({ path, cleanup: cleanup.cause }));
  }

  return yield* primary;
}, Effect.uninterruptible);

export { syncPath };
