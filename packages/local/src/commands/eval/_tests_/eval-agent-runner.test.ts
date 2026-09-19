import { AGENT_PROTOCOL, TRACE_SCHEMA_ID, type AgentRequest } from '@attest/contracts';
import type { InvocationResult } from '@attest/runtime';
import { describe, expect, it } from 'vitest';

import { redactAgentRequest, redactInvocation } from '../eval-agent-runner.js';

describe('redactAgentRequest', () => {
  it('preserves durable identities when a short environment secret occurs inside them', () => {
    const request: AgentRequest = {
      protocol: AGENT_PROTOCOL,
      run_id: '01M2BMD0VD0W58PDMNDVVJH9HX',
      case_id: 'plan-1',
      input: { round: 1, token: 'secret-value' },
      params: { api_key: 'unlisted-secret', model: 'safe' },
      messages: [
        { role: 'user', content: 'secret-value' },
        { role: 'assistant', content: 'safe' },
      ],
      turn_index: 1,
      conversation_id: 'conversation-1',
      state: { token: 'secret-value' },
    };

    expect(redactAgentRequest(request, ['1', 'secret-value'])).toEqual({
      protocol: AGENT_PROTOCOL,
      run_id: '01M2BMD0VD0W58PDMNDVVJH9HX',
      case_id: 'plan-1',
      input: { round: 1, token: '[REDACTED]' },
      params: { api_key: '[REDACTED]', model: 'safe' },
      messages: [
        { role: 'user', content: '[REDACTED]' },
        { role: 'assistant', content: 'safe' },
      ],
      turn_index: 1,
      conversation_id: 'conversation-1',
      state: { token: '[REDACTED]' },
    });
  });

  it('redacts payload text without corrupting protocol, warning, status, or trace fields', () => {
    const timestamp = '2026-09-19T10:00:00.000Z';
    const warning = {
      code: 'unknown_field' as const,
      path: 'secret-value',
      message: 'secret-value',
    };
    const attempt: InvocationResult['attempts'][number] = {
      status: 'ok',
      raw: { protocol: AGENT_PROTOCOL, status: 'ok', payload: 'secret-value' },
      report: {
        ok: true,
        value: {
          protocol: AGENT_PROTOCOL,
          output: { status: 'ok', token: 'secret-value' },
          trace: {
            schema: TRACE_SCHEMA_ID,
            trace_id: 'trace-secret-value',
            spans: [
              {
                span_id: 'span-secret-value',
                parent_span_id: null,
                name: 'secret-value',
                kind: 'agent',
                start_time: timestamp,
                end_time: timestamp,
                status: { code: 'ok', message: 'secret-value' },
                attributes: { note: 'secret-value', token: 'unlisted-secret' },
                input: { token: 'secret-value' },
                output: { text: 'secret-value' },
              },
            ],
          },
        },
        warnings: [warning],
      },
      diagnostics: {
        stderrExcerpt: 'secret-value',
        httpStatus: 200,
        remoteJobId: 'ok',
        sandboxError: 'secret-value',
        lifecycleError: 'secret-value',
        sandboxCleanupConfirmed: false,
        sandboxCompletionConfirmed: false,
      },
      durationMs: 1,
      rawExcerpt: { text: 'secret-value', truncated: false },
      warnings: [warning],
    };
    const invocation: InvocationResult = { ...attempt, attempts: [attempt] };

    const redacted = redactInvocation(invocation, [
      'unknown_field',
      'ok',
      AGENT_PROTOCOL,
      TRACE_SCHEMA_ID,
      timestamp,
      'secret-value',
    ]);

    expect(redacted.status).toBe('ok');
    expect(redacted.diagnostics).toEqual({
      stderrExcerpt: '[REDACTED]',
      httpStatus: 200,
      remoteJobId: 'ok',
      sandboxError: '[REDACTED]',
      lifecycleError: '[REDACTED]',
      sandboxCleanupConfirmed: false,
      sandboxCompletionConfirmed: false,
    });
    expect(redacted.rawExcerpt).toEqual({ text: '[REDACTED]', truncated: false });
    expect(redacted.warnings).toEqual([
      { code: 'unknown_field', path: 'secret-value', message: '[REDACTED]' },
    ]);
    if (redacted.status !== 'ok' || redacted.report?.ok !== true) throw new Error('unreachable');
    const response = redacted.report.value;
    expect(response.protocol).toBe(AGENT_PROTOCOL);
    if (!('output' in response)) throw new Error('unreachable');
    expect(response.output).toEqual({ status: '[REDACTED]', token: '[REDACTED]' });
    expect(response.trace?.schema).toBe(TRACE_SCHEMA_ID);
    expect(response.trace?.trace_id).toBe('trace-secret-value');
    expect(response.trace?.spans[0]).toMatchObject({
      span_id: 'span-secret-value',
      start_time: timestamp,
      end_time: timestamp,
      name: '[REDACTED]',
      status: { code: 'ok', message: '[REDACTED]' },
      attributes: { note: '[REDACTED]', token: '[REDACTED]' },
      input: { token: '[REDACTED]' },
      output: { text: '[REDACTED]' },
    });
  });
});
