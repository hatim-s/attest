import { z } from 'zod';

import { requireExactlyOne } from '../internal/exactly-one.js';
import { traceSchema } from '../trace/protocol.js';
import {
  AGENT_PROTOCOL,
  CURRENT_AGENT_PROTOCOL,
  currentOrLegacyIdentifier,
} from '../schema/identifiers.js';

const MULTI_TURN_FIELDS = ['messages', 'turn_index', 'conversation_id'] as const;

const conversationMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

/**
 * Encodes docs/specs/agent-contract.md request envelope and accepts additive request fields.
 */
const agentRequestSchema = z
  .looseObject({
    protocol: currentOrLegacyIdentifier(CURRENT_AGENT_PROTOCOL, AGENT_PROTOCOL),
    run_id: z.ulid(),
    case_id: z.string(),
    input: z.json(),
    params: z.record(z.string(), z.json()).optional(),
    messages: z.array(conversationMessageSchema).optional(),
    turn_index: z.number().int().nonnegative().optional(),
    conversation_id: z.string().optional(),
    state: z.json().optional(),
  })
  .superRefine((request, context) => {
    if (MULTI_TURN_FIELDS.every((fieldName) => request[fieldName] === undefined)) {
      return;
    }

    for (const fieldName of MULTI_TURN_FIELDS) {
      if (request[fieldName] !== undefined) {
        continue;
      }

      context.addIssue({
        code: 'custom',
        path: [fieldName],
        message: 'required for multi-turn requests',
      });
    }
  });

/** Represents a validated invocation request sent to an agent transport. */
type AgentRequest = z.infer<typeof agentRequestSchema>;

/** Encodes the successful response branch from docs/specs/agent-contract.md. */
const agentSuccessResponseSchema = z
  .looseObject({
    protocol: currentOrLegacyIdentifier(CURRENT_AGENT_PROTOCOL, AGENT_PROTOCOL),
    output: z.json(),
    state: z.json().optional(),
    trace: z.unknown().optional(),
  })
  .superRefine((response, context) => requireExactlyOne(response, ['output', 'error'], context));

/** Encodes the agent-reported failure branch from docs/specs/agent-contract.md. */
const agentErrorResponseSchema = z
  .looseObject({
    protocol: currentOrLegacyIdentifier(CURRENT_AGENT_PROTOCOL, AGENT_PROTOCOL),
    error: z.strictObject({
      message: z.string(),
      code: z.string().optional(),
    }),
    state: z.json().optional(),
    trace: z.unknown().optional(),
  })
  .superRefine((response, context) => requireExactlyOne(response, ['output', 'error'], context));

/** Encodes the output-or-error response union from docs/specs/agent-contract.md. */
const agentResponseSchema = z.union([agentSuccessResponseSchema, agentErrorResponseSchema]);

const agentSuccessResponseValueSchema = z.object({
  protocol: currentOrLegacyIdentifier(CURRENT_AGENT_PROTOCOL, AGENT_PROTOCOL),
  output: z.json(),
  state: z.json().optional(),
  trace: traceSchema.optional(),
});

const agentErrorResponseValueSchema = z.object({
  protocol: currentOrLegacyIdentifier(CURRENT_AGENT_PROTOCOL, AGENT_PROTOCOL),
  error: z.strictObject({
    message: z.string(),
    code: z.string().optional(),
  }),
  state: z.json().optional(),
  trace: traceSchema.optional(),
});

const agentResponseValueSchema = z.union([
  agentSuccessResponseValueSchema,
  agentErrorResponseValueSchema,
]);

/** Represents a validated successful response with an optional valid trace. */
type AgentSuccessResponse = z.infer<typeof agentSuccessResponseValueSchema>;

/** Represents a validated agent-reported failure with an optional valid trace. */
type AgentErrorResponse = z.infer<typeof agentErrorResponseValueSchema>;

/** Represents a validated agent response with exactly one terminal outcome. */
type AgentResponse = AgentSuccessResponse | AgentErrorResponse;

export {
  agentErrorResponseSchema,
  agentRequestSchema,
  agentResponseSchema,
  agentResponseValueSchema,
  agentSuccessResponseSchema,
  type AgentErrorResponse,
  type AgentRequest,
  type AgentResponse,
  type AgentSuccessResponse,
};
