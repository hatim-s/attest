import { openGuardedResponse } from '../guarded-response.js';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { withHttpCleanup, withHttpSignal, HttpCleanup } from '../http-effects.js';
import { requestWithRetries } from '../mapped-http-execution.js';
// EFFECT-ROOT: owned HTTP fixture execution.
import type { Socket } from 'node:net';

import { expect, it, vi } from 'vitest';

import { startLoopbackServer } from '../../../_tests_/support/loopback-server.js';
import { AgentInvocationError } from '../../../errors.js';
import { openPinnedRequest } from '../pinned-request.js';

it('rejects an unsolicited upgrade and closes its socket', async () => {
  let peer: Socket | undefined;
  let closed: Promise<void> | undefined;

  const fixture = await startLoopbackServer((request, response) => {
    peer = request.socket;
    closed = new Promise((resolve) => request.socket.once('close', resolve));
    response.writeHead(101, { connection: 'Upgrade', upgrade: 'unexpected' });
    response.flushHeaders();
  });

  try {
    await expect(
      Effect.runPromise(
        openPinnedRequest(
          {
            url: new URL(fixture.url),
            address: '127.0.0.1',
            family: 4,
            loopback: true,
          },
          {
            method: 'GET',
            headers: {},
            signal: AbortSignal.timeout(1_000),
            firstByteTimeoutMs: 1_000,
            errors: {
              aborted: () => new AgentInvocationError('timeout', 'Request aborted.'),
              firstByteTimeout: () => new AgentInvocationError('timeout', 'Headers timed out.'),
              failed: (cause) => new AgentInvocationError('network', 'Request failed.', { cause }),
            },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'network' });
    expect(closed).toBeDefined();
    await closed;
    expect(peer?.destroyed).toBe(true);
  } finally {
    peer?.destroy();
    await fixture.close();
  }
});

it('keeps primary defects and cleanup defects separately without skipping later cleanup', async () => {
  const primary = new Error('primary defect');
  const cleanup = new Error('cleanup defect');
  let released = false;

  const outcome = await Effect.runPromiseExit(
    withHttpCleanup(Effect.die(primary), [
      Effect.die(cleanup),
      Effect.sync(() => {
        released = true;
      }),
    ]),
  );

  expect(released).toBe(true);
  expect(Exit.isFailure(outcome)).toBe(true);

  if (Exit.isFailure(outcome)) {
    expect(
      outcome.cause.reasons.some((reason) => reason._tag === 'Die' && reason.defect === primary),
    ).toBe(true);
    const diagnostics = Context.getOrUndefined(Cause.annotations(outcome.cause), HttpCleanup);
    expect(diagnostics?.some(Exit.isFailure)).toBe(true);
  }
});

it('retains successful evidence when cleanup fails', async () => {
  const evidence = { raw: 'completed response' };
  const cleanup = new Error('cleanup rejected');

  const outcome = await Effect.runPromiseExit(
    withHttpCleanup(Effect.succeed(evidence), [Effect.fail(cleanup)]),
  );

  expect(Exit.isFailure(outcome)).toBe(true);

  if (Exit.isFailure(outcome)) {
    const failure = outcome.cause.reasons.find((reason) => reason._tag === 'Fail');
    expect(failure?.error).toMatchObject({
      applicationStarted: true,
      cause: { success: evidence },
    });
  }
});

it('retains every nested cleanup diagnostic on a primary defect', async () => {
  const primary = new Error('primary defect');
  const inner = new Error('inner release');
  const outer = new Error('outer release');

  const outcome = await Effect.runPromiseExit(
    withHttpCleanup(withHttpCleanup(Effect.die(primary), [Effect.die(inner)]), [Effect.die(outer)]),
  );

  expect(Exit.isFailure(outcome)).toBe(true);

  if (Exit.isFailure(outcome)) {
    expect(Cause.squash(outcome.cause)).toBe(primary);
    const diagnostics = Context.getOrUndefined(Cause.annotations(outcome.cause), HttpCleanup);
    expect(diagnostics?.filter(Exit.isFailure).map((exit) => Cause.squash(exit.cause))).toEqual([
      inner,
      outer,
    ]);
  }
});

it('captures deadline-owner cleanup defects without replacing the primary failure', async () => {
  const first = new AbortController();
  const second = new AbortController();
  const primary = new AgentInvocationError('network', 'primary transport failure');
  const cleanup = new Error('listener release failed');

  const removeFirst = vi.spyOn(first.signal, 'removeEventListener').mockImplementation(() => {
    throw cleanup;
  });

  const removeSecond = vi.spyOn(second.signal, 'removeEventListener');

  try {
    const outcome = await Effect.runPromiseExit(
      withHttpSignal(1_000, [first.signal, second.signal], () => Effect.fail(primary)),
    );

    expect(removeSecond).toHaveBeenCalled();
    expect(Exit.isFailure(outcome)).toBe(true);

    if (Exit.isFailure(outcome)) {
      expect(Cause.hasDies(outcome.cause)).toBe(false);
      expect(Cause.squash(outcome.cause)).toBe(primary);
      const diagnostics = Context.getOrUndefined(Cause.annotations(outcome.cause), HttpCleanup);
      expect(diagnostics?.filter(Exit.isFailure).map((exit) => Cause.squash(exit.cause))).toContain(
        cleanup,
      );
    }
  } finally {
    removeFirst.mockRestore();
    removeSecond.mockRestore();
  }
});

it('preserves mapped transport defects instead of making them retryable attempts', async () => {
  const defect = new Error('host defect');

  const result = await Effect.runPromiseExit(
    requestWithRetries(
      { url: 'http://127.0.0.1', method: 'GET', headers: {} },
      {
        policy: {
          attemptSignal: new AbortController().signal,
          connectTimeoutMs: 100,
          firstByteTimeoutMs: 100,
          responseBodyTimeoutMs: 100,
          responseCapBytes: 100,
          secrets: [],
        },
        retry: { retries: 3, backoff: { kind: 'none' } },
        signal: new AbortController().signal,
        retryAttempts: [],
        requestJson: () => Effect.die(defect),
      },
      { allowRetry: true, delayFor: () => 0 },
    ),
  );

  expect(Exit.isFailure(result)).toBe(true);

  if (Exit.isFailure(result))
    expect(
      result.cause.reasons.some((reason) => reason._tag === 'Die' && reason.defect === defect),
    ).toBe(true);
});

it('keeps a synchronous guarded host failure in the defect channel', async () => {
  const defect = new Error('host programming failure');

  const outcome = await Effect.runPromiseExit(
    openGuardedResponse(
      () => {
        throw defect;
      },
      {
        url: 'http://127.0.0.1',
        method: 'GET',
        headers: {},
      },
      new AbortController().signal,
      100,
    ),
  );

  expect(Exit.isFailure(outcome)).toBe(true);

  if (Exit.isFailure(outcome))
    expect(
      outcome.cause.reasons.some((reason) => reason._tag === 'Die' && reason.defect === defect),
    ).toBe(true);
});

it('releases a body arriving after bounded header observation and retains late rejection evidence', async () => {
  let deliver: ((response: Response) => void) | undefined;

  const pending = new Promise<Response>((resolve) => {
    deliver = resolve;
  });

  const releaseFailure = new Error('late body cancel rejected');
  const cancel = vi.fn(() => Promise.reject(releaseFailure));

  const outcome = await Effect.runPromiseExit(
    openGuardedResponse(
      () => pending,
      { url: 'https://guarded.invalid', method: 'POST', headers: {} },
      new AbortController().signal,
      5,
    ),
  );

  expect(Exit.isFailure(outcome)).toBe(true);

  if (!Exit.isFailure(outcome)) throw new Error('Expected header timeout');
  const error = Cause.squash(outcome.cause);
  expect(error).toMatchObject({ code: 'timeout', applicationStarted: true });
  expect(
    Context.getOrUndefined(Cause.annotations(outcome.cause), HttpCleanup)?.some(Exit.isFailure),
  ).toBe(true);
  deliver?.(new Response(new ReadableStream({ cancel })));
  await Promise.resolve();
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(error).toMatchObject({
      cause: {
        primary: {
          receipt: {
            headers: 'received',
            cleanup: 'failed',
            failure: releaseFailure,
          },
        },
      },
    }),
  );
});

it('closes the pinned socket when native header observation expires after dispatch', async () => {
  let closed: Promise<void> | undefined;

  const fixture = await startLoopbackServer((request) => {
    closed = new Promise((resolve) => request.socket.once('close', resolve));
  });

  try {
    await expect(
      Effect.runPromise(
        openPinnedRequest(
          {
            url: new URL(fixture.url),
            address: '127.0.0.1',
            family: 4,
            loopback: true,
          },
          {
            method: 'POST',
            headers: {},
            body: '{}',
            signal: new AbortController().signal,
            firstByteTimeoutMs: 50,
            errors: {
              aborted: () => new AgentInvocationError('cancelled', 'aborted'),
              firstByteTimeout: () => new AgentInvocationError('timeout', 'headers expired'),
              failed: (cause) => new AgentInvocationError('network', 'failed', { cause }),
            },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'timeout', applicationStarted: true });
    expect(closed).toBeDefined();
    await closed;
  } finally {
    await fixture.close();
  }
});

it('prohibits replay after primary failure plus cleanup failure without replacing the primary', async () => {
  const primary = new AgentInvocationError('network', 'body failed', {
    rawExcerpt: { text: 'partial', truncated: false, sha256: 'hash' },
  });

  const cleanup = new Error('cancel failed');

  const outcome = await Effect.runPromiseExit(
    withHttpCleanup(Effect.fail(primary), [Effect.fail(cleanup)]),
  );

  expect(Exit.isFailure(outcome)).toBe(true);

  if (Exit.isFailure(outcome)) {
    expect(Cause.squash(outcome.cause)).toBe(primary);
    expect(primary).toMatchObject({
      applicationStarted: true,
      rawExcerpt: { text: 'partial' },
      cause: { cleanup: [expect.objectContaining({ _tag: 'Failure' })] },
    });
  }
});

it('releases guarded headers that arrive after fiber interruption without extending the owner forever', async () => {
  let deliver: ((response: Response) => void) | undefined;

  const pending = new Promise<Response>((resolve) => {
    deliver = resolve;
  });

  const cancel = vi.fn(() => new Promise<void>(() => {}));

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          openGuardedResponse(
            () => pending,
            { url: 'https://guarded.invalid', method: 'POST', headers: {} },
            new AbortController().signal,
            10_000,
          ),
        );
        yield* Effect.sleep(10);
      }),
    ),
  );
  deliver?.(new Response(new ReadableStream({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});
