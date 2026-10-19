import { z } from 'zod';

import { AGENT_COMPLETION_PROTOCOL } from '../schema/identifiers.js';
import { agentErrorSchema, refineSingleOutcome } from './protocol.js';
import { artifactSchema } from './artifact.js';

/**
 * Encodes the flat `attest.agent-completion` an async agent posts to its callback URL. The
 * callback adapter resolves `trace_ref` and reference artifacts, then hands the parser an ordinary
 * response envelope, so no other transport sees this shape.
 */
const agentCompletionSchema = z
  .strictObject({
    protocol: z.literal(AGENT_COMPLETION_PROTOCOL),
    run_id: z.ulid(),
    case_id: z.string(),
    output: z.json().optional(),
    error: agentErrorSchema.optional(),
    state: z.json().optional(),
    // Left unvalidated so a malformed trace degrades to a warning in parseAgentResponse.
    trace: z.unknown().optional(),
    trace_ref: z.string().min(1).max(256).optional(),
    artifacts: z.array(artifactSchema).optional(),
  })
  .superRefine((completion, context) => {
    refineSingleOutcome(completion, context);

    if (completion.trace !== undefined && completion.trace_ref !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['trace_ref'],
        message: 'trace and trace_ref are mutually exclusive',
      });
    }
  });

type AgentCompletion = z.infer<typeof agentCompletionSchema>;

export { agentCompletionSchema, type AgentCompletion };
