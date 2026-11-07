import { AGENT_PROTOCOL, type JsonValue } from '@attest/contracts';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Exit from 'effect/Exit';
import * as Effect from 'effect/Effect';
import { describe, expect, it, vi } from 'vitest';

import { AgentInvocationError, type InvocationErrorCode } from '../../errors.js';
import type { InvocationAttempt } from '../../types.js';
import { getInvocationPriorAttempts, invokeWithRetries } from '../invocation-retry.js';

const failure = (
  code: InvocationErrorCode,
  httpStatus?: number,
): Extract<InvocationAttempt, { status: 'invocation_error' }> => ({
  status: 'invocation_error',
  error: new AgentInvocationError(code, `${code} failure`),
  diagnostics: httpStatus === undefined ? {} : { httpStatus },
  durationMs: 1,
  warnings: [],
});

const success = (raw: JsonValue): InvocationAttempt => ({
  status: 'ok',
  raw,
  diagnostics: {},
  durationMs: 1,
  warnings: [],
});

/** Replays a fixed attempt sequence, repeating the last attempt once the sequence runs out. */
const sequence = (...attempts: InvocationAttempt[]) =>
  vi.fn((attemptIndex: number) =>
    Effect.succeed(attempts[Math.min(attemptIndex, attempts.length - 1)]!),
  );

describe('invokeWithRetries', () => {
  it('retries a 5xx status and retains every attempt', async () => {
    const invokeOnce = sequence(failure('http_status', 500));
    const result = await Effect.runPromise(invokeWithRetries(invokeOnce, 1));

    expect(result.status).toBe('invocation_error');
    expect(result.attempts).toHaveLength(2);
    expect(invokeOnce).toHaveBeenCalledTimes(2);
  });

  it.each([404, 302, 307, 308])('does not retry HTTP %i', async (status) => {
    const result = await Effect.runPromise(
      invokeWithRetries(sequence(failure('http_status', status)), 3),
    );

    expect(result).toMatchObject({
      status: 'invocation_error',
      diagnostics: { httpStatus: status },
    });
    expect(result.attempts).toHaveLength(1);
  });

  it('does not retry cancellation', async () => {
    const result = await Effect.runPromise(invokeWithRetries(sequence(failure('cancelled')), 2));

    expect(result).toMatchObject({ status: 'invocation_error', error: { code: 'cancelled' } });
    expect(result.attempts).toHaveLength(1);
  });

  it('does not replay work whose execution has started when cleanup is unconfirmed', async () => {
    const error = new AgentInvocationError('network', 'HTTP cleanup was not confirmed.', {
      applicationStarted: true,
      cause: { success: 'remote response' },
    });

    const invokeOnce = sequence({ ...failure('network'), error });
    const result = await Effect.runPromise(invokeWithRetries(invokeOnce, 3));

    expect(result).toMatchObject({ status: 'invocation_error', error });
    expect(result.attempts).toHaveLength(1);
    expect(invokeOnce).toHaveBeenCalledOnce();
  });

  it('retries other invocation errors and reports the final attempt', async () => {
    const result = await Effect.runPromise(
      invokeWithRetries(sequence(failure('network'), failure('nonzero_exit')), 1),
    );

    expect(result).toMatchObject({ status: 'invocation_error', error: { code: 'nonzero_exit' } });
    expect(result.durationMs).toBe(result.attempts[1]?.durationMs);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      'invocation_error',
      'invocation_error',
    ]);
  });

  it('retries schema-invalid envelopes as invocation errors with their warnings', async () => {
    const result = await Effect.runPromise(
      invokeWithRetries(sequence(success({ protocol: AGENT_PROTOCOL, vendor_field: true })), 1),
    );

    expect(result).toMatchObject({
      status: 'invocation_error',
      error: { code: 'invalid_envelope' },
    });
    expect(result.attempts).toHaveLength(2);

    for (const attempt of result.attempts) {
      expect(attempt.rawExcerpt?.text.length).toBeGreaterThan(0);
      expect(attempt.warnings[0]?.code).toBe('unknown_field');
    }
  });

  it('does not retry a valid agent error envelope', async () => {
    const result = await Effect.runPromise(
      invokeWithRetries(
        sequence(success({ protocol: AGENT_PROTOCOL, error: { message: 'agent failed' } })),
        2,
      ),
    );

    expect(result).toMatchObject({ status: 'ok', report: { ok: true } });
    expect(result.attempts).toHaveLength(1);
  });

  it('does not retry a sandbox command whose completion was not confirmed', async () => {
    const unconfirmed = {
      ...failure('network'),
      diagnostics: { sandboxCompletionConfirmed: false },
    };

    const result = await Effect.runPromise(invokeWithRetries(sequence(unconfirmed), 2));

    expect(result.attempts).toHaveLength(1);
  });

  it('propagates a typed infrastructure error without treating it as an attempt', async () => {
    const error = new AgentInvocationError('network', 'Infrastructure unavailable');
    const invokeOnce = vi.fn(() => Effect.fail(error));
    const exit = await Effect.runPromiseExit(invokeWithRetries(invokeOnce, 3));

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error);
    expect(invokeOnce).toHaveBeenCalledOnce();
  });

  it('preserves defects without retrying them', async () => {
    const defect = new Error('Broken attempt invariant');
    const invokeOnce = vi.fn(() => Effect.die(defect));
    const exit = await Effect.runPromiseExit(invokeWithRetries(invokeOnce, 3));

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }

    expect(invokeOnce).toHaveBeenCalledOnce();
  });

  it('keeps callback service requirements until the caller supplies them', async () => {
    const Attempt = Context.Service<InvocationAttempt>('RetryTestAttempt');
    const operation = invokeWithRetries(() => Attempt, 0);

    const result = await Effect.runPromise(
      Effect.provideService(
        operation,
        Attempt,
        success({ protocol: AGENT_PROTOCOL, output: 'provided' }),
      ),
    );

    expect(result).toMatchObject({ status: 'ok', attempts: [{ status: 'ok' }] });
  });
});

it('retains earlier retry evidence on later failed Effects without replay or Cause mutation', async () => {
  const first = failure('network');
  const error = new Error('second attempt cleanup');
  const defect = new Error('release defect');
  const original = Cause.combine(Cause.fail(error), Cause.die(defect));

  const invokeOnce = vi.fn((index: number) =>
    index === 0 ? Effect.succeed(first) : Effect.failCause(original),
  );

  const exit = await Effect.runPromiseExit(invokeWithRetries(invokeOnce, 4));
  expect(invokeOnce).toHaveBeenCalledTimes(2);
  expect(Exit.isFailure(exit)).toBe(true);

  if (Exit.isFailure(exit)) {
    expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(
      original.reasons.map((reason) => reason._tag),
    );
    expect(
      exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error === error),
    ).toBe(true);
    expect(
      exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect),
    ).toBe(true);
    expect(getInvocationPriorAttempts(exit.cause)).toMatchObject([first]);
    expect(getInvocationPriorAttempts(original)).toEqual([]);
    expect(Object.isFrozen(getInvocationPriorAttempts(exit.cause))).toBe(true);
  }
});
