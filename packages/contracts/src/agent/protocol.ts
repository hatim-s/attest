import { ulidSchema, nonnegativeIntegerSchema, httpUrlSchema } from '../schema/scalars.js';
import { looseStruct } from '../schema/objects.js';
import * as Schema from 'effect/Schema';

import type { Trace } from '../trace/protocol.js';
import { AGENT_PROTOCOL } from '../schema/identifiers.js';
import { inlineArtifactSchema } from './artifact.js';

const MULTI_TURN_FIELDS = ['messages', 'turn_index', 'conversation_id'] as const;

const conversationMessageSchema = Schema.Struct({
  role: Schema.Literals(['user', 'assistant']),
  content: Schema.String,
});

/** Where and how an async agent posts its `attest.agent-completion`; only callback runs send it. */
const agentCallbackSchema = Schema.Struct({
  // Callback receivers may use loopback IP addresses.
  url: httpUrlSchema,
  token: Schema.String.check(Schema.isMinLength(1)),
});

/**
 * Encodes docs/specs/agent-contract.md request envelope and accepts additive request fields.
 */
const agentRequestSchema = looseStruct({
  protocol: Schema.Literal(AGENT_PROTOCOL),
  run_id: ulidSchema,
  case_id: Schema.String,
  input: Schema.Json,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  messages: Schema.optional(Schema.Array(conversationMessageSchema)),
  turn_index: Schema.optional(nonnegativeIntegerSchema),
  conversation_id: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Json),
  callback: Schema.optional(agentCallbackSchema),
}).check(
  Schema.makeFilter((request) => {
    const context: Schema.FilterIssue[] = [];

    if (MULTI_TURN_FIELDS.every((fieldName) => request[fieldName] === undefined)) {
      return context;
    }

    for (const fieldName of MULTI_TURN_FIELDS) {
      if (request[fieldName] !== undefined) {
        continue;
      }

      context.push({
        path: [fieldName],
        issue: 'required for multi-turn requests',
      });
    }

    return context;
  }),
);

/** Represents a validated invocation request sent to an agent transport. */
type AgentRequest = typeof agentRequestSchema.Type;

type AgentCallback = typeof agentCallbackSchema.Type;

/** The error an agent reports instead of an output. */
const agentErrorSchema = Schema.Struct({
  message: Schema.String,
  code: Schema.optional(Schema.String),
});

const agentResponseFields = {
  protocol: Schema.Literal(AGENT_PROTOCOL),
  output: Schema.optional(Schema.Json),
  error: Schema.optional(agentErrorSchema),
  state: Schema.optional(Schema.Json),
  // Left unvalidated here so a malformed optional trace degrades to a warning in parseAgentResponse.
  trace: Schema.optional(Schema.Unknown),
  artifacts: Schema.optional(Schema.Array(inlineArtifactSchema)),
};

/**
 * Requires exactly one terminal outcome. Shared by responses and completions so both envelopes
 * report the same issue for the same mistake.
 */
const refineSingleOutcome = (
  envelope: { output?: unknown; error?: unknown },
  context: Schema.FilterIssue[],
): void => {
  const outcomeCount = ['output', 'error'].filter((field) => Object.hasOwn(envelope, field)).length;

  if (outcomeCount === 1 && (envelope.output !== undefined || envelope.error !== undefined)) {
    return;
  }

  context.push({
    path: ['output'],
    issue: 'exactly one of output or error must be present',
  });
};

/**
 * Encodes docs/specs/agent-contract.md response envelope. Agents may add vendor fields, and a
 * response must carry exactly one terminal outcome.
 */
const agentResponseSchema = looseStruct(agentResponseFields).check(
  Schema.makeFilter((value) => {
    const issues: Schema.FilterIssue[] = [];
    refineSingleOutcome(value, issues);

    return issues;
  }),
);

type AgentResponseFields = Schema.Struct.Type<typeof agentResponseFields>;

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
