import { AGENT_PROTOCOL } from '@attest/contracts';
import { Cause, Context, Deferred, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { ClientCleanup, ClientCleanupError, withCleanup } from '../runner/lifetime.js';
import { createAgentRunner, withAgentRunner } from '../runner/agent-runner.js';
import { createRunner } from './support/native-owner.js';

/** Builds an authenticated callback trigger with a stable registration identity. */
const request = (token = 'registration') =>
  new Request('http://runner.test/', {
    method: 'POST',
    headers: { authorization: 'Bearer trigger', 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AGENT_PROTOCOL,
      run_id: '01J9Z3K4X5Y6Z7A8B9C0D1E2F3',
      case_id: 'case',
      input: 'hello',
      callback: { url: 'http://completion.test/', token },
    }),
  });

describe('native client lifetime invariants', () => {
  it('keeps accepted handlers alive after their request scope returns', async () => {
    const gate = await Effect.runPromise(Deferred.make<void>());

    const runner = await createRunner({
      triggerToken: 'trigger',
      handler: () => Deferred.await(gate).pipe(Effect.as({ output: 'finished' })),
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
    });

    const response = await Effect.runPromise(Effect.scoped(runner.native.fetch(request())));
    expect(response.status).toBe(202);
    expect(runner.pending()).toBe(1);
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    await runner.drain();
    expect(runner.native.receipts.get('registration')?.delivery?.delivered).toBe(true);
  });

  it('retains completed admission and never repeats the handler after uncertain delivery', async () => {
    let runs = 0;
    let deliveries = 0;

    const runner = await createRunner({
      triggerToken: 'trigger',
      handler: () =>
        Effect.sync(() => {
          runs++;

          return { output: null };
        }),
      fetch: () => {
        deliveries++;

        return Promise.reject(new Error('ack lost'));
      },
      onError: () => undefined,
    });

    expect((await runner.fetch(request())).status).toBe(202);
    await runner.drain();
    expect((await runner.fetch(request())).status).toBe(202);
    await runner.drain();
    expect(runs).toBe(1);
    expect(deliveries).toBe(1);
    expect(runner.native.receipts.get('registration')?.delivery).toMatchObject({
      delivered: false,
      uncertain: true,
    });
  });

  it('keeps handler defects as defects in drain and terminal evidence', async () => {
    const defect = new Error('invariant broken');

    const runner = await createRunner({
      triggerToken: 'trigger',
      handler: () => Effect.die(defect),
      fetch: () => Promise.reject(new Error('must not deliver')),
    });

    await runner.fetch(request());
    const exit = await Effect.runPromise(Effect.exit(runner.native.drain()));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(runner.native.receipts.get('registration')?.exit).toEqual(exit);
  });

  it('preserves primary failure and cleanup diagnostics and exposes success after failed release', async () => {
    const primary = new Error('primary');
    const cleanup = new Error('release');

    const failed = await Effect.runPromise(
      Effect.exit(withCleanup(Effect.fail(primary), Effect.die(cleanup), undefined)),
    );

    expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBe(true);

    if (Exit.isFailure(failed))
      expect(Context.getOrUndefined(Cause.annotations(failed.cause), ClientCleanup)).toBeDefined();

    const completed = await Effect.runPromise(
      Effect.exit(withCleanup(Effect.succeed('committed'), Effect.fail(cleanup), undefined)),
    );

    expect(
      Exit.isFailure(completed) &&
        completed.cause.reasons.some(
          (reason) =>
            reason._tag === 'Fail' &&
            reason.error instanceof ClientCleanupError &&
            reason.error.success === 'committed',
        ),
    ).toBe(true);
  });

  it('does not turn confirmed delivery into a retry when body cleanup fails', async () => {
    let deliveries = 0;

    const runner = await createRunner({
      triggerToken: 'trigger',
      handler: () => Effect.succeed({ output: null }),
      fetch: () => {
        deliveries++;

        return Promise.resolve(
          new Response(
            new ReadableStream({ cancel: () => Promise.reject(new Error('cancel failed')) }),
            { status: 202 },
          ),
        );
      },
    });

    await runner.fetch(request());
    await runner.drain();
    expect(deliveries).toBe(1);
    expect(runner.native.receipts.get('registration')?.delivery).toMatchObject({ delivered: true });
    expect(runner.native.receipts.get('registration')?.delivery?.cleanup).toHaveLength(1);
  });

  it.each(['failure', 'defect', 'interruption'] as const)(
    'retains nested cleanup Causes after primary %s',
    async (kind) => {
      const primary = new Error('primary');
      const inner = new Error('inner release');
      const outer = new Error('outer release');

      const use =
        kind === 'failure'
          ? Effect.fail(primary)
          : kind === 'defect'
            ? Effect.die(primary)
            : Effect.interrupt;

      const exit = await Effect.runPromise(
        Effect.exit(
          withCleanup(
            withCleanup(use, Effect.fail(inner), undefined),
            Effect.die(outer),
            undefined,
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isSuccess(exit)) throw new Error('Expected primary failure.');
      expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual([
        kind === 'failure' ? 'Fail' : kind === 'defect' ? 'Die' : 'Interrupt',
      ]);
      const cleanup = Context.getOrUndefined(Cause.annotations(exit.cause), ClientCleanup);
      expect(
        cleanup?.reasons.map((reason) =>
          reason._tag === 'Fail' ? reason.error : reason._tag === 'Die' ? reason.defect : undefined,
        ),
      ).toEqual([inner, outer]);
    },
  );

  it('joins slow owned cleanup before returning its successful output', async () => {
    const exit = await Effect.runPromise(
      Effect.exit(withCleanup(Effect.succeed('pi-output'), Effect.sleep(3_100), undefined)),
    );

    expect(exit).toEqual(Exit.succeed('pi-output'));
  }, 10_000);

  it('retains the actual runner close outcome after cancellation grace and delivery', async () => {
    const primary = new Error('use failed');
    const completions: unknown[] = [];

    const exit = await Effect.runPromise(
      Effect.exit(
        withAgentRunner(
          {
            triggerToken: 'trigger',
            handler: () => Effect.never,
            fetch: async (_url, init) => {
              const body: unknown = await new Response(init?.body).json();
              await new Promise<void>((resolve) => setTimeout(resolve, 100));
              completions.push(body);

              return new Response(null, { status: 202 });
            },
          },
          (runner) => runner.fetch(request()).pipe(Effect.andThen(Effect.fail(primary))),
        ),
      ),
    );

    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ error: { code: 'cancelled' } });

    if (Exit.isSuccess(exit)) throw new Error('Expected use failure.');
    expect(exit.cause.reasons).toHaveLength(1);
    expect(exit.cause.reasons[0]).toMatchObject({ _tag: 'Fail', error: primary });
    expect(Context.getOrUndefined(Cause.annotations(exit.cause), ClientCleanup)).toBeUndefined();
  }, 10_000);

  it('evicts finished receipts while preserving active work and recent deduplication', async () => {
    const gate = await Effect.runPromise(Deferred.make<void>());
    let runs = 0;

    const runner = await createRunner({
      triggerToken: 'trigger',
      handler: (invocation) =>
        invocation.callback.token === 'held'
          ? Deferred.await(gate).pipe(Effect.as({ output: null }))
          : Effect.sync(() => {
              runs++;

              return { output: null };
            }),
      fetch: () => Promise.resolve(new Response(null, { status: 202 })),
    });

    try {
      expect((await runner.fetch(request('held'))).status).toBe(202);

      for (let index = 0; index < 10_005; index++) {
        expect((await runner.fetch(request(`token-${String(index)}`))).status).toBe(202);

        // Let the foreign response Promise settle before starting the next admission batch.
        if (index % 32 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      expect(runner.native.receipts.size).toBe(10_000);
      expect(runner.native.receipts.has('held')).toBe(true);
      expect(runner.native.receipts.has('token-0')).toBe(false);
      expect((await runner.fetch(request('held'))).status).toBe(202);
      expect((await runner.fetch(request('token-10004'))).status).toBe(202);
    } finally {
      await Effect.runPromise(Deferred.succeed(gate, undefined));
      await runner.drain();
    }

    expect(runs).toBe(10_005);
  }, 30_000);

  it('uses an explicit bound for uncooperative foreign cleanup', async () => {
    const exit = await Effect.runPromise(
      Effect.exit(withCleanup(Effect.succeed('completed'), Effect.sleep(50), 5)),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected bounded cleanup failure.');
    expect(exit.cause.reasons[0]).toMatchObject({
      _tag: 'Fail',
      error: { _tag: 'ClientCleanupError', success: 'completed' },
    });
  });

  it('keeps shutdown evidence separate from a registration named shutdown', async () => {
    const defect = new Error('handler defect');

    const runner = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owned = yield* createAgentRunner({
            triggerToken: 'trigger',
            handler: () => Effect.die(defect),
          });

          yield* owned.fetch(request('shutdown'));
          yield* Effect.exit(owned.drain());

          return owned;
        }),
      ),
    );

    expect(runner.receipts.get('shutdown')?.handlerExit).toBeDefined();
    expect(runner.shutdown.exit).toBeDefined();
  });
  it('retains cleanup from both combined primary branches and the outer release', async () => {
    const left = new Error('left primary');
    const right = new Error('right primary');
    const leftRelease = new Error('left release');
    const rightRelease = new Error('right release');
    const outerRelease = new Error('outer release');

    const a = await Effect.runPromise(
      Effect.exit(withCleanup(Effect.fail(left), Effect.fail(leftRelease), undefined)),
    );

    const b = await Effect.runPromise(
      Effect.exit(withCleanup(Effect.fail(right), Effect.fail(rightRelease), undefined)),
    );

    if (Exit.isSuccess(a) || Exit.isSuccess(b)) throw new Error('Expected branch failures.');

    const exit = await Effect.runPromise(
      Effect.exit(
        withCleanup(
          Effect.failCause(Cause.combine(a.cause, b.cause)),
          Effect.fail(outerRelease),
          undefined,
        ),
      ),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected combined failure.');
    expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([
      left,
      right,
    ]);
    const cleanup = Context.getOrUndefined(Cause.annotations(exit.cause), ClientCleanup);
    expect(cleanup?.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([
      leftRelease,
      rightRelease,
      outerRelease,
    ]);
  });

  it('retains separate release observations even when they return the same Cause', async () => {
    const cleanup = new Error('same release failure');
    const release = Effect.failCause(Cause.fail(cleanup));

    const exit = await Effect.runPromise(
      Effect.exit(
        withCleanup(
          withCleanup(Effect.fail(new Error('primary')), release, undefined),
          release,
          undefined,
        ),
      ),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected failure.');
    const recorded = Context.getOrUndefined(Cause.annotations(exit.cause), ClientCleanup);
    expect(recorded?.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([
      cleanup,
      cleanup,
    ]);
  });
});
