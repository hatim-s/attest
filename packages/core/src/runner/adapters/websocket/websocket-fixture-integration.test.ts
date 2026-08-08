import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_VERSION,
  type AgentRequest,
  type WebSocketAttemptEvidence,
} from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  startWebSocketFixtureServer,
  type WebSocketFixtureScenarioName,
  type WebSocketFixtureServer,
} from '../../fixtures/websocket-fake-server.js';
import { startWebSocketAgent, type WebSocketAgentResource } from './websocket-adapter.js';

const fixtures: WebSocketFixtureServer[] = [];

/** Creates the frozen runtime resource shape used across hostile fixture scenarios. */
const agent = (
  url: string,
  transport: Partial<WebSocketAgentResource['transport']> = {},
  resource: Partial<WebSocketAgentResource> = {},
): WebSocketAgentResource => ({
  schema: AGENT_RESOURCE_SCHEMA_VERSION,
  id: 'fixture-websocket-agent',
  name: 'Fixture WebSocket agent',
  transport: {
    kind: 'websocket',
    lifecycle: 'per_run',
    connection_mode: 'multiplexed',
    framing: 'text_json',
    url,
    request_template: { type: 'invoke', request_id: '{{request_id}}' },
    request_id_pointer: '/request_id',
    acknowledgement_pointer: '/type',
    acknowledgement_values: ['acknowledgement'],
    result_pointer: '/result',
    error_pointer: '/error',
    trace_pointer: '/trace',
    open_timeout_ms: 200,
    message_idle_timeout_ms: 100,
    attempt_timeout_ms: 500,
    ping_interval_ms: 25,
    close_timeout_ms: 100,
    retry_boundary: 'before_acknowledgement',
    replay_after_acknowledgement: false,
    ...transport,
  },
  ...resource,
});

/** Produces one stable native request for correlation and cancellation assertions. */
const request = (caseId: string): AgentRequest => ({
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: caseId,
  input: { case: caseId },
});

/** Starts and tracks one hostile endpoint so failures cannot leak local sockets. */
const start = async (
  scenario: WebSocketFixtureScenarioName,
  options: Parameters<typeof startWebSocketFixtureServer>[1] = {},
): Promise<WebSocketFixtureServer> => {
  const fixture = await startWebSocketFixtureServer(scenario, options);
  fixtures.push(fixture);
  return fixture;
};

/** Reads the frozen evidence envelope retained by every adapter attempt. */
const evidence = (value: { rawExcerpt?: { text: string } }): WebSocketAttemptEvidence =>
  JSON.parse(value.rawExcerpt?.text ?? '{}') as WebSocketAttemptEvidence;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('WebSocket runtime and hostile fixture integration', () => {
  it('preserves serial, multiplexed, and per-case connection behavior', async () => {
    const serialFixture = await start('serial_correlation');
    const serial = await startWebSocketAgent(
      agent(serialFixture.url, { connection_mode: 'serial' }),
    );
    try {
      const serialResults = await Promise.all([
        serial.invoke(request('serial-one')),
        serial.invoke(request('serial-two')),
      ]);
      expect(serialResults.every((result) => result.status === 'ok')).toBe(true);
      expect(
        serialFixture.events().filter((event) => event.type === 'connection_opened'),
      ).toHaveLength(1);
    } finally {
      await serial.close();
    }

    const multiplexedFixture = await start('multiplexed_out_of_order');
    const multiplexed = await startWebSocketAgent(agent(multiplexedFixture.url));
    try {
      const multiplexedResults = await Promise.all([
        multiplexed.invoke(request('multiplexed-one')),
        multiplexed.invoke(request('multiplexed-two')),
      ]);
      expect(multiplexedResults.every((result) => result.status === 'ok')).toBe(true);
      expect(
        multiplexedFixture.events().filter((event) => event.type === 'connection_opened'),
      ).toHaveLength(1);
    } finally {
      await multiplexed.close();
    }

    const perCaseFixture = await start('serial_correlation');
    const perCase = await startWebSocketAgent(
      agent(perCaseFixture.url, { connection_mode: 'serial', lifecycle: 'per_case' }),
    );
    try {
      const perCaseResults = await Promise.all([
        perCase.invoke(request('per-case-one')),
        perCase.invoke(request('per-case-two')),
      ]);
      expect(perCaseResults.every((result) => result.status === 'ok')).toBe(true);
      expect(
        perCaseFixture.events().filter((event) => event.type === 'connection_opened'),
      ).toHaveLength(2);
    } finally {
      await perCase.close();
    }
  });

  it('replays only a pre-acknowledgement disconnect', async () => {
    const beforeAckFixture = await start('disconnect_before_ack_then_reconnect');
    const beforeAck = await startWebSocketAgent(
      agent(beforeAckFixture.url, {}, { retry: { retries: 1, backoff: { kind: 'none' } } }),
    );
    try {
      const replayed = await beforeAck.invoke(request('before-ack'));
      expect(replayed.status).toBe('ok');
      expect(replayed.attempts).toHaveLength(2);
    } finally {
      await beforeAck.close().catch(() => undefined);
    }

    const afterAckFixture = await start('ack_then_disconnect');
    const afterAck = await startWebSocketAgent(
      agent(afterAckFixture.url, {}, { retry: { retries: 1, backoff: { kind: 'none' } } }),
    );
    try {
      const failed = await afterAck.invoke(request('after-ack'));
      expect(failed.status).toBe('invocation_error');
      expect(failed.attempts).toHaveLength(1);
      expect(evidence(failed)).toMatchObject({
        acknowledgement: { state: 'acknowledged' },
        error_classification: 'unexpected_close',
      });
    } finally {
      await afterAck.close().catch(() => undefined);
    }
  });

  it('keeps protocol ping/pong separate from idle timeout and cancellation', async () => {
    const pingFixture = await start('ping_pong');
    const pingSession = await startWebSocketAgent(
      agent(pingFixture.url, {
        attempt_timeout_ms: 200,
        message_idle_timeout_ms: 60,
        ping_interval_ms: 10,
      }),
    );
    try {
      const idle = await pingSession.invoke(request('idle'));
      expect(idle.status).toBe('invocation_error');
      expect(evidence(idle)).toMatchObject({ error_classification: 'message_idle_timeout' });
      expect(pingFixture.events().some((event) => event.type === 'pong_received')).toBe(true);
    } finally {
      await pingSession.close().catch(() => undefined);
    }

    const cancellationFixture = await start('idle');
    const cancellationSession = await startWebSocketAgent(agent(cancellationFixture.url));
    const controller = new AbortController();
    const cancelled = cancellationSession.invoke(request('cancelled'), controller.signal);
    await cancellationFixture.waitForEvent((event) => event.type === 'request_received');
    controller.abort();
    const cancellationResult = await cancelled;
    expect(cancellationResult.status).toBe('invocation_error');
    expect(evidence(cancellationResult)).toMatchObject({ error_classification: 'cancelled' });
    await cancellationSession.close().catch(() => undefined);
  });

  it('cancels a delayed per-case open before a closed session can send', async () => {
    const fixture = await start('delayed_open', { openDelayMs: 80 });
    const session = await startWebSocketAgent(
      agent(fixture.url, { connection_mode: 'serial', lifecycle: 'per_case' }),
    );
    const invocation = session.invoke(request('closed-during-open'));
    await fixture.waitForEvent((event) => event.type === 'upgrade_requested');
    await session.close();
    const result = await invocation;
    expect(result.status).toBe('invocation_error');
    expect(evidence(result)).toMatchObject({ error_classification: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.events().some((event) => event.type === 'request_received')).toBe(false);
  });

  it.each([
    ['binary_frame', 'binary_frame_unsupported'],
    ['malformed_json', 'invalid_json'],
    ['unmatched_json', 'uncorrelated_server_work'],
    ['uncorrelated_server_work', 'uncorrelated_server_work'],
  ] as const)('rejects %s as %s', async (scenario, classification) => {
    const fixture = await start(scenario);
    const session = await startWebSocketAgent(agent(fixture.url));
    try {
      const result = await session.invoke(request(scenario));
      expect(result.status).toBe('invocation_error');
      expect(evidence(result)).toMatchObject({ error_classification: classification });
    } finally {
      await session.close().catch(() => undefined);
    }
  });
});
