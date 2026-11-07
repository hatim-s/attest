import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { describe, expect, it } from 'vitest';
import { LocalError } from '../../errors/local-error.js';
import { OperationCleanup, withOperationCleanup } from '../operation-cleanup.js';

describe('operation cleanup precedence', () => {
  it('retains the primary typed failure and every cleanup defect', async () => {
    const primary = new LocalError('project_changed', 'Primary');
    const cleanup = new Error('Release defect');

    const exit = await Effect.runPromiseExit(
      withOperationCleanup(Effect.fail(primary), Effect.die(cleanup)),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isSuccess(exit)) throw new Error('Expected primary failure');
    expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBe(primary);
    const diagnostics = Context.getOrUndefined(Cause.annotations(exit.cause), OperationCleanup);
    expect(diagnostics?.reasons.find(Cause.isDieReason)?.defect).toBe(cleanup);
  });

  it('keeps a primary defect as a defect when release also fails', async () => {
    const defect = new Error('Primary defect');

    const exit = await Effect.runPromiseExit(
      withOperationCleanup(Effect.die(defect), Effect.fail(new Error('Release'))),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected defect');
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(defect);
    expect(Context.getOrUndefined(Cause.annotations(exit.cause), OperationCleanup)).toBeDefined();
  });

  it('keeps primary interruption and attempts release once', async () => {
    let releases = 0;

    const exit = await Effect.runPromiseExit(
      withOperationCleanup(
        Effect.interrupt,
        Effect.sync(() => {
          releases += 1;
        }),
      ),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected interruption');
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(releases).toBe(1);
  });

  it('fails cleanup after success with the complete successful value retained internally', async () => {
    const value = { revision_id: 'immutable', committed: true };

    const exit = await Effect.runPromiseExit(
      withOperationCleanup(
        Effect.succeed(value),
        Effect.fail(new Error('Release')),
        'registry_write_failed',
      ),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected cleanup failure');
    const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
    expect(error).toMatchObject({ code: 'registry_write_failed', cause: { primary: { value } } });
  });
});

it('accumulates nested release failures on the original primary Cause', async () => {
  const primary = new Error('Primary');

  const exit = await Effect.runPromiseExit(
    withOperationCleanup(
      withOperationCleanup(Effect.fail(primary), Effect.fail(new Error('Inner release'))),
      Effect.fail(new Error('Outer release')),
    ),
  );

  if (Exit.isSuccess(exit)) throw new Error('Expected failure');
  expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBe(primary);
  const cleanup = Context.getOrUndefined(Cause.annotations(exit.cause), OperationCleanup);
  expect(cleanup?.reasons.filter(Cause.isFailReason).map((reason) => reason.error.message)).toEqual(
    ['Inner release', 'Outer release'],
  );
});
