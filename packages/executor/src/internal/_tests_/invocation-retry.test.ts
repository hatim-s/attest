import { AGENT_PROTOCOL } from '@attest/contracts';
import { describe, expect, it, vi } from 'vitest';

import { AgentInvocationError, type InvocationErrorCode } from '../../errors.js';
import type { InvocationAttempt } from '../../types.js';
import { invokeWithRetries } from '../invocation-retry.js';

const failure = (code: InvocationErrorCode, httpStatus?: number): InvocationAttempt => ({
  status: 'invocation_error',
  error: new AgentInvocationError(code, `${code} failure`),
  diagnostics: httpStatus === undefined ? {} : { httpStatus },
  durationMs: 1,
  warnings: [],
});

const success = (raw: unknown): InvocationAttempt => ({
  status: 'ok',
  raw,
  diagnostics: {},
  durationMs: 1,
  warnings: [],
});

/** Replays a fixed attempt sequence, repeating the last attempt once the sequence runs out. */
const sequence = (...attempts: InvocationAttempt[]) =>
  vi.fn((attemptIndex: number) =>
    Promise.resolve(attempts[Math.min(attemptIndex, attempts.length - 1)]!),
  );

describe('invokeWithRetries', () => {
  it('retries a 5xx status and retains every attempt', async () => {
    const invokeOnce = sequence(failure('http_status', 500));
    const result = await invokeWithRetries(invokeOnce, 1);

    expect(result.status).toBe('invocation_error');
    expect(result.attempts).toHaveLength(2);
    expect(invokeOnce).toHaveBeenCalledTimes(2);
  });

  it.each([404, 302, 307, 308])('does not retry HTTP %i', async (status) => {
    const result = await invokeWithRetries(sequence(failure('http_status', status)), 3);

    expect(result).toMatchObject({
      status: 'invocation_error',
      diagnostics: { httpStatus: status },
    });
    expect(result.attempts).toHaveLength(1);
  });

  it('does not retry cancellation', async () => {
    const result = await invokeWithRetries(sequence(failure('cancelled')), 2);

    expect(result).toMatchObject({ status: 'invocation_error', error: { code: 'cancelled' } });
    expect(result.attempts).toHaveLength(1);
  });

  it('retries other invocation errors and reports the final attempt', async () => {
    const result = await invokeWithRetries(
      sequence(failure('network'), failure('nonzero_exit')),
      1,
    );

    expect(result).toMatchObject({ status: 'invocation_error', error: { code: 'nonzero_exit' } });
    expect(result.durationMs).toBe(result.attempts[1]?.durationMs);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      'invocation_error',
      'invocation_error',
    ]);
  });

  it('retries schema-invalid envelopes as invocation errors with their warnings', async () => {
    const result = await invokeWithRetries(
      sequence(success({ protocol: AGENT_PROTOCOL, vendor_field: true })),
      1,
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
    const result = await invokeWithRetries(
      sequence(success({ protocol: AGENT_PROTOCOL, error: { message: 'agent failed' } })),
      2,
    );

    expect(result).toMatchObject({ status: 'ok', report: { ok: true } });
    expect(result.attempts).toHaveLength(1);
  });

  it('does not retry a sandbox command whose completion was not confirmed', async () => {
    const unconfirmed = {
      ...failure('network'),
      diagnostics: { sandboxCompletionConfirmed: false },
    };
    const result = await invokeWithRetries(sequence(unconfirmed), 2);

    expect(result.attempts).toHaveLength(1);
  });
});
