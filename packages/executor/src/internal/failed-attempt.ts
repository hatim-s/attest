import type { RawExcerpt } from '@attest/contracts';

import type { AgentInvocationError } from '../errors.js';
import type { InvocationAttempt, InvocationDiagnostics } from '../types.js';

type FailedAttemptOptions = {
  diagnostics?: InvocationDiagnostics;
  durationMs: number;
  rawExcerpt?: RawExcerpt;
};

/** Records one failed transport attempt; failures never carry contract warnings. */
const createFailedAttempt = (
  error: AgentInvocationError,
  options: FailedAttemptOptions,
): InvocationAttempt => ({
  status: 'invocation_error',
  error,
  diagnostics: options.diagnostics ?? {},
  durationMs: options.durationMs,
  ...(options.rawExcerpt === undefined ? {} : { rawExcerpt: options.rawExcerpt }),
  warnings: [],
});

export { createFailedAttempt };
