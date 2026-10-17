import type { JsonValue } from '@attest/contracts';

import type { JudgeOutcome } from './judge-outcome-schema.js';

/** Describes the case-local evidence sent across the provider-agnostic judge boundary. */
type JudgeRequest = {
  model: string;
  rubric: string;
  document: {
    input: JsonValue;
    output: JsonValue | undefined;
    expected: JsonValue | undefined;
    traceSummary: string | undefined;
  };
};

/** Lets provider adapters own cancellation and deadlines without leaking SDK types into metric semantics. */
type JudgeCallOptions = { signal?: AbortSignal; timeoutMs?: number };

/**
 * Provider-agnostic judge boundary: one rubric scoring call. Kept SDK-free so adapters are swappable
 * (TanStack AI today) without touching metric semantics.
 */
interface JudgeClient {
  scoreRubric(request: JudgeRequest, options?: JudgeCallOptions): Promise<JudgeOutcome>;
}

export { type JudgeCallOptions, type JudgeClient, type JudgeRequest };
