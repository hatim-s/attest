import {
  EnvironmentCleanupError,
  getEnvironmentCleanupCause,
  vercelSandboxIsolation,
  type CaseEnvironment,
} from '@attest/executor';
import { createEnvironmentMetricTransport } from '../environment-transport.js';
import { createTanstackJudgeClient } from '../judge/tanstack-judge-client.js';
import { resolveThroughJudgeCache } from '../judge/judge-cache.js';
import { evaluateMetrics } from '../evaluate-metrics.js';
import * as Context from 'effect/Context';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Deferred from 'effect/Deferred';
import { describe, expect, it } from 'vitest';
import {
  ownOperation,
  withRelease,
  releaseAll,
  MetricCleanupError,
  MetricOperationEvidence,
  MetricCleanupDiagnostics,
} from '../internal/operation.js';
import { TestFailure } from '../../_tests_/support/test-failure.js';

/** Reads the typed failure while leaving defects and interruption in their native channels. */
const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe('native metric resource ownership', () => {
  it('retains failed environment command and stop evidence through aggregate evaluation', async () => {
    const primary = new Error('command rejected while remote active');
    const cleanup = new Error('VM stop failed');
    let commands = 0;
    let stops = 0;

    const environment = await Effect.runPromise(
      vercelSandboxIsolation({
        credentialEnv: { VERCEL_OIDC_TOKEN: 'fixture-only' },
        sandboxFactory: () =>
          Promise.resolve({
            runCommand: (command) => {
              if (command.cmd === 'mkdir') return Promise.resolve({ exitCode: 0 });
              commands++;

              return Promise.reject(primary);
            },
            writeFiles: () => Promise.resolve(),
            readFile: () => Promise.reject(new TestFailure({ message: 'unused fixture read' })),
            stop: () => {
              stops++;

              return Promise.reject(cleanup);
            },
          }),
      })({
        runId: 'fixture',
        testId: 'fixture',
        caseId: 'fixture',
        configuredIndex: 0,
        workerIndex: 0,
        signal: new AbortController().signal,
      }),
    );

    const context = {
      caseDefinition: { id: 'case', input: 'hello' },
      execution: { outcome: 'completed' as const, output: 'answer', trace: null, artifacts: [] },
    };

    const transport = createEnvironmentMetricTransport(environment);
    let metrics = 0;

    const exit = await Effect.runPromiseExit(
      evaluateMetrics(
        [
          { name: 'first', type: 'exec', command: ['unused'] },
          { name: 'second', type: 'exec', command: ['unused'] },
        ],
        context,
        {
          exec: {
            commandTransport: (...args) => {
              metrics++;

              return transport(...args);
            },
          },
        },
      ),
    );

    if (Exit.isSuccess(exit)) throw new Error('Environment cleanup failure was scored.');
    expect(failure(exit)).toMatchObject({ cause: primary });
    expect(
      getEnvironmentCleanupCause(exit.cause)
        ?.reasons.filter(Cause.isFailReason)
        .map((reason) => reason.error),
    ).toContainEqual(expect.objectContaining({ cause: cleanup }));
    expect(metrics).toBe(1);
    expect(commands).toBe(1);
    expect(stops).toBe(1);
  });

  it.each(['release', 'joined operation'] as const)(
    'does not retry a shared judge owner interrupted with failed %s cleanup',
    async (kind) => {
      const cleanup = new Error('judge release failed');
      let calls = 0;

      const request = {
        model: 'openai/fixture',
        rubric: 'test',
        document: { input: 'x', output: 'y', expected: undefined, traceSummary: undefined },
      };

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const admitted = yield* Deferred.make<void>();
          const cache = { get: () => Effect.succeed(undefined), set: () => Effect.void };

          const scope = {
            signal: undefined,
            timeoutMs: 1000,
            client: {
              scoreRubric: () =>
                Effect.gen(function* () {
                  calls++;

                  if (calls !== 1)
                    return yield* Effect.fail(new TestFailure({ message: 'unexpected retry' }));

                  if (kind === 'release')
                    return yield* withRelease(
                      Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Effect.never)),
                      Effect.fail(cleanup),
                    );

                  return yield* ownOperation((signal) =>
                    withRelease(
                      Effect.gen(function* () {
                        yield* Deferred.succeed(admitted, undefined);
                        yield* Effect.callback<void>((resume) => {
                          const abort = (): void => resume(Effect.void);
                          signal.addEventListener('abort', abort, { once: true });

                          if (signal.aborted) abort();

                          return Effect.sync(() => signal.removeEventListener('abort', abort));
                        });

                        return yield* Effect.fail(new TestFailure({ message: 'cancelled owner' }));
                      }),
                      Effect.fail(cleanup),
                    ),
                  );
                }),
            },
          };

          const owner = yield* Effect.forkChild(resolveThroughJudgeCache(cache, request, scope));
          yield* Deferred.await(admitted);
          const waiter = yield* Effect.forkChild(resolveThroughJudgeCache(cache, request, scope));
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(owner);

          return { owner: yield* Fiber.await(owner), waiter: yield* Fiber.await(waiter) };
        }),
      );

      expect(calls).toBe(1);

      for (const exit of [result.owner, result.waiter]) {
        if (Exit.isSuccess(exit)) throw new Error('Expected retained owner cleanup failure.');
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);

        const completed = Context.getOrUndefined(
          Cause.annotations(exit.cause),
          MetricOperationEvidence,
        )?.exit;

        const diagnosticCause =
          kind === 'joined operation' && completed !== undefined && Exit.isFailure(completed)
            ? completed.cause
            : exit.cause;

        const diagnostic = Context.getOrUndefined(
          Cause.annotations(diagnosticCause),
          MetricCleanupDiagnostics,
        );

        expect(
          diagnostic?.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
        ).toContain(cleanup);
      }
    },
  );

  it('attempts every release and retains completed evidence after cleanup failure', async () => {
    const completed = { ok: true, text: 'provider receipt' };
    const releases: string[] = [];

    const exit = await Effect.runPromiseExit(
      withRelease(
        Effect.succeed(completed),
        releaseAll([
          Effect.sync(() => {
            releases.push('first');
          }).pipe(Effect.andThen(Effect.fail(new TestFailure({ message: 'close failed' })))),
          Effect.sync(() => {
            releases.push('second');
          }),
        ]),
      ),
    );

    expect(releases).toEqual(['first', 'second']);
    expect(failure(exit)).toBeInstanceOf(MetricCleanupError);
    expect(failure(exit)).toMatchObject({ completed, cleanupConfirmed: false });
  });

  it('keeps the primary typed failure and native defect when cleanup also fails', async () => {
    const primary = new Error('primary');

    const failed = await Effect.runPromiseExit(
      withRelease(Effect.fail(primary), Effect.die('cleanup defect')),
    );

    expect(failure(failed)).toBe(primary);

    const defect = await Effect.runPromiseExit(
      withRelease(Effect.die(primary), Effect.fail(new TestFailure({ message: 'cleanup' }))),
    );

    expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true);
    expect(failure(defect)).toBeUndefined();
  });

  it('keeps metric transport defects and post-success cleanup failures native', async () => {
    const context = {
      caseDefinition: { id: 'native', input: 'hello' },
      execution: { outcome: 'completed' as const, output: 'answer', trace: null, artifacts: [] },
    };

    const definitions = [{ name: 'native', type: 'exec' as const, command: ['unused'] }];

    const defect = await Effect.runPromiseExit(
      evaluateMetrics(definitions, context, {
        exec: { commandTransport: () => Effect.die('transport defect') },
      }),
    );

    expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true);

    const cleanup = new MetricCleanupError(
      { ok: true, text: 'receipt' },
      Cause.fail(new Error('cleanup')),
    );

    const failed = await Effect.runPromiseExit(
      evaluateMetrics(definitions, context, {
        exec: { commandTransport: () => Effect.fail(cleanup) },
      }),
    );

    expect(failure(failed)).toBe(cleanup);
    // @ts-expect-error The native API deliberately has no Promise signature.
    const promise: Promise<unknown> = evaluateMetrics(definitions, context);
    expect(Effect.isEffect(promise)).toBe(true);
  });

  it('signals and joins the evidence owner before completing native interruption', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const admitted = yield* Deferred.make<void>();
        let released = false;

        const fiber = yield* Effect.forkChild(
          ownOperation((signal) =>
            withRelease(
              Effect.gen(function* () {
                yield* Deferred.succeed(admitted, undefined);
                yield* Effect.callback<void>((resume) => {
                  if (signal.aborted) resume(Effect.void);
                  else signal.addEventListener('abort', () => resume(Effect.void), { once: true });
                });

                return 'cancelled evidence';
              }),
              Effect.sync(() => {
                released = true;
              }),
            ),
          ),
        );

        yield* Deferred.await(admitted);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);

        return { exit, released };
      }),
    );

    expect(result.released).toBe(true);
    expect(Exit.isFailure(result.exit) && Cause.hasInterrupts(result.exit.cause)).toBe(true);

    if (Exit.isFailure(result.exit)) {
      const evidence = Context.getOrUndefined(
        Cause.annotations(result.exit.cause),
        MetricOperationEvidence,
      );

      expect(evidence?.exit).toEqual(Exit.succeed('cancelled evidence'));
    }
  });

  it('preserves environment cleanup receipts and stops subsequent metric execution', async () => {
    const completed = { stdout: 'receipt', stderr: '', exitCode: 0 };
    const cleanup = new EnvironmentCleanupError(completed, Cause.fail(new Error('release')));
    let calls = 0;

    const environment: CaseEnvironment = {
      exec: () => {
        calls++;

        return Effect.fail(cleanup);
      },
      writeFile: () => Effect.void,
      readFile: () => Effect.succeed(''),
      beginFinalization: () => Effect.void,
      dispose: () => Effect.void,
    };

    const exit = await Effect.runPromiseExit(
      evaluateMetrics(
        [
          { name: 'first', type: 'exec', command: ['unused'] },
          { name: 'second', type: 'exec', command: ['unused'] },
        ],
        {
          caseDefinition: { id: 'case', input: 'hello' },
          execution: { outcome: 'completed', output: 'answer', trace: null, artifacts: [] },
        },
        { exec: { commandTransport: createEnvironmentMetricTransport(environment) } },
      ),
    );

    expect(failure(exit)).toBe(cleanup);
    expect(calls).toBe(1);
    expect(cleanup.completed).toBe(completed);
  });

  it.each([
    { kind: 'defect', retryable: true },
    { kind: 'defect', retryable: false },
    { kind: 'interruption', retryable: true },
    { kind: 'interruption', retryable: false },
  ])(
    'does not classify or retry a mixed $kind Cause, retryable=$retryable',
    async ({ kind, retryable }) => {
      const typed = retryable
        ? Object.assign(new Error('malformed'), { code: 'structured-output-parse-failed' })
        : new Error('provider failed');

      const extra = kind === 'defect' ? Cause.die(new Error('invariant')) : Cause.interrupt();
      const cause = Cause.combine(Cause.fail(typed), extra);
      let calls = 0;

      const client = createTanstackJudgeClient({
        openaiApiKey: 'fixture',
        executeChat: () => {
          calls++;

          return calls === 1
            ? Effect.failCause(cause)
            : Effect.succeed({ score: 1, rationale: 'must not retry' });
        },
      });

      const exit = await Effect.runPromiseExit(
        client.scoreRubric({
          model: 'openai/fixture',
          rubric: 'test',
          document: { input: 'x', output: 'y', expected: undefined, traceSummary: undefined },
        }),
      );

      expect(calls).toBe(1);
      calls = 0;

      const aggregate = await Effect.runPromiseExit(
        evaluateMetrics(
          [{ name: 'judge', type: 'judge', model: 'openai/fixture', rubric: 'test' }],
          {
            caseDefinition: { id: 'case', input: 'x' },
            execution: { outcome: 'completed', output: 'y', trace: null, artifacts: [] },
          },
          { judgeClient: client },
        ),
      );

      expect(calls).toBe(1);

      if (Exit.isSuccess(aggregate)) throw new Error('Aggregate must retain mixed Cause.');
      expect(aggregate.cause.reasons.map((reason) => reason._tag)).toEqual(
        cause.reasons.map((reason) => reason._tag),
      );

      if (Exit.isSuccess(exit)) throw new Error('Expected full mixed Cause.');
      expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(
        cause.reasons.map((reason) => reason._tag),
      );
      expect(
        exit.cause.reasons.map((reason) =>
          reason._tag === 'Fail'
            ? reason.error
            : reason._tag === 'Die'
              ? reason.defect
              : reason.fiberId,
        ),
      ).toEqual(
        cause.reasons.map((reason) =>
          reason._tag === 'Fail'
            ? reason.error
            : reason._tag === 'Die'
              ? reason.defect
              : reason.fiberId,
        ),
      );
    },
  );

  it('lets a shared judge waiter acquire its own call after its owner is interrupted', async () => {
    let calls = 0;

    const request = {
      model: 'openai/fixture',
      rubric: 'test',
      document: { input: 'x', output: 'y', expected: undefined, traceSummary: undefined },
    };

    const outcome = {
      verdict: { score: 1, rationale: 'completed' },
      record: {
        request: { model: 'openai/fixture', system: 's', user: 'u', params: {} },
        rawResponse: null,
        usage: undefined,
        attempts: [],
      },
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const admitted = yield* Deferred.make<void>();
        const cache = { get: () => Effect.succeed(undefined), set: () => Effect.void };

        const scope = {
          signal: undefined,
          timeoutMs: 1_000,
          client: {
            scoreRubric: () =>
              Effect.gen(function* () {
                calls++;

                if (calls === 1) {
                  yield* Deferred.succeed(admitted, undefined);

                  return yield* Effect.never;
                }

                return outcome;
              }),
          },
        };

        const owner = yield* Effect.forkChild(resolveThroughJudgeCache(cache, request, scope));
        yield* Deferred.await(admitted);
        const waiter = yield* Effect.forkChild(resolveThroughJudgeCache(cache, request, scope));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(owner);

        return { owner: yield* Fiber.await(owner), waiter: yield* Fiber.await(waiter) };
      }),
    );

    expect(Exit.isFailure(result.owner) && Cause.hasInterrupts(result.owner.cause)).toBe(true);
    expect(result.waiter).toMatchObject({ _tag: 'Success', value: { outcome } });
    expect(calls).toBe(2);
  });

  it('retains nested metric release failures without replacing the primary Cause', async () => {
    const primary = new Error('primary');
    const inner = new Error('inner');
    const outer = new Error('outer');

    const exit = await Effect.runPromiseExit(
      withRelease(withRelease(Effect.fail(primary), Effect.fail(inner)), Effect.die(outer)),
    );

    expect(failure(exit)).toBe(primary);

    if (Exit.isSuccess(exit)) throw new Error('Expected failure.');
    const cleanup = Context.getOrUndefined(Cause.annotations(exit.cause), MetricCleanupDiagnostics);
    expect(
      cleanup?.cause.reasons.map((reason) =>
        reason._tag === 'Fail' ? reason.error : reason._tag === 'Die' ? reason.defect : undefined,
      ),
    ).toEqual([inner, outer]);
  });
  it('retains cleanup from every combined primary branch and its outer release', async () => {
    const left = new Error('left primary');
    const right = new Error('right primary');
    const leftRelease = new Error('left release');
    const rightRelease = new Error('right release');
    const outerRelease = new Error('outer release');
    const a = await Effect.runPromiseExit(withRelease(Effect.fail(left), Effect.fail(leftRelease)));

    const b = await Effect.runPromiseExit(
      withRelease(Effect.fail(right), Effect.fail(rightRelease)),
    );

    if (Exit.isSuccess(a) || Exit.isSuccess(b)) throw new Error('Expected branch failures.');

    const exit = await Effect.runPromiseExit(
      withRelease(Effect.failCause(Cause.combine(a.cause, b.cause)), Effect.fail(outerRelease)),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected combined failure.');
    expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([
      left,
      right,
    ]);
    const cleanup = Context.getOrUndefined(Cause.annotations(exit.cause), MetricCleanupDiagnostics);
    expect(cleanup?.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual(
      [leftRelease, rightRelease, outerRelease],
    );
  });
  it('does not restart a shared judge call when only its waiter is interrupted', async () => {
    let calls = 0;

    const request = {
      model: 'openai/fixture',
      rubric: 'test',
      document: { input: 'x', output: 'y', expected: undefined, traceSummary: undefined },
    };

    const outcome = {
      verdict: { score: 1, rationale: 'completed' },
      record: {
        request: { model: 'openai/fixture', system: 's', user: 'u', params: {} },
        rawResponse: null,
        usage: undefined,
        attempts: [],
      },
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const admitted = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const cache = { get: () => Effect.succeed(undefined), set: () => Effect.void };

        const scope = {
          signal: undefined,
          timeoutMs: 1_000,
          client: {
            scoreRubric: () =>
              Effect.gen(function* () {
                calls++;
                yield* Deferred.succeed(admitted, undefined);
                yield* Deferred.await(finished);

                return outcome;
              }),
          },
        };

        const owner = yield* Effect.forkChild(resolveThroughJudgeCache(cache, request, scope));
        yield* Deferred.await(admitted);
        const waiter = yield* Effect.forkChild(resolveThroughJudgeCache(cache, request, scope));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(finished, undefined);

        return { owner: yield* Fiber.await(owner), waiter: yield* Fiber.await(waiter) };
      }),
    );

    expect(Exit.isFailure(result.waiter) && Cause.hasInterrupts(result.waiter.cause)).toBe(true);
    expect(result.owner).toMatchObject({ _tag: 'Success', value: { outcome } });
    expect(calls).toBe(1);
  });
  it.each(['defect', 'interruption'] as const)(
    'preserves a mixed %s from an advisory cache write',
    async (kind) => {
      const cause = Cause.combine(
        Cause.fail(new Error('cache write failed')),
        kind === 'defect' ? Cause.die(new Error('cache invariant')) : Cause.interrupt(),
      );

      const outcome = {
        verdict: { score: 1, rationale: 'completed' },
        record: {
          request: { model: 'openai/fixture', system: 's', user: 'u', params: {} },
          rawResponse: null,
          usage: undefined,
          attempts: [],
        },
      };

      const exit = await Effect.runPromiseExit(
        resolveThroughJudgeCache(
          { get: () => Effect.succeed(undefined), set: () => Effect.failCause(cause) },
          {
            model: 'openai/fixture',
            rubric: 'test',
            document: { input: 'x', output: 'y', expected: undefined, traceSummary: undefined },
          },
          {
            signal: undefined,
            timeoutMs: 1_000,
            client: { scoreRubric: () => Effect.succeed(outcome) },
          },
        ),
      );

      if (Exit.isSuccess(exit)) throw new Error('Expected mixed cache failure.');
      expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(
        cause.reasons.map((reason) => reason._tag),
      );
      expect(
        exit.cause.reasons.map((reason) =>
          reason._tag === 'Fail'
            ? reason.error
            : reason._tag === 'Die'
              ? reason.defect
              : reason.fiberId,
        ),
      ).toEqual(
        cause.reasons.map((reason) =>
          reason._tag === 'Fail'
            ? reason.error
            : reason._tag === 'Die'
              ? reason.defect
              : reason.fiberId,
        ),
      );
    },
  );

  it('retains two equal release failures as two cleanup observations', async () => {
    const cleanup = new Error('same release failure');
    const release = Effect.failCause(Cause.fail(cleanup));

    const exit = await Effect.runPromiseExit(
      withRelease(
        withRelease(Effect.fail(new TestFailure({ message: 'primary' })), release),
        release,
      ),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected failure.');

    const recorded = Context.getOrUndefined(
      Cause.annotations(exit.cause),
      MetricCleanupDiagnostics,
    );

    expect(
      recorded?.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
    ).toEqual([cleanup, cleanup]);
  });
});
