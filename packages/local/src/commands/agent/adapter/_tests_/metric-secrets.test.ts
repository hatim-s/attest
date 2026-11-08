import { Cause, Context, Effect, Exit, Fiber } from 'effect';
import { mkdtemp, open, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import { REDACTED } from '../../../../internal/redaction.js';
import { evaluateMetricResource } from '../../../eval/eval-metric-runner.js';
import { resolveProcessEnvironment } from '../metric-secrets.js';
import { MetricCleanupDiagnostics, MetricCleanupError, withRelease } from '../metric-operation.js';

it('retains secret descriptor cleanup evidence without retaining the read secret', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attest-secret-cleanup-')));
  const secret = 'fixture-secret-must-not-escape';
  const closeFailure = new Error('fixture close failed');
  await writeFile(join(root, 'token'), secret, { mode: 0o600 });
  const probe = await open(join(root, 'token'), 'r');
  // SAFETY: The prototype comes from the real FileHandle opened above.
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();

  const spy = vi.spyOn(prototype, 'readFile').mockImplementation(function (
    this: FileHandle,
    options,
  ) {
    spy.mockRestore();
    const close = this.close.bind(this);
    this.close = async () => {
      await close();
      throw closeFailure;
    };

    return this.readFile(options);
  });

  try {
    const exit = await Effect.runPromiseExit(
      resolveProcessEnvironment({ TOKEN: { from_file: 'token' } }, root),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected descriptor cleanup failure.');
    expect(inspect(exit, { depth: null })).not.toContain(secret);
    const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
    expect(error).toMatchObject({ code: 'invocation_failed' });
    expect(inspect(error, { depth: null })).toContain(closeFailure.message);
  } finally {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains nested local cleanup Causes while preserving the primary failure', async () => {
  const primary = new Error('primary');
  const inner = new Error('inner');
  const outer = new Error('outer');

  const exit = await Effect.runPromiseExit(
    withRelease(withRelease(Effect.fail(primary), Effect.fail(inner)), Effect.die(outer)),
  );

  if (Exit.isSuccess(exit)) throw new Error('Expected failure.');
  expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBe(primary);
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
  const b = await Effect.runPromiseExit(withRelease(Effect.fail(right), Effect.fail(rightRelease)));

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
  expect(cleanup?.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([
    leftRelease,
    rightRelease,
    outerRelease,
  ]);
});

it('retains two equal release failures as two cleanup observations', async () => {
  const cleanup = new Error('same release failure');
  const release = Effect.failCause(Cause.fail(cleanup));

  const exit = await Effect.runPromiseExit(
    withRelease(
      withRelease(Effect.fail(new Cause.UnknownError(undefined, 'primary')), release),
      release,
    ),
  );

  if (Exit.isSuccess(exit)) throw new Error('Expected failure.');
  const recorded = Context.getOrUndefined(Cause.annotations(exit.cause), MetricCleanupDiagnostics);
  expect(recorded?.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([
    cleanup,
    cleanup,
  ]);
});

const context = {
  caseDefinition: { id: 'case', input: 'input' },
  execution: { outcome: 'completed' as const, output: 'output', trace: null, artifacts: [] },
};

/** Opens a real descriptor to obtain the shared FileHandle prototype for fault injection. */
const handlePrototype = async (root: string) => {
  const probe = await open(root, 'r');
  // SAFETY: Node creates this FileHandle, whose methods are spied on only for this test.
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();

  return prototype;
};

it('interruption during cwd acquisition closes the transferred descriptor before returning', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attest-metric-ownership-')));
  const prototype = await handlePrototype(root);
  let acquired!: () => void;

  const acquisition = new Promise<void>((resolve) => {
    acquired = resolve;
  });

  let continueOpen!: () => void;

  const gate = new Promise<void>((resolve) => {
    continueOpen = resolve;
  });

  let releaseDescriptor: (() => Promise<void>) | undefined;
  let closed = false;

  const spy = vi.spyOn(prototype, 'stat').mockImplementation(async function (
    this: FileHandle,
    options,
  ) {
    spy.mockRestore();
    const close = this.close.bind(this);
    releaseDescriptor = close;
    this.close = async () => {
      await close();
      closed = true;
    };

    const identity = await this.stat(options);
    acquired();
    await gate;

    return identity;
  });

  try {
    const observed = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(
            evaluateMetricResource({
              context,
              definition: { kind: 'exec', argv: [process.execPath, '-e', 'process.exit(99)'] },
              id: 'metric',
              projectRoot: root,
            }),
          );

          yield* Effect.promise(() => acquisition);
          // Request interruption while acquisition is masked, then allow ownership transfer.
          const interrupted = yield* Effect.forkScoped(Fiber.interrupt(fiber));
          continueOpen();
          yield* Fiber.join(interrupted);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(closed).toBe(true);
        }),
      ),
    );

    if (Exit.isFailure(observed))
      throw new Error('Metric ownership observation failed.', { cause: observed.cause });
  } finally {
    continueOpen();
    spy.mockRestore();

    if (!closed) await releaseDescriptor?.();
    await rm(root, { recursive: true, force: true });
  }
});

it('cwd cleanup failure retains redacted completed metric evidence and the full cleanup Cause', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attest-metric-cleanup-')));
  const secret = 'metric-cleanup-private-token';
  const cleanupFailure = new Error('fixture cwd close failure');
  await writeFile(join(root, 'token'), secret, { mode: 0o600 });
  const prototype = await handlePrototype(root);

  const spy = vi.spyOn(prototype, 'stat').mockImplementation(async function (
    this: FileHandle,
    options,
  ) {
    spy.mockRestore();
    const close = this.close.bind(this);
    this.close = async () => {
      await close();
      throw cleanupFailure;
    };

    return this.stat(options);
  });

  try {
    const exit = await Effect.runPromiseExit(
      evaluateMetricResource({
        context,
        definition: {
          kind: 'exec',
          argv: [
            process.execPath,
            '-e',
            "process.stdin.resume().on('end', () => process.stdout.write(JSON.stringify({score:1,pass:true,rationale:process.env.TOKEN})))",
          ],
          env: { TOKEN: { from_file: 'token' } },
        },
        id: 'metric',
        projectRoot: root,
      }),
    );

    if (Exit.isSuccess(exit)) throw new Error('Expected cwd cleanup failure.');
    const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
    expect(error).toBeInstanceOf(MetricCleanupError);
    expect(error).toMatchObject({
      cleanupConfirmed: false,
      completed: {
        evaluation: { status: 'evaluated', score: 1, pass: true, rationale: REDACTED },
        secrets: [],
      },
    });

    if (!(error instanceof MetricCleanupError)) throw new Error('Expected metric cleanup error.');
    expect(error.cleanupCause.reasons.find(Cause.isFailReason)?.error).toMatchObject({
      cause: cleanupFailure,
    });
    expect(inspect(exit, { depth: null })).not.toContain(secret);
  } finally {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
