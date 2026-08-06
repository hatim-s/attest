import { z } from 'zod';

import { traceSchema } from './trace.js';
import { AGENT_PROTOCOL } from './versions.js';

const messageSchema = z.strictObject({
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
    messages: z.array(messageSchema).optional(),
    turn_index: z.number().int().nonnegative().optional(),
    conversation_id: z.string().optional(),
    state: z.json().optional(),
  })
  .superRefine((request, context) => {
    const multiTurnFields = [request.messages, request.turn_index, request.conversation_id];
    if (multiTurnFields.every((field) => field === undefined)) {
      return;
    }

    if (request.messages === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['messages'],
        message: 'required for multi-turn requests',
      });
    }
    if (request.turn_index === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['turn_index'],
        message: 'required for multi-turn requests',
      });
    }
    if (request.conversation_id === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['conversation_id'],
        message: 'required for multi-turn requests',
      });
    }
  });

/** Represents a validated invocation request sent to an agent transport. */
type AgentRequest = z.infer<typeof agentRequestSchema>;

/**
 * Encodes docs/specs/agent-contract.md response envelope and its output-or-error invariant.
 */
const agentResponseSchema = z
  .strictObject({
    protocol: z.literal(AGENT_PROTOCOL),
    output: z.json().optional(),
    error: z
      .strictObject({
        message: z.string(),
        code: z.string().optional(),
      })
      .optional(),
    trace: traceSchema.optional(),
    state: z.json().optional(),
  })
  .superRefine((response, context) => {
    const hasOutput = response.output !== undefined;
    const hasError = response.error !== undefined;

    if (hasOutput !== hasError) {
      return;
    }

    context.addIssue({
      code: 'custom',
      path: ['output'],
      message: 'exactly one of output or error must be present',
    });
  });

/** Represents a validated agent response with exactly one terminal outcome. */
type AgentResponse = z.infer<typeof agentResponseSchema>;

export { agentRequestSchema, agentResponseSchema, type AgentRequest, type AgentResponse };
