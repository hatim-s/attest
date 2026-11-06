import { parseWithSchema } from '../schema/parse.js';
import { describe, expect, it } from 'vitest';

import {
  WEBSOCKET_EVIDENCE_SCHEMA_ID,
  WEBSOCKET_MESSAGE_PROTOCOL,
  WEBSOCKET_REQUEST_PROTOCOL,
} from '../schema/identifiers.js';
import {
  webSocketCorrelatedMessageSchema,
  webSocketInvocationRequestSchema,
  webSocketTransportSchema,
  type WebSocketInvocationRequest,
  type WebSocketTransport,
} from '../agent/websocket-contract.js';
import {
  webSocketAttemptEvidenceSchema,
  type WebSocketAttemptEvidence,
} from '../agent/websocket-evidence.js';
import { requestIdSchema } from '../project/shared.js';

const validTransport: WebSocketTransport = {
  kind: 'websocket',
  lifecycle: 'per_run',
  connection_mode: 'multiplexed',
  framing: 'text_json',
  url: 'wss://agent.example.test/invoke',
  headers: { Authorization: { from_env: 'AGENT_TOKEN' } },
  subprotocol: 'attest-json',
  request_template: { type: 'invoke', request_id: '{{request_id}}' },
  request_id_pointer: '/request_id',
  acknowledgement_pointer: '/acknowledged',
  acknowledgement_values: [true, 'accepted'],
  result_pointer: '/result',
  error_pointer: '/error',
  trace_pointer: '/trace',
  open_timeout_ms: 5_000,
  message_idle_timeout_ms: 30_000,
  attempt_timeout_ms: 60_000,
  ping_interval_ms: 10_000,
  close_timeout_ms: 5_000,
  retry_boundary: 'before_acknowledgement',
  replay_after_acknowledgement: false,
};

const validRequest: WebSocketInvocationRequest = {
  protocol: WEBSOCKET_REQUEST_PROTOCOL,
  request_id: 'run-01:case-01',
  request: {
    protocol: 'attest.agent-invocation',
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    case_id: 'case-01',
    input: { question: 'Ready?' },
  },
};

const unacknowledged = {
  state: 'not_acknowledged',
  retry: 'allowed',
  reconnect: 'allowed',
  replay: 'allowed',
} as const;

const acknowledged = {
  state: 'acknowledged',
  retry: 'forbidden',
  reconnect: 'forbidden',
  replay: 'forbidden',
} as const;

const validEvidence: WebSocketAttemptEvidence = {
  schema: WEBSOCKET_EVIDENCE_SCHEMA_ID,
  request_id: validRequest.request_id,
  lifecycle: 'per_run',
  connection_mode: 'multiplexed',
  acknowledgement: acknowledged,
  outcome: 'completed',
  events: [
    { classification: 'connection_opened', elapsed_ms: 2 },
    { classification: 'request_sent', elapsed_ms: 3, request_id: validRequest.request_id },
    {
      classification: 'acknowledgement_received',
      elapsed_ms: 7,
      request_id: validRequest.request_id,
    },
    {
      classification: 'result_received',
      elapsed_ms: 12,
      request_id: validRequest.request_id,
      message_bytes: 42,
      excerpt: { text: '{"result":"done"}', truncated: false },
    },
  ],
  close: { code: 1_000, reason: 'complete', clean: true },
};

describe('WebSocket authored resource contract', () => {
  it('accepts run-scoped serial or multiplexed connections and serial per-case connections', () => {
    expect(parseWithSchema(webSocketTransportSchema, validTransport).ok).toBe(true);
    expect(
      parseWithSchema(webSocketTransportSchema, {
        ...validTransport,
        lifecycle: 'per_run',
        connection_mode: 'serial',
      }).ok,
    ).toBe(true);
    expect(
      parseWithSchema(webSocketTransportSchema, {
        ...validTransport,
        lifecycle: 'per_case',
        connection_mode: 'serial',
      }).ok,
    ).toBe(true);
  });

  it('rejects multiplexing per-case connections and inconsistent timing bounds', () => {
    expect(
      parseWithSchema(webSocketTransportSchema, { ...validTransport, lifecycle: 'per_case' }).ok,
    ).toBe(false);
    expect(
      parseWithSchema(webSocketTransportSchema, { ...validTransport, open_timeout_ms: 60_001 }).ok,
    ).toBe(false);
    expect(
      parseWithSchema(webSocketTransportSchema, {
        ...validTransport,
        ping_interval_ms: validTransport.message_idle_timeout_ms,
      }).ok,
    ).toBe(false);
  });

  it('requires distinct non-root correlation, acknowledgement, and extraction pointers', () => {
    expect(
      parseWithSchema(webSocketTransportSchema, { ...validTransport, request_id_pointer: '' }).ok,
    ).toBe(false);
    expect(
      parseWithSchema(webSocketTransportSchema, {
        ...validTransport,
        acknowledgement_pointer: validTransport.request_id_pointer,
      }).ok,
    ).toBe(false);
    expect(
      parseWithSchema(webSocketTransportSchema, {
        ...validTransport,
        request_template: { type: 'invoke' },
      }).ok,
    ).toBe(false);
    expect(
      parseWithSchema(webSocketTransportSchema, {
        ...validTransport,
        request_template: { first: '{{request_id}}', second: '{{request_id}}' },
      }).ok,
    ).toBe(false);
  });

  it('accepts environment-backed headers and rejects literal authorization or cookies', () => {
    expect(parseWithSchema(webSocketTransportSchema, validTransport).ok).toBe(true);
    expect(
      parseWithSchema(webSocketTransportSchema, {
        ...validTransport,
        headers: { Authorization: 'Bearer secret' },
      }).ok,
    ).toBe(false);
    expect(
      parseWithSchema(webSocketTransportSchema, {
        ...validTransport,
        headers: { Cookie: { from_env: 'SESSION_COOKIE' } },
      }).ok,
    ).toBe(false);
  });

  it.each([
    ['binary frames', { framing: 'binary' }],
    ['Socket.IO endpoints', { url: 'wss://agent.example.test/socket.io/?EIO=4' }],
    ['GraphQL subscriptions', { subprotocol: 'graphql-transport-ws' }],
  ])('rejects unsupported %s configuration', (_name, unsupported) => {
    expect(
      parseWithSchema(webSocketTransportSchema, { ...validTransport, ...unsupported }).ok,
    ).toBe(false);
  });
});

describe('WebSocket normalized request and message protocol', () => {
  it('accepts bounded correlated requests and every normalized message kind', () => {
    expect(parseWithSchema(webSocketInvocationRequestSchema, validRequest).ok).toBe(true);

    for (const type of ['acknowledgement', 'result', 'error', 'trace'] as const) {
      expect(
        parseWithSchema(webSocketCorrelatedMessageSchema, {
          protocol: WEBSOCKET_MESSAGE_PROTOCOL,
          type,
          request_id: validRequest.request_id,
          value: type,
        }).ok,
      ).toBe(true);
    }
  });

  it('rejects missing, oversized, and unsafe correlation ids', () => {
    expect(parseWithSchema(requestIdSchema, '').ok).toBe(false);
    expect(parseWithSchema(requestIdSchema, 'a'.repeat(129)).ok).toBe(false);
    expect(parseWithSchema(requestIdSchema, 'case id').ok).toBe(false);
    expect(
      parseWithSchema(webSocketCorrelatedMessageSchema, {
        protocol: WEBSOCKET_MESSAGE_PROTOCOL,
        type: 'result',
        value: 'done',
      }).ok,
    ).toBe(false);
  });
});

describe('WebSocket attempt evidence contract', () => {
  it('accepts bounded completed evidence', () => {
    expect(parseWithSchema(webSocketAttemptEvidenceSchema, validEvidence).ok).toBe(true);
  });

  it('allows retry/reconnect/replay only before acknowledgement', () => {
    expect(
      parseWithSchema(webSocketAttemptEvidenceSchema, {
        ...validEvidence,
        acknowledgement: unacknowledged,
      }).ok,
    ).toBe(true);
    expect(
      parseWithSchema(webSocketAttemptEvidenceSchema, {
        ...validEvidence,
        acknowledgement: { ...acknowledged, retry: 'allowed' },
      }).ok,
    ).toBe(false);
    expect(
      parseWithSchema(webSocketAttemptEvidenceSchema, {
        ...validEvidence,
        acknowledgement: { ...acknowledged, replay: 'allowed' },
      }).ok,
    ).toBe(false);
  });

  it('requires stable errors for failed evidence and bounded, digest-backed excerpts', () => {
    expect(
      parseWithSchema(webSocketAttemptEvidenceSchema, {
        ...validEvidence,
        outcome: 'failed',
        error_classification: 'binary_frame_unsupported',
        acknowledgement: unacknowledged,
      }).ok,
    ).toBe(true);
    expect(
      parseWithSchema(webSocketAttemptEvidenceSchema, { ...validEvidence, outcome: 'failed' }).ok,
    ).toBe(false);
    expect(
      parseWithSchema(webSocketAttemptEvidenceSchema, {
        ...validEvidence,
        events: [
          {
            classification: 'result_received',
            elapsed_ms: 1,
            excerpt: { text: 'truncated', truncated: true },
          },
        ],
      }).ok,
    ).toBe(false);
  });
});
