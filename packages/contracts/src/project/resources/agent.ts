import { positiveIntegerSchema, nonnegativeIntegerSchema } from '../../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { agentTransportSchema } from './agent-transports.js';
import {
  durationMillisecondsSchema,
  jsonPointerSchema,
  resourceIdSchema,
  retryPolicySchema,
} from '../shared.js';
import { AGENT_RESOURCE_SCHEMA_ID } from '../../schema/identifiers.js';

/** Bounds every phase of an agent attempt and its optional run-scoped lifecycle. */
const agentTimeoutPolicySchema = Schema.Struct({
  connect_ms: Schema.optional(durationMillisecondsSchema),
  first_byte_ms: Schema.optional(durationMillisecondsSchema),
  idle_ms: Schema.optional(durationMillisecondsSchema),
  attempt_ms: Schema.optional(durationMillisecondsSchema),
  run_ms: Schema.optional(durationMillisecondsSchema),
});

/** Bounds authored requests and persisted transport evidence. */
const agentEvidenceLimitsSchema = Schema.Struct({
  request_bytes: Schema.optional(positiveIntegerSchema),
  response_bytes: Schema.optional(positiveIntegerSchema),
  event_count: Schema.optional(positiveIntegerSchema),
  event_bytes: Schema.optional(positiveIntegerSchema),
  total_evidence_bytes: Schema.optional(positiveIntegerSchema),
  artifact_count: Schema.optional(positiveIntegerSchema),
  artifact_bytes: Schema.optional(positiveIntegerSchema),
  total_artifact_bytes: Schema.optional(positiveIntegerSchema),
});

/** Marks transport locations that must be redacted before evidence persistence. */
const redactionPolicySchema = Schema.Struct({
  headers: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  query: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  argv_positions: Schema.optional(Schema.Array(nonnegativeIntegerSchema)),
  event_pointers: Schema.optional(Schema.Array(jsonPointerSchema)),
});

/** Encodes one canonical agent resource without secret values. */
const agentResourceSchema = Schema.Struct({
  schema: Schema.Literal(AGENT_RESOURCE_SCHEMA_ID),
  id: resourceIdSchema,
  name: Schema.String.check(Schema.isMinLength(1)),
  transport: agentTransportSchema,
  timeouts: Schema.optional(agentTimeoutPolicySchema),
  retry: Schema.optional(retryPolicySchema),
  limits: Schema.optional(agentEvidenceLimitsSchema),
  redaction: Schema.optional(redactionPolicySchema),
  capabilities: Schema.optional(Schema.Struct({ trace: Schema.Boolean })),
}).annotate({ identifier: 'AgentResource' });

type AgentEvidenceLimits = typeof agentEvidenceLimitsSchema.Type;

type AgentResource = typeof agentResourceSchema.Type;

type AgentTimeoutPolicy = typeof agentTimeoutPolicySchema.Type;

type RedactionPolicy = typeof redactionPolicySchema.Type;

export {
  agentEvidenceLimitsSchema,
  agentResourceSchema,
  agentTimeoutPolicySchema,
  redactionPolicySchema,
  type AgentEvidenceLimits,
  type AgentResource,
  type AgentTimeoutPolicy,
  type RedactionPolicy,
};
