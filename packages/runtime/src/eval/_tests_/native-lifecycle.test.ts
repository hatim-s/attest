import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import { describe, expect, it } from 'vitest';
import { executeResolvedEvalPlan } from '../engine/execute-eval.js';
import { EvalLifecycleEvidence } from '../lifecycle.js';
import {
  completedExecution,
  createPersistence,
  createPlan,
  waitForAbort,
} from './support/eval-fixtures.js';

describe('native eval lifetime', () => {
  it('joins interrupted case evidence, writes and cleanup before returning interruption', async () => {
    const persistence = createPersistence();
    let cleaned = false;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();

          const fiber = yield* Effect.forkScoped(
            executeResolvedEvalPlan(
              createPlan(['one', 'queued'], { concurrency: 1 }),
              {
                executeCase: (...args) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined);

                    return yield* waitForAbort(...args);
                  }),
                cleanup: () =>
                  Effect.sync(() => {
                    cleaned = true;
                  }),
              },
              persistence.adapter,
            ),
          );

          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);

          return yield* Fiber.join(fiber);
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isSuccess(exit)) throw new Error('Expected interruption.');
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(cleaned).toBe(true);
    expect(persistence.recordCase).toHaveBeenCalledTimes(2);
    expect(persistence.recordCase.mock.calls[0]?.[1]).toMatchObject({
      kind: 'executed',
      execution: { outcome: 'cancelled', attempts: [{ status: 'invocation_error' }] },
    });
    expect(persistence.finalizeRun).toHaveBeenCalledWith(
      expect.any(String),
      'cancelled',
      expect.objectContaining({ total_cases: 2 }),
    );
  });

  it('joins siblings and finalization before propagating mixed case Causes with every release defect', async () => {
    const primary = new Error('primary');
    const defect = new Error('defect');
    const release = new Error('release');
    const persistence = createPersistence();
    let siblingFinished = false;

    const exit = await Effect.runPromiseExit(
      executeResolvedEvalPlan(
        createPlan(['broken', 'sibling']),
        {
          executeCase: (_id, entry) =>
            entry.case_id === 'broken'
              ? Effect.failCause(
                  Cause.fromReasons([...Cause.fail(primary).reasons, ...Cause.die(defect).reasons]),
                )
              : Effect.gen(function* () {
                  yield* Effect.sleep(5);
                  siblingFinished = true;

                  return completedExecution(entry);
                }),
          cleanup: () => Effect.die(release),
        },
        persistence.adapter,
      ),
    );

    expect(siblingFinished).toBe(true);
    expect(persistence.recordCase).toHaveBeenCalledTimes(2);
    expect(persistence.finalizeRun).toHaveBeenCalled();

    if (Exit.isSuccess(exit)) throw new Error('Expected original mixed Cause.');
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(exit.cause.reasons.some((r) => Cause.isFailReason(r) && r.error === primary)).toBe(true);
    expect(exit.cause.reasons.some((r) => Cause.isDieReason(r) && r.defect === defect)).toBe(true);

    const receipts = exit.cause.reasons.flatMap(
      (r) =>
        Context.getOrUndefined(Cause.reasonAnnotations(r), EvalLifecycleEvidence)?.causes ?? [],
    );

    expect(
      receipts.some((c) => c.reasons.some((r) => Cause.isDieReason(r) && r.defect === release)),
    ).toBe(true);
  });
  it('keeps a typed primary failure when cleanup defects during finalization', async () => {
    const primary = new Error('setup failed');
    const release = new Error('cleanup defect');
    const persistence = createPersistence();

    const exit = await Effect.runPromiseExit(
      executeResolvedEvalPlan(
        createPlan(['one']),
        {
          beforeRun: () => Effect.fail(primary),
          executeCase: (_id, entry) => Effect.succeed(completedExecution(entry)),
          cleanup: () => Effect.die(release),
        },
        persistence.adapter,
      ),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected retained primary Cause.');
    expect(exit.cause.reasons.some((r) => Cause.isFailReason(r) && r.error === primary)).toBe(true);

    const receipts = exit.cause.reasons.flatMap(
      (r) =>
        Context.getOrUndefined(Cause.reasonAnnotations(r), EvalLifecycleEvidence)?.causes ?? [],
    );

    expect(
      receipts.some((c) => c.reasons.some((r) => Cause.isDieReason(r) && r.defect === release)),
    ).toBe(true);
    expect(persistence.finalizeRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      expect.anything(),
    );
  });
});
