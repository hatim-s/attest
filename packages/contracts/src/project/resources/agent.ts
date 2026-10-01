import { z } from 'zod';

import { agentTransportSchema } from './agent-transports.js';
import {
  durationMillisecondsSchema,
  jsonPointerSchema,
  resourceIdSchema,
  retryPolicySchema,
} from '../shared.js';
import { AGENT_RESOURCE_SCHEMA_ID } from '../../schema/identifiers.js';

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

/** Encodes one canonical agent resource without secret values. */
const agentResourceSchema = z
  .strictObject({
    schema: z.literal(AGENT_RESOURCE_SCHEMA_ID),
    id: resourceIdSchema,
    name: z.string().min(1),
    transport: agentTransportSchema,
    timeouts: agentTimeoutPolicySchema.optional(),
    retry: retryPolicySchema.optional(),
    limits: agentEvidenceLimitsSchema.optional(),
    redaction: redactionPolicySchema.optional(),
    capabilities: z.strictObject({ trace: z.boolean() }).optional(),
  })
  .meta({ id: 'AgentResource' });

type AgentEvidenceLimits = z.infer<typeof agentEvidenceLimitsSchema>;
type AgentResource = z.infer<typeof agentResourceSchema>;
type AgentTimeoutPolicy = z.infer<typeof agentTimeoutPolicySchema>;
type RedactionPolicy = z.infer<typeof redactionPolicySchema>;

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
