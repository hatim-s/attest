import * as formatsModule from 'ajv-formats';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { serializeContractSchema } from '../schema/json-schema.js';
import {
  WEBSOCKET_EVIDENCE_SCHEMA_ID,
  WEBSOCKET_MESSAGE_PROTOCOL,
  WEBSOCKET_REQUEST_PROTOCOL,
} from '../schema/identifiers.js';
import {
  webSocketAttemptEvidenceSchema,
  webSocketCorrelatedMessageSchema,
  webSocketErrorClassificationSchema,
  webSocketEvidenceClassificationSchema,
  webSocketInvocationRequestSchema,
  webSocketRequestIdSchema,
  webSocketTransportSchema,
  type WebSocketAttemptEvidence,
  type WebSocketInvocationRequest,
  type WebSocketTransport,
} from '../agent/websocket-contract.js';

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

/** Compiles one committed serializer output so golden fixtures exercise Draft 2020-12 too. */
const compileGeneratedSchema = (fileName: string) => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  formatsModule.default.default(ajv);
  ajv.addFormat('ulid', /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  return ajv.compile(JSON.parse(serializeContractSchema(fileName)) as AnySchema);
};

describe('WebSocket authored resource contract', () => {
  it('accepts run-scoped serial or multiplexed connections and serial per-case connections', () => {
    expect(webSocketTransportSchema.safeParse(validTransport).success).toBe(true);
    expect(
      webSocketTransportSchema.safeParse({
        ...validTransport,
        lifecycle: 'per_run',
        connection_mode: 'serial',
      }).success,
    ).toBe(true);
    expect(
      webSocketTransportSchema.safeParse({
        ...validTransport,
        lifecycle: 'per_case',
        connection_mode: 'serial',
      }).success,
    ).toBe(true);
    expectTypeOf(validTransport).toMatchTypeOf<WebSocketTransport>();
  });

  it('rejects multiplexing per-case connections and inconsistent timing bounds', () => {
    expect(
      webSocketTransportSchema.safeParse({ ...validTransport, lifecycle: 'per_case' }).success,
    ).toBe(false);
    expect(
      webSocketTransportSchema.safeParse({ ...validTransport, open_timeout_ms: 60_001 }).success,
    ).toBe(false);
    expect(
      webSocketTransportSchema.safeParse({
        ...validTransport,
        ping_interval_ms: validTransport.message_idle_timeout_ms,
      }).success,
    ).toBe(false);
  });

  it('requires distinct non-root correlation, acknowledgement, and extraction pointers', () => {
    expect(
      webSocketTransportSchema.safeParse({ ...validTransport, request_id_pointer: '' }).success,
    ).toBe(false);
    expect(
      webSocketTransportSchema.safeParse({
        ...validTransport,
        acknowledgement_pointer: validTransport.request_id_pointer,
      }).success,
    ).toBe(false);
    expect(
      webSocketTransportSchema.safeParse({
        ...validTransport,
        request_template: { type: 'invoke' },
      }).success,
    ).toBe(false);
    expect(
      webSocketTransportSchema.safeParse({
        ...validTransport,
        request_template: { first: '{{request_id}}', second: '{{request_id}}' },
      }).success,
    ).toBe(false);
  });

  it('accepts environment-backed headers and rejects literal authorization or cookies', () => {
    expect(webSocketTransportSchema.safeParse(validTransport).success).toBe(true);
    expect(
      webSocketTransportSchema.safeParse({
        ...validTransport,
        headers: { Authorization: 'Bearer secret' },
      }).success,
    ).toBe(false);
    expect(
      webSocketTransportSchema.safeParse({
        ...validTransport,
        headers: { Cookie: { from_env: 'SESSION_COOKIE' } },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['binary frames', { framing: 'binary' }],
    ['Socket.IO endpoints', { url: 'wss://agent.example.test/socket.io/?EIO=4' }],
    ['GraphQL subscriptions', { subprotocol: 'graphql-transport-ws' }],
    ['interactive auth', { interactive_auth: true }],
    ['uncorrelated server work', { allow_uncorrelated_server_work: true }],
    ['resume', { resume: true }],
    ['bidirectional callbacks', { callbacks: true }],
  ])('rejects unsupported %s configuration', (_name, unsupported) => {
    expect(webSocketTransportSchema.safeParse({ ...validTransport, ...unsupported }).success).toBe(
      false,
    );
  });
});

describe('WebSocket normalized request and message protocol', () => {
  it('accepts bounded correlated requests and every normalized message kind', () => {
    expect(webSocketInvocationRequestSchema.safeParse(validRequest).success).toBe(true);
    for (const type of ['acknowledgement', 'result', 'error', 'trace'] as const) {
      expect(
        webSocketCorrelatedMessageSchema.safeParse({
          protocol: WEBSOCKET_MESSAGE_PROTOCOL,
          type,
          request_id: validRequest.request_id,
          value: type,
        }).success,
      ).toBe(true);
    }
    expectTypeOf(validRequest).toMatchTypeOf<WebSocketInvocationRequest>();
  });

  it('rejects missing, oversized, and unsafe correlation ids', () => {
    expect(webSocketRequestIdSchema.safeParse('').success).toBe(false);
    expect(webSocketRequestIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(webSocketRequestIdSchema.safeParse('case id').success).toBe(false);
    expect(
      webSocketCorrelatedMessageSchema.safeParse({
        protocol: WEBSOCKET_MESSAGE_PROTOCOL,
        type: 'result',
        value: 'done',
      }).success,
    ).toBe(false);
  });
});

describe('WebSocket attempt evidence contract', () => {
  it('accepts bounded completed evidence and freezes stable classifications', () => {
    expect(webSocketAttemptEvidenceSchema.safeParse(validEvidence).success).toBe(true);
    expect(webSocketEvidenceClassificationSchema.options).toEqual([
      'connection_opened',
      'request_sent',
      'acknowledgement_received',
      'trace_received',
      'result_received',
      'error_received',
      'ping_sent',
      'pong_received',
      'retry_scheduled',
      'reconnect_started',
      'connection_closed',
    ]);
    expect(webSocketErrorClassificationSchema.options).toEqual([
      'open_timeout',
      'message_idle_timeout',
      'attempt_timeout',
      'close_timeout',
      'handshake_failed',
      'connection_failed',
      'unexpected_close',
      'invalid_json',
      'binary_frame_unsupported',
      'uncorrelated_server_work',
      'duplicate_terminal_message',
      'acknowledgement_extraction_failed',
      'result_extraction_failed',
      'error_extraction_failed',
      'trace_extraction_failed',
      'remote_error',
      'socket_io_unsupported',
      'graphql_subscription_unsupported',
      'interactive_auth_unsupported',
      'resume_unsupported',
      'bidirectional_callback_unsupported',
      'cancelled',
    ]);
  });

  it('allows retry/reconnect/replay only before acknowledgement', () => {
    expect(
      webSocketAttemptEvidenceSchema.safeParse({
        ...validEvidence,
        acknowledgement: unacknowledged,
      }).success,
    ).toBe(true);
    expect(
      webSocketAttemptEvidenceSchema.safeParse({
        ...validEvidence,
        acknowledgement: { ...acknowledged, retry: 'allowed' },
      }).success,
    ).toBe(false);
    expect(
      webSocketAttemptEvidenceSchema.safeParse({
        ...validEvidence,
        acknowledgement: { ...acknowledged, replay: 'allowed' },
      }).success,
    ).toBe(false);
  });

  it('requires stable errors for failed evidence and bounded, digest-backed excerpts', () => {
    expect(
      webSocketAttemptEvidenceSchema.safeParse({
        ...validEvidence,
        outcome: 'failed',
        error_classification: 'binary_frame_unsupported',
        acknowledgement: unacknowledged,
      }).success,
    ).toBe(true);
    expect(
      webSocketAttemptEvidenceSchema.safeParse({ ...validEvidence, outcome: 'failed' }).success,
    ).toBe(false);
    expect(
      webSocketAttemptEvidenceSchema.safeParse({
        ...validEvidence,
        events: [
          {
            classification: 'result_received',
            elapsed_ms: 1,
            excerpt: { text: 'truncated', truncated: true },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    ['websocket-request.json', validRequest],
    [
      'websocket-message.json',
      {
        protocol: WEBSOCKET_MESSAGE_PROTOCOL,
        type: 'acknowledgement',
        request_id: validRequest.request_id,
        value: true,
      },
    ],
    ['websocket-evidence.json', validEvidence],
  ])('%s accepts the matching golden fixture', (fileName, fixture) => {
    expect(compileGeneratedSchema(fileName)(fixture)).toBe(true);
  });

  it.each([
    ['websocket-request.json', { ...validRequest, request_id: undefined }],
    [
      'websocket-message.json',
      {
        protocol: WEBSOCKET_MESSAGE_PROTOCOL,
        type: 'result',
        value: 'uncorrelated',
      },
    ],
    [
      'websocket-evidence.json',
      {
        ...validEvidence,
        acknowledgement: { ...acknowledged, replay: 'allowed' },
      },
    ],
  ])('%s rejects the matching hostile golden fixture', (fileName, fixture) => {
    expect(compileGeneratedSchema(fileName)(fixture)).toBe(false);
  });
});
