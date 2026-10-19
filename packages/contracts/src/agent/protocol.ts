import { z } from 'zod';

import type { Trace } from '../trace/protocol.js';
import { AGENT_PROTOCOL } from '../schema/identifiers.js';
import { inlineArtifactSchema } from './artifact.js';

const MULTI_TURN_FIELDS = ['messages', 'turn_index', 'conversation_id'] as const;

const conversationMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

/** Where and how an async agent posts its `attest.agent-completion`; only callback runs send it. */
const agentCallbackSchema = z.strictObject({
  // Not z.httpUrl(): its domain-only hostname rule rejects the 127.0.0.1 loopback receiver.
  url: z.url({ protocol: /^https?$/u }),
  token: z.string().min(1),
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
    callback: agentCallbackSchema.optional(),
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

type AgentCallback = z.infer<typeof agentCallbackSchema>;

/** The error an agent reports instead of an output. */
const agentErrorSchema = z.strictObject({
  message: z.string(),
  code: z.string().optional(),
});

const agentResponseFields = {
  protocol: z.literal(AGENT_PROTOCOL),
  output: z.json().optional(),
  error: agentErrorSchema.optional(),
  state: z.json().optional(),
  // Left unvalidated here so a malformed optional trace degrades to a warning in parseAgentResponse.
  trace: z.unknown().optional(),
  artifacts: z.array(inlineArtifactSchema).optional(),
};

/**
 * Requires exactly one terminal outcome. Shared by responses and completions so both envelopes
 * report the same issue for the same mistake.
 */
const refineSingleOutcome = (
  envelope: { output?: unknown; error?: unknown },
  context: z.RefinementCtx,
): void => {
  const outcomeCount = ['output', 'error'].filter((field) => Object.hasOwn(envelope, field)).length;

  if (outcomeCount === 1 && (envelope.output !== undefined || envelope.error !== undefined)) {
    return;
  }

  context.addIssue({
    code: 'custom',
    path: ['output'],
    message: 'exactly one of output or error must be present',
  });
};

/**
 * Encodes docs/specs/agent-contract.md response envelope. Agents may add vendor fields, and a
 * response must carry exactly one terminal outcome.
 */
const agentResponseSchema = z.looseObject(agentResponseFields).superRefine(refineSingleOutcome);

type AgentResponseFields = z.output<z.ZodObject<typeof agentResponseFields>>;

type AgentResponseBase = Omit<AgentResponseFields, 'output' | 'error' | 'trace'> & {
  trace?: Trace;
};

/** Represents a validated agent response with exactly one terminal outcome and a valid trace. */
type AgentResponse =
  | (AgentResponseBase & Required<Pick<AgentResponseFields, 'output'>>)
  | (AgentResponseBase & Required<Pick<AgentResponseFields, 'error'>>);

type AgentSuccessResponse = Extract<AgentResponse, { output: unknown }>;

type AgentErrorResponse = Extract<AgentResponse, { error: unknown }>;

/**
 * An error envelope completes the transport but carries no output, so metrics skip it and the
 * case verdict is an error rather than a failure. Generic so a stored record, which types only the
 * envelope's error field, reads the same rule as a live response.
 */
const isAgentErrorResponse = <Response extends object>(
  response: Response,
): response is Extract<Response, { error: object }> =>
  'error' in response && response.error !== undefined;

export {
  agentCallbackSchema,
  agentErrorSchema,
  agentRequestSchema,
  agentResponseSchema,
  isAgentErrorResponse,
  refineSingleOutcome,
  type AgentCallback,
  type AgentErrorResponse,
  type AgentRequest,
  type AgentResponse,
  type AgentSuccessResponse,
};
