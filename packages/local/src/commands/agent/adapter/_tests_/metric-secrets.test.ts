import { Cause, Context, Effect, Exit } from 'effect';
import { mkdtemp, open, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import { resolveProcessEnvironment } from '../metric-secrets.js';
import { MetricCleanupDiagnostics, withRelease } from '../metric-operation.js';

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
    withRelease(withRelease(Effect.fail(new Error('primary')), release), release),
  );

  if (Exit.isSuccess(exit)) throw new Error('Expected failure.');
  const recorded = Context.getOrUndefined(Cause.annotations(exit.cause), MetricCleanupDiagnostics);
  expect(recorded?.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([
    cleanup,
    cleanup,
  ]);
});
