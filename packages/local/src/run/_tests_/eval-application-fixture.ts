import * as Effect from 'effect/Effect';
import * as Deferred from 'effect/Deferred';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import type { EvalEvent } from '@attest/contracts';
import { withEvalApplication, EvalApplication } from '../../commands/eval/eval-application.js';
import { CancellationRegistry } from '../../commands/eval/eval-cancellation.js';

/** Keeps a real native application alive from source acquisition through iterator completion. */
const evalApplicationFixture = async (
  operation: Effect.Effect<AsyncIterable<EvalEvent>, Error, EvalApplication | CancellationRegistry>,
): Promise<AsyncIterable<EvalEvent>> => {
  const done = Deferred.makeUnsafe<void>();
  let publish!: (source: AsyncIterable<EvalEvent>) => void;
  let reject!: (cause: unknown) => void;

  const ready = new Promise<AsyncIterable<EvalEvent>>((resolve, fail) => {
    publish = resolve;
    reject = fail;
  });

  const finished = Effect.runPromiseExit(
    withEvalApplication(
      Effect.gen(function* () {
        const source = yield* operation;
        publish(source);
        yield* Deferred.await(done);
      }),
    ),
  );

  void finished.then((exit) => {
    if (Exit.isFailure(exit)) reject(Cause.squash(exit.cause));
  });
  const source = await ready;

  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield* source;
      } finally {
        await Effect.runPromiseExit(Deferred.succeed(done, undefined));
        const exit = await finished;

        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
      }
    },
  };
};

export { evalApplicationFixture };
