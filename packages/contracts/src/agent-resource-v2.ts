import { z } from 'zod';

import {
  durationMillisecondsSchema,
  jsonPointerSchema,
  relativePathSchema,
  resourceIdSchema,
  retryPolicySchema,
  secretReferenceSchema,
} from './v2-shared.js';
import { AGENT_RESOURCE_SCHEMA_VERSION } from './versions.js';

const httpUrlTemplateSchema = z
  .string()
  .regex(/^https?:\/\/\S+$/u, 'must be an HTTP or HTTPS URL template');
const webSocketUrlTemplateSchema = z
  .string()
  .regex(/^wss?:\/\/\S+$/u, 'must be a WebSocket URL template');
const templateValueSchema = z.union([z.string(), secretReferenceSchema]);

/** Builds a foreign HTTP request before normalization at the runner boundary. */
const httpRequestTemplateSchema = z
  .strictObject({
    url: httpUrlTemplateSchema,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    headers: z.record(z.string(), templateValueSchema).optional(),
    query: z.record(z.string(), templateValueSchema).optional(),
    body: z.json().optional(),
    body_encoding: z.enum(['json', 'raw']).optional(),
  })
  .superRefine((request, context) => {
    if (request.body_encoding === 'raw' && typeof request.body !== 'string') {
      context.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'must be a string when body_encoding is raw',
      });
    }
    if (request.body === undefined && request.body_encoding !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['body_encoding'],
        message: 'requires a body',
      });
    }
  })
  .meta({ id: 'V2HttpRequestTemplate' });

/** Extracts a normalized agent outcome from a foreign response or terminal event. */
const responseExtractionSchema = z
  .strictObject({
    result_pointer: jsonPointerSchema,
    error_pointer: jsonPointerSchema.optional(),
    trace_pointer: jsonPointerSchema.optional(),
    remote_job_id_pointer: jsonPointerSchema.optional(),
  })
  .meta({ id: 'V2ResponseExtraction' });

/** Bounds every phase of an agent attempt and its optional run-scoped lifecycle. */
const agentTimeoutPolicySchema = z.strictObject({
  connect_ms: durationMillisecondsSchema.optional(),
  first_byte_ms: durationMillisecondsSchema.optional(),
  idle_ms: durationMillisecondsSchema.optional(),
  attempt_ms: durationMillisecondsSchema.optional(),
  run_ms: durationMillisecondsSchema.optional(),
});

/** Bounds authored requests and persisted transport evidence. */
const agentEvidenceLimitsSchema = z.strictObject({
  request_bytes: z.number().int().positive().optional(),
  response_bytes: z.number().int().positive().optional(),
  event_count: z.number().int().positive().optional(),
  event_bytes: z.number().int().positive().optional(),
  total_evidence_bytes: z.number().int().positive().optional(),
});

/** Marks transport locations that must be redacted before evidence persistence. */
const redactionPolicySchema = z.strictObject({
  headers: z.array(z.string().min(1)).optional(),
  query: z.array(z.string().min(1)).optional(),
  argv_positions: z.array(z.number().int().nonnegative()).optional(),
  event_pointers: z.array(jsonPointerSchema).optional(),
});

const processEnvironmentSchema = z.record(z.string(), secretReferenceSchema);

/** Compares JSON terminal values without treating object key insertion order as semantic. */
const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightObject = right as Record<string, unknown>;
  return (
    leftEntries.length === Object.keys(rightObject).length &&
    leftEntries.every(
      ([key, value]) => Object.hasOwn(rightObject, key) && jsonValuesEqual(value, rightObject[key]),
    )
  );
};

const nativeForegroundTransportSchema = z.strictObject({
  kind: z.literal('native_cli'),
  lifecycle: z.literal('per_case'),
  argv: z.array(z.string()).nonempty(),
  cwd: relativePathSchema.optional(),
  env: processEnvironmentSchema.optional(),
});

const backgroundReadinessSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('http'), url: httpUrlTemplateSchema }),
  z.strictObject({
    kind: z.literal('tcp'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
  }),
  z.strictObject({ kind: z.literal('stderr'), pattern: z.string().min(1) }),
]);

const nativeBackgroundTransportSchema = z.strictObject({
  kind: z.literal('background_cli'),
  lifecycle: z.literal('per_run'),
  start_argv: z.array(z.string()).nonempty(),
  cwd: relativePathSchema.optional(),
  env: processEnvironmentSchema.optional(),
  readiness: backgroundReadinessSchema,
  invoke: httpRequestTemplateSchema,
  extraction: responseExtractionSchema,
  shutdown: httpRequestTemplateSchema.optional(),
  stop_timeout_ms: durationMillisecondsSchema,
});

const jsonlBridgeTransportSchema = z.strictObject({
  kind: z.literal('jsonl_bridge'),
  lifecycle: z.literal('per_run'),
  argv: z.array(z.string()).nonempty(),
  cwd: relativePathSchema.optional(),
  env: processEnvironmentSchema.optional(),
  concurrency: z.enum(['serial', 'multiplexed']),
  cancellation_grace_ms: durationMillisecondsSchema,
});

const httpTransportSchema = z.strictObject({
  kind: z.literal('http'),
  lifecycle: z.literal('external'),
  response_mode: z.enum(['attest_envelope', 'mapped']),
  request: httpRequestTemplateSchema,
  extraction: responseExtractionSchema,
});

const pollingTransportSchema = z.strictObject({
  kind: z.literal('polling'),
  lifecycle: z.literal('external'),
  submit: httpRequestTemplateSchema,
  idempotency_header: z.string().min(1).optional(),
  job_id_pointer: jsonPointerSchema,
  status_url_pointer: jsonPointerSchema.optional(),
  status_url_template: httpUrlTemplateSchema.optional(),
  status_pointer: jsonPointerSchema,
  success_values: z.array(z.json()).nonempty(),
  failure_values: z.array(z.json()).nonempty(),
  extraction: responseExtractionSchema,
  minimum_interval_ms: durationMillisecondsSchema,
  maximum_interval_ms: durationMillisecondsSchema,
});

const streamTransportSchema = z.strictObject({
  kind: z.literal('stream'),
  lifecycle: z.literal('external'),
  framing: z.enum(['sse', 'jsonl']),
  request: httpRequestTemplateSchema,
  event_name: z.string().min(1).optional(),
  event_data_pointer: jsonPointerSchema.optional(),
  terminal_pointer: jsonPointerSchema,
  terminal_values: z.array(z.json()).nonempty(),
  result_pointer: jsonPointerSchema,
  error_pointer: jsonPointerSchema.optional(),
  trace_pointer: jsonPointerSchema.optional(),
  incremental_output_pointer: jsonPointerSchema.optional(),
  heartbeat_resets_application_idle: z.boolean().optional(),
});

const webSocketTransportSchema = z.strictObject({
  kind: z.literal('websocket'),
  lifecycle: z.enum(['per_case', 'per_run']),
  url: webSocketUrlTemplateSchema,
  headers: z.record(z.string(), templateValueSchema).optional(),
  subprotocol: z.string().min(1).optional(),
  request_template: z.json(),
  request_id_pointer: jsonPointerSchema,
  extraction: responseExtractionSchema,
  open_timeout_ms: durationMillisecondsSchema.optional(),
  message_idle_timeout_ms: durationMillisecondsSchema.optional(),
  ping_interval_ms: durationMillisecondsSchema.optional(),
  close_timeout_ms: durationMillisecondsSchema.optional(),
});

/** Encodes every transport definition required by the ratified v2 North Star. */
const agentTransportSchema = z.discriminatedUnion('kind', [
  nativeForegroundTransportSchema,
  nativeBackgroundTransportSchema,
  jsonlBridgeTransportSchema,
  httpTransportSchema,
  pollingTransportSchema,
  streamTransportSchema,
  webSocketTransportSchema,
]);

/** Encodes one canonical v2 agent resource without secret values. */
const agentResourceSchema = z
  .strictObject({
    schema: z.literal(AGENT_RESOURCE_SCHEMA_VERSION),
    id: resourceIdSchema,
    name: z.string().min(1),
    transport: agentTransportSchema,
    timeouts: agentTimeoutPolicySchema.optional(),
    retry: retryPolicySchema.optional(),
    limits: agentEvidenceLimitsSchema.optional(),
    redaction: redactionPolicySchema.optional(),
    capabilities: z.strictObject({ trace: z.boolean() }).optional(),
  })
  .superRefine((agent, context) => {
    if (agent.transport.kind !== 'polling') return;
    const polling = agent.transport;
    if (
      (polling.status_url_pointer === undefined) ===
      (polling.status_url_template === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['transport', 'status_url_pointer'],
        message: 'provide exactly one status URL pointer or template',
      });
    }
    if (polling.minimum_interval_ms > polling.maximum_interval_ms) {
      context.addIssue({
        code: 'custom',
        path: ['transport', 'maximum_interval_ms'],
        message: 'must be greater than or equal to minimum_interval_ms',
      });
    }
    if (
      polling.success_values.some((success) =>
        polling.failure_values.some((failure) => jsonValuesEqual(success, failure)),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['transport', 'failure_values'],
        message: 'must not overlap success_values',
      });
    }
  })
  .meta({ id: 'V2AgentResource' });

type AgentEvidenceLimits = z.infer<typeof agentEvidenceLimitsSchema>;
type AgentResource = z.infer<typeof agentResourceSchema>;
type AgentTimeoutPolicy = z.infer<typeof agentTimeoutPolicySchema>;
type AgentTransport = z.infer<typeof agentTransportSchema>;
type HttpRequestTemplate = z.infer<typeof httpRequestTemplateSchema>;
type RedactionPolicy = z.infer<typeof redactionPolicySchema>;
type ResponseExtraction = z.infer<typeof responseExtractionSchema>;

export {
  agentEvidenceLimitsSchema,
  agentResourceSchema,
  agentTimeoutPolicySchema,
  agentTransportSchema,
  httpRequestTemplateSchema,
  redactionPolicySchema,
  responseExtractionSchema,
  type AgentEvidenceLimits,
  type AgentResource,
  type AgentTimeoutPolicy,
  type AgentTransport,
  type HttpRequestTemplate,
  type RedactionPolicy,
  type ResponseExtraction,
};
