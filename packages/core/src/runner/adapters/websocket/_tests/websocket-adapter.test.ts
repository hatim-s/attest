import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  type AgentRequest,
  type WebSocketAttemptEvidence,
} from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startWebSocketAgent, type WebSocketAgentResource } from '../websocket-adapter.js';
import { startTestWebSocketServer } from './support/test-websocket-server.js';

type Fixture = Awaited<ReturnType<typeof startTestWebSocketServer>>;

const fixtures: Fixture[] = [];
const request = (caseId: string, input: unknown): AgentRequest => ({
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: caseId,
  input: input as AgentRequest['input'],
});
const agent = (
  url: string,
  overrides: Partial<WebSocketAgentResource> = {},
): WebSocketAgentResource => ({
  schema: AGENT_RESOURCE_SCHEMA_ID,
  id: 'websocket-agent',
  name: 'WebSocket agent',
  transport: {
    kind: 'websocket',
    lifecycle: 'per_run',
    connection_mode: 'multiplexed',
    framing: 'text_json',
    url,
    request_template: { type: 'invoke', request_id: '{{request_id}}' },
    request_id_pointer: '/request_id',
    acknowledgement_pointer: '/ack',
    acknowledgement_values: [true],
    result_pointer: '/result',
    error_pointer: '/error',
    trace_pointer: '/trace',
    open_timeout_ms: 200,
    message_idle_timeout_ms: 200,
    attempt_timeout_ms: 500,
    ping_interval_ms: 25,
    close_timeout_ms: 100,
    retry_boundary: 'before_acknowledgement',
    replay_after_acknowledgement: false,
  },
  ...overrides,
});

const evidence = (value: { rawExcerpt?: { text: string } }): WebSocketAttemptEvidence =>
  JSON.parse(value.rawExcerpt?.text ?? '{}') as WebSocketAttemptEvidence;
const failureClassification = (value: { rawExcerpt?: { text: string } }): string | undefined => {
  const parsed = evidence(value);
  return parsed.outcome === 'completed' ? undefined : parsed.error_classification;
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('WebSocket adapter', () => {
  it('correlates multiplexed results, extracts traces, redacts evidence, and resolves headers', async () => {
    let observedAuthorization: string | undefined;
    const fixture = await startTestWebSocketServer({
      subprotocol: 'attest-json',
      onConnection: (_peer, upgrade) => {
        observedAuthorization = upgrade.headers.authorization;
      },
      onMessage: (peer, raw) => {
        const message = raw as {
          request: AgentRequest;
          request_id: string;
        };
        if (message.request.case_id === 'error') {
          peer.sendJson({
            request_id: message.request_id,
            ack: true,
            error: { code: 'refused', message: 'remote refusal' },
          });
          return;
        }
        const delay = message.request.case_id === 'slow' ? 30 : 1;
        setTimeout(
          () =>
            peer.sendJson({
              request_id: message.request_id,
              ack: true,
              result: message.request.input,
              trace: { schema: 'attest.trace', spans: [] },
              secret: 'transport-secret',
            }),
          delay,
        );
      },
    });
    fixtures.push(fixture);
    const configured = agent(fixture.url, {
      transport: {
        ...agent(fixture.url).transport,
        headers: { Authorization: { from_env: 'AGENT_TOKEN' } },
        subprotocol: 'attest-json',
      },
      redaction: { event_pointers: ['/secret'] },
    });
    const session = await startWebSocketAgent(configured, {
      headers: { Authorization: 'Bearer transport-secret' },
      secrets: ['transport-secret'],
    });
    try {
      const [slow, fast, remoteError] = await Promise.all([
        session.invoke(request('slow', { value: 'slow' })),
        session.invoke(request('fast', { value: 'fast' })),
        session.invoke(request('error', null)),
      ]);
      expect(slow.status).toBe('ok');
      expect(fast.status).toBe('ok');
      if (slow.status === 'ok' && slow.report?.ok && 'output' in slow.report.value) {
        expect(slow.report.value.output).toEqual({ value: 'slow' });
      }
      expect(observedAuthorization).toBe('Bearer transport-secret');
      expect(remoteError.status).toBe('ok');
      if (remoteError.status === 'ok' && remoteError.report?.ok) {
        expect(remoteError.report.value).toMatchObject({
          error: { code: 'refused', message: 'remote refusal' },
        });
      }
      expect(fast.rawExcerpt?.text).not.toContain('transport-secret');
      expect(fast.rawExcerpt?.text).toContain('[REDACTED]');
      expect(evidence(fast).acknowledgement.state).toBe('acknowledged');
    } finally {
      await session.close();
    }
  });

  it('serializes run-scoped serial work and opens one connection per per-case invocation', async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const fixture = await startTestWebSocketServer({
      onMessage: (peer, raw) => {
        const message = raw as { request_id: string };
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          peer.sendJson({ request_id: message.request_id, ack: true, result: 'done' });
        }, 15);
      },
    });
    fixtures.push(fixture);
    const serial = await startWebSocketAgent(
      agent(fixture.url, {
        transport: { ...agent(fixture.url).transport, connection_mode: 'serial' },
      }),
    );
    await Promise.all([serial.invoke(request('one', 'one')), serial.invoke(request('two', 'two'))]);
    expect(maximumInFlight).toBe(1);
    expect(fixture.connectionCount()).toBe(1);
    await serial.close();

    const perCase = await startWebSocketAgent(
      agent(fixture.url, {
        transport: {
          ...agent(fixture.url).transport,
          lifecycle: 'per_case',
          connection_mode: 'serial',
        },
      }),
    );
    await Promise.all([
      perCase.invoke(request('three', 'three')),
      perCase.invoke(request('four', 'four')),
    ]);
    expect(fixture.connectionCount()).toBe(3);
    await perCase.close();
  });

  it('cancels one multiplexed request without disturbing another or treating its late result as work', async () => {
    const fixture = await startTestWebSocketServer({
      onMessage: (peer, raw) => {
        const message = raw as { request: AgentRequest; request_id: string };
        const delay = message.request.case_id === 'cancel' ? 50 : 10;
        setTimeout(
          () => peer.sendJson({ request_id: message.request_id, ack: true, result: 'done' }),
          delay,
        );
      },
    });
    fixtures.push(fixture);
    const session = await startWebSocketAgent(agent(fixture.url));
    const controller = new AbortController();
    try {
      const cancelled = session.invoke(request('cancel', null), controller.signal);
      const kept = session.invoke(request('keep', null));
      setTimeout(() => controller.abort(), 5);
      const [cancelledResult, keptResult] = await Promise.all([cancelled, kept]);
      expect(cancelledResult.status).toBe('invocation_error');
      if (cancelledResult.status === 'invocation_error') {
        expect(cancelledResult.error.code).toBe('cancelled');
      }
      expect(keptResult.status).toBe('ok');
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      await session.close();
    }
  });

  it('reconnects and replays only before acknowledgement', async () => {
    const deliveries = new Map<string, number>();
    const fixture = await startTestWebSocketServer({
      onMessage: (peer, raw) => {
        const message = raw as { request: AgentRequest; request_id: string };
        const count = (deliveries.get(message.request.case_id) ?? 0) + 1;
        deliveries.set(message.request.case_id, count);
        if (message.request.case_id === 'before-ack' && count === 1) {
          peer.drop();
          return;
        }
        if (message.request.case_id === 'after-ack') {
          peer.sendJson({ request_id: message.request_id, ack: true });
          setTimeout(() => peer.drop(), 2);
          return;
        }
        peer.sendJson({ request_id: message.request_id, ack: true, result: 'replayed' });
      },
    });
    fixtures.push(fixture);
    const session = await startWebSocketAgent(
      agent(fixture.url, { retry: { retries: 1, backoff: { kind: 'none' } } }),
    );
    try {
      const replayed = await session.invoke(request('before-ack', null));
      expect(replayed.status).toBe('ok');
      expect(replayed.attempts).toHaveLength(2);
      expect(deliveries.get('before-ack')).toBe(2);

      const failed = await session.invoke(request('after-ack', null));
      expect(failed.status).toBe('invocation_error');
      expect(failed.attempts).toHaveLength(1);
      expect(deliveries.get('after-ack')).toBe(1);
      expect(evidence(failed).acknowledgement.state).toBe('acknowledged');
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it('keeps protocol pings separate from application-idle timeout', async () => {
    const fixture = await startTestWebSocketServer({ onMessage: () => undefined });
    fixtures.push(fixture);
    const session = await startWebSocketAgent(
      agent(fixture.url, {
        transport: {
          ...agent(fixture.url).transport,
          open_timeout_ms: 50,
          ping_interval_ms: 5,
          message_idle_timeout_ms: 30,
          attempt_timeout_ms: 100,
        },
      }),
    );
    try {
      const result = await session.invoke(request('idle', null));
      expect(result.status).toBe('invocation_error');
      if (result.status === 'invocation_error') expect(result.error.code).toBe('timeout');
      expect(failureClassification(result)).toBe('message_idle_timeout');
      expect(fixture.peers[0]?.pingCount).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('enforces distinct open and total-attempt deadlines', async () => {
    const blackhole = await startTestWebSocketServer({
      ignoreUpgrade: true,
      onMessage: () => undefined,
    });
    fixtures.push(blackhole);
    const opening = await startWebSocketAgent(
      agent(blackhole.url, {
        transport: {
          ...agent(blackhole.url).transport,
          open_timeout_ms: 20,
          message_idle_timeout_ms: 80,
          attempt_timeout_ms: 100,
          ping_interval_ms: 10,
        },
      }),
    );
    const openResult = await opening.invoke(request('open-timeout', null));
    expect(openResult.status).toBe('invocation_error');
    expect(failureClassification(openResult)).toBe('open_timeout');
    await opening.close();

    const intervals: NodeJS.Timeout[] = [];
    const acknowledging = await startTestWebSocketServer({
      onMessage: (peer, raw) => {
        const message = raw as { request_id: string };
        peer.sendJson({ request_id: message.request_id, ack: true });
        intervals.push(
          setInterval(() => peer.sendJson({ request_id: message.request_id, ack: true }), 15),
        );
      },
    });
    fixtures.push(acknowledging);
    const attempting = await startWebSocketAgent(
      agent(acknowledging.url, {
        transport: {
          ...agent(acknowledging.url).transport,
          open_timeout_ms: 20,
          message_idle_timeout_ms: 40,
          attempt_timeout_ms: 80,
          ping_interval_ms: 10,
        },
      }),
    );
    const attemptResult = await attempting.invoke(request('attempt-timeout', null));
    for (const interval of intervals) clearInterval(interval);
    expect(attemptResult.status).toBe('invocation_error');
    expect(failureClassification(attemptResult)).toBe('attempt_timeout');
    await attempting.close();
  });

  it.each([
    [
      'binary frames',
      (peer: Fixture['peers'][number]) => peer.sendBinary(),
      'binary_frame_unsupported',
    ],
    [
      'uncorrelated work',
      (peer: Fixture['peers'][number]) => peer.sendJson({ request_id: 'unknown', ack: true }),
      'uncorrelated_server_work',
    ],
    ['invalid JSON', (peer: Fixture['peers'][number]) => peer.sendText('{'), 'invalid_json'],
  ] as const)('rejects %s and fails outstanding work', async (_name, hostile, classification) => {
    const fixture = await startTestWebSocketServer({
      onMessage: (peer) => hostile(peer),
    });
    fixtures.push(fixture);
    const session = await startWebSocketAgent(agent(fixture.url));
    try {
      const result = await session.invoke(request('hostile', null));
      expect(result.status).toBe('invocation_error');
      expect(failureClassification(result)).toBe(classification);
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it('classifies an uncooperative per-case close handshake as a close timeout', async () => {
    const fixture = await startTestWebSocketServer({
      ignoreClientClose: true,
      onMessage: (peer, raw) => {
        const message = raw as { request_id: string };
        peer.sendJson({ request_id: message.request_id, ack: true, result: 'done' });
      },
    });
    fixtures.push(fixture);
    const configured = agent(fixture.url, {
      transport: {
        ...agent(fixture.url).transport,
        lifecycle: 'per_case',
        connection_mode: 'serial',
        close_timeout_ms: 20,
      },
    });
    const session = await startWebSocketAgent(configured);
    const result = await session.invoke(request('close-timeout', null));
    expect(result.status).toBe('invocation_error');
    expect(failureClassification(result)).toBe('close_timeout');
    await session.close();
  });

  it('rejects prohibited network targets, literal credentials, and unsupported runtime modes', async () => {
    const prohibited = await startWebSocketAgent(agent('ws://192.168.1.10/invoke'));
    const prohibitedResult = await prohibited.invoke(request('private', null));
    expect(prohibitedResult.status).toBe('invocation_error');
    if (prohibitedResult.status === 'invocation_error') {
      expect(prohibitedResult.error.message).toContain('prohibited network address');
    }
    await prohibited.close();

    expect(() =>
      startWebSocketAgent(
        agent('ws://127.0.0.1:1', {
          transport: {
            ...agent('ws://127.0.0.1:1').transport,
            headers: { Authorization: 'Bearer literal' },
          } as WebSocketAgentResource['transport'],
        }),
      ),
    ).toThrow('invalid or unsupported mode');

    expect(() =>
      startWebSocketAgent(
        agent('ws://127.0.0.1:1', {
          transport: {
            ...agent('ws://127.0.0.1:1').transport,
            framing: 'binary',
          } as unknown as WebSocketAgentResource['transport'],
        }),
      ),
    ).toThrow('invalid or unsupported mode');
  });
});
