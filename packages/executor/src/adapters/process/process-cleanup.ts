import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import type * as Exit from 'effect/Exit';
import { AgentInvocationError } from '../../errors.js';
import type { InvocationResult } from '../../types.js';

/** Retains all release outcomes and the last completed invocation after unconfirmed cleanup. */
class ProcessCleanupError extends AgentInvocationError {
  constructor(
    readonly exits: readonly Exit.Exit<unknown, unknown>[],
    readonly completed?: InvocationResult,
  ) {
    super('network', 'Managed process cleanup could not be confirmed.', {
      applicationStarted: true,
      cause: exits,
    });
  }
}

/** Attaches owned cleanup evidence without replacing a primary failure, defect or interruption. */
class ProcessCleanupDiagnostics extends Context.Service<
  ProcessCleanupDiagnostics,
  Cause.Cause<unknown>
>()('attest/executor/ProcessCleanupDiagnostics') {}

export { ProcessCleanupError, ProcessCleanupDiagnostics };
