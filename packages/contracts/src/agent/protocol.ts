import { z } from 'zod';

import type { Trace } from '../trace/protocol.js';
import { AGENT_PROTOCOL } from '../schema/identifiers.js';

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
    protocol: z.literal(AGENT_PROTOCOL),
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

const agentResponseShape = {
  protocol: z.literal(AGENT_PROTOCOL),
  output: z.json().optional(),
  error: z
    .strictObject({
      message: z.string(),
      code: z.string().optional(),
    })
    .optional(),
  state: z.json().optional(),
  // Left unvalidated here so a malformed optional trace degrades to a warning in parseAgentResponse.
  trace: z.unknown().optional(),
};

/**
 * Encodes docs/specs/agent-contract.md response envelope. Agents may add vendor fields, and a
 * response must carry exactly one terminal outcome.
 */
const agentResponseSchema = z.looseObject(agentResponseShape).superRefine((response, context) => {
  const outcomeCount = ['output', 'error'].filter((field) => Object.hasOwn(response, field)).length;
  if (outcomeCount === 1) {
    return;
  }

  context.addIssue({
    code: 'custom',
    path: ['output'],
    message: 'exactly one of output or error must be present',
  });
});

type AgentResponseFields = z.output<z.ZodObject<typeof agentResponseShape>>;
type AgentResponseBase = Omit<AgentResponseFields, 'output' | 'error' | 'trace'> & {
  trace?: Trace;
};

/** Represents a validated agent response with exactly one terminal outcome and a valid trace. */
type AgentResponse =
  | (AgentResponseBase & Required<Pick<AgentResponseFields, 'output'>>)
  | (AgentResponseBase & Required<Pick<AgentResponseFields, 'error'>>);

type AgentSuccessResponse = Extract<AgentResponse, { output: unknown }>;
type AgentErrorResponse = Extract<AgentResponse, { error: unknown }>;

export {
  agentRequestSchema,
  agentResponseSchema,
  type AgentErrorResponse,
  type AgentRequest,
  type AgentResponse,
  type AgentSuccessResponse,
};
