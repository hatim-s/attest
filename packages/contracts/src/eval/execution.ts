import { z } from 'zod';

/**
 * Terminal classification of one executed case. The runner produces it and the store persists
 * it, so both read the same enum.
 */
const caseOutcomeSchema = z.enum(['completed', 'invocation_error', 'timeout', 'cancelled']);

/**
 * Every way an agent invocation can fail before producing an evaluable envelope
 * (docs/specs/agent-contract.md, execution semantics). The store persists these values verbatim,
 * so they are append-only within a contract version.
 */
const invocationErrorCodeSchema = z.enum([
  'spawn_failed',
  'timeout',
  'output_cap_exceeded',
  'nonzero_exit',
  'http_status',
  'network',
  'invalid_envelope',
  'cancelled',
]);

/** Recoverable problems reported alongside a successfully parsed agent response. */
const warningCodeSchema = z.enum(['unknown_field', 'invalid_trace']);

/**
 * Transport metadata recorded per invocation attempt and per case. Free-text failures are capped
 * so a hostile hook or sandbox cannot grow a stored record without bound.
 */
const invocationDiagnosticsSchema = z.object({
  stderrExcerpt: z.string().optional(),
  exitCode: z.number().int().optional(),
  httpStatus: z.number().int().optional(),
  remoteJobId: z.union([z.string(), z.number().finite()]).optional(),
  unreapedProcessIds: z.array(z.number().int().positive()).optional(),
  lifecycleError: z.string().max(4096).optional(),
  sandboxError: z.string().max(4096).optional(),
  sandboxCleanupConfirmed: z.boolean().optional(),
  sandboxCompletionConfirmed: z.boolean().optional(),
});

type CaseOutcome = z.infer<typeof caseOutcomeSchema>;

type InvocationDiagnostics = z.infer<typeof invocationDiagnosticsSchema>;

type InvocationErrorCode = z.infer<typeof invocationErrorCodeSchema>;

type WarningCode = z.infer<typeof warningCodeSchema>;

export {
  caseOutcomeSchema,
  invocationDiagnosticsSchema,
  invocationErrorCodeSchema,
  warningCodeSchema,
  type CaseOutcome,
  type InvocationDiagnostics,
  type InvocationErrorCode,
  type WarningCode,
};
