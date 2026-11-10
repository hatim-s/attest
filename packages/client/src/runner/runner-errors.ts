import { Data } from 'effect';

/**
 * The one failure type an `AgentHandler` may return. The runner reports `message` to attest as a
 * `handler_failed` completion; `cause` keeps the original failure for local diagnostics only.
 */
class AgentHandlerError extends Data.TaggedError('AgentHandlerError')<{
  message: string;
  cause?: unknown;
}> {}

type AgentRunnerReason = 'missing_trigger_token' | 'invalid_request_body_limit' | 'drain_timed_out';

const AGENT_RUNNER_MESSAGES = {
  missing_trigger_token: 'createAgentRunner needs a non-empty triggerToken.',
  invalid_request_body_limit: 'requestBodyLimitBytes must be a positive safe integer.',
  drain_timed_out: 'Runner drain timed out; accepted work remains owned.',
} as const satisfies Record<AgentRunnerReason, string>;

/** A runner configuration or drain failure. */
class AgentRunnerError extends Data.TaggedError('AgentRunnerError')<{
  reason: AgentRunnerReason;
}> {
  override readonly message = AGENT_RUNNER_MESSAGES[this.reason];
}

type RunnerIoOperation = 'read_body' | 'cancel_body' | 'post_completion' | 'discard_completion';

const RUNNER_IO_MESSAGES = {
  read_body: 'Request body failed.',
  cancel_body: 'Request body cancel failed.',
  post_completion: 'Completion post failed.',
  discard_completion: 'Completion response discard failed.',
} as const satisfies Record<RunnerIoOperation, string>;

/** A trigger body read or cancel, or a completion post or response discard, failed. */
class RunnerIoError extends Data.TaggedError('RunnerIoError')<{
  operation: RunnerIoOperation;
  cause: unknown;
}> {
  override readonly message = RUNNER_IO_MESSAGES[this.operation];
}

export { AgentHandlerError, AgentRunnerError, RunnerIoError };
