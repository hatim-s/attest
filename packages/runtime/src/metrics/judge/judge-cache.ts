import { createHash } from 'node:crypto';

import { canonicalStringify } from '@attest/core';

import type { JudgeRecord, JudgeRequest, JudgeVerdict } from './judge-client.js';
import { buildJudgePrompt, JUDGE_PROMPT_VERSION, JUDGE_REQUEST_PARAMS } from './rubric-prompt.js';

/** Stores durable judge evidence behind an advisory content-addressed cache boundary. */
type JudgeCacheEntry = { verdict: JudgeVerdict; record: JudgeRecord };

/** Lets run stores avoid repeated provider calls when metric spec §3 inputs have not changed. */
interface JudgeCache {
  get(key: string): Promise<JudgeCacheEntry | undefined>;
  set(key: string, entry: JudgeCacheEntry): Promise<void>;
}

/** Allows direct version-invalidation tests without mutating the production prompt constant. */
type ComputeJudgeCacheKeyOptions = { promptVersion?: number };

/**
 * Hashes the exact rendered judge request, excluding threshold because callers recompute pass from score.
 */
const computeJudgeCacheKey = (
  request: JudgeRequest,
  options: ComputeJudgeCacheKeyOptions = {},
): string => {
  const prompt = buildJudgePrompt(request);
  return createHash('sha256')
    .update(
      canonicalStringify({
        promptVersion: options.promptVersion ?? JUDGE_PROMPT_VERSION,
        model: request.model,
        system: prompt.system,
        user: prompt.user,
        params: JUDGE_REQUEST_PARAMS,
      }),
    )
    .digest('hex');
};

export {
  computeJudgeCacheKey,
  type ComputeJudgeCacheKeyOptions,
  type JudgeCache,
  type JudgeCacheEntry,
};
