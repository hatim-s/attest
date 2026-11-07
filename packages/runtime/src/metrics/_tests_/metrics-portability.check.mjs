import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Cause from 'effect/Cause';
import * as Fiber from 'effect/Fiber';
import * as Deferred from 'effect/Deferred';
import { executeExecutableMetric } from '../../../dist/metrics/exec-metric.js';
import {
  ownOperation,
  withRelease,
  releaseAll,
  MetricCleanupError,
} from '../../../dist/metrics/internal/operation.js';

const context = {
  caseDefinition: { id: 'metric-portability', input: 'hello' },
  execution: { outcome: 'completed', output: 'answer', trace: null, artifacts: [] },
};

test('native command output remains a transport result on Node and Bun', async () => {
  const result = await Effect.runPromise(
    executeExecutableMetric(
      {
        name: 'portable',
        type: 'exec',
        command: [
          process.execPath,
          '-e',
          'process.stdout.write(JSON.stringify({score:0.8,pass:true}))',
        ],
      },
      context,
    ),
  );

  assert.equal(result.status, 'evaluated');
  assert.equal(result.score, 0.8);
});

test('release failures retain completed evidence and attempt all releases', async () => {
  let closed = false;

  const exit = await Effect.runPromiseExit(
    withRelease(
      Effect.succeed('receipt'),
      releaseAll([
        Effect.fail(new Error('close one')),
        Effect.sync(() => {
          closed = true;
        }),
      ]),
    ),
  );

  assert.equal(closed, true);
  assert.ok(Exit.isFailure(exit));
  const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
  assert.ok(error instanceof MetricCleanupError);
  assert.equal(error.completed, 'receipt');
});

test('native interruption joins the resource owner', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make();
      let released = false;

      const fiber = yield* Effect.forkChild(
        ownOperation((signal) =>
          withRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(ready, undefined);
              yield* Effect.callback((resume) => {
                if (signal.aborted) resume(Effect.void);
                else signal.addEventListener('abort', () => resume(Effect.void), { once: true });
              });

              return 'cancelled receipt';
            }),
            Effect.sync(() => {
              released = true;
            }),
          ),
        ),
      );

      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);

      return { exit: yield* Fiber.await(fiber), released };
    }),
  );

  assert.equal(result.released, true);
  assert.ok(Exit.isFailure(result.exit));
  assert.ok(Cause.hasInterrupts(result.exit.cause));
});
