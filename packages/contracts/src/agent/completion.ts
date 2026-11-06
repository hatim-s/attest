import { ulidSchema } from '../schema/scalars.js';
import * as Schema from 'effect/Schema';

import { AGENT_COMPLETION_PROTOCOL } from '../schema/identifiers.js';
import { agentErrorSchema, refineSingleOutcome } from './protocol.js';
import { artifactSchema } from './artifact.js';

/**
 * Encodes the flat `attest.agent-completion` an async agent posts to its callback URL. The
 * callback adapter resolves `trace_ref` and reference artifacts, then hands the parser an ordinary
 * response envelope, so no other transport sees this shape.
 */
const agentCompletionSchema = Schema.Struct({
  protocol: Schema.Literal(AGENT_COMPLETION_PROTOCOL),
  run_id: ulidSchema,
  case_id: Schema.String,
  output: Schema.optional(Schema.Json),
  error: Schema.optional(agentErrorSchema),
  state: Schema.optional(Schema.Json),
  // Left unvalidated so a malformed trace degrades to a warning in parseAgentResponse.
  trace: Schema.optional(Schema.Unknown),
  trace_ref: Schema.optional(
    Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
  ),
  artifacts: Schema.optional(Schema.Array(artifactSchema)),
}).check(
  Schema.makeFilter((completion) => {
    const context: Schema.FilterIssue[] = [];
    refineSingleOutcome(completion, context);

    if (completion.trace !== undefined && completion.trace_ref !== undefined) {
      context.push({
        path: ['trace_ref'],
        issue: 'trace and trace_ref are mutually exclusive',
      });
    }

    return context;
  }),
);

type AgentCompletionFields = typeof agentCompletionSchema.Type;

type AgentCompletionBase = Omit<AgentCompletionFields, 'output' | 'error'>;

/** A validated completion narrowed on its single outcome, like `AgentResponse`. */
type AgentCompletion =
  | (AgentCompletionBase & Required<Pick<AgentCompletionFields, 'output'>>)
  | (AgentCompletionBase & Required<Pick<AgentCompletionFields, 'error'>>);

export { agentCompletionSchema, type AgentCompletion };
