import type { JsonValue } from '@attest/contracts';

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

/** Captures the normalized structured decision returned by a judge provider. */
type JudgeVerdict = { score: number; rationale: string };

/** Retains portable token counts when the selected provider reports them. */
type JudgeUsage = { inputTokens?: number; outputTokens?: number };

/** Retains each provider attempt so retried structured responses remain reproducible under metric spec §3. */
type JudgeAttempt = { rawResponse: JsonValue; usage?: JudgeUsage; error?: string };

/**
 * Records everything needed to reproduce one rubric call per metric contract §3.
 * Provider credentials are deliberately absent so records remain safe to persist and render.
 */
type JudgeRecord = {
  request: {
    model: string;
    system: string;
    user: string;
    params: Record<string, JsonValue>;
  };
  rawResponse: JsonValue;
  usage?: JudgeUsage;
  attempts: JudgeAttempt[];
};

/** Couples the semantic verdict with its reproducibility evidence. */
type JudgeOutcome = { verdict: JudgeVerdict; record: JudgeRecord };

/** Lets provider adapters own cancellation and deadlines without leaking SDK types into metric semantics. */
type JudgeCallOptions = { signal?: AbortSignal; timeoutMs?: number };

/**
 * Provider-agnostic judge boundary: one rubric scoring call. Kept SDK-free so adapters are swappable
 * (TanStack AI today) without touching metric semantics.
 */
interface JudgeClient {
  scoreRubric(request: JudgeRequest, options?: JudgeCallOptions): Promise<JudgeOutcome>;
}

export {
  type JudgeCallOptions,
  type JudgeAttempt,
  type JudgeClient,
  type JudgeOutcome,
  type JudgeRecord,
  type JudgeRequest,
  type JudgeUsage,
  type JudgeVerdict,
};
