import { createHash } from 'node:crypto';

import { canonicalStringify } from '@attest/core';

import type { JudgeClient, JudgeOutcome, JudgeRequest } from './judge-client.js';
import { buildJudgePrompt, JUDGE_PROMPT_VERSION, JUDGE_REQUEST_PARAMS } from './rubric-prompt.js';

/**
 * Advisory content-addressed store for judge outcomes, so runs avoid repeated provider calls when
 * metric spec §3 inputs have not changed.
 */
interface JudgeCache {
  get(key: string): Promise<JudgeOutcome | undefined>;
  set(key: string, outcome: JudgeOutcome): Promise<void>;
}

/** The provider settings a shared in-flight call must match before another caller may join it. */
type JudgeCallScope = { client: JudgeClient; signal: AbortSignal | undefined; timeoutMs: number };

/** How a cached judge call was served; recorded in judge evidence. */
type JudgeCacheSource = 'hit' | 'miss' | 'coalesced';

type CachedJudgeCall = { outcome: JudgeOutcome; source: 'hit' | 'miss' };

type InFlightJudgeCall = JudgeCallScope & { promise: Promise<CachedJudgeCall> };

// Keyed by cache instance: a local run owns one cache, so only concurrent cases of that run can
// share a provider call, and only when they render a byte-identical prompt.
const inFlightCallsByCache = new WeakMap<JudgeCache, Map<string, InFlightJudgeCall>>();

/** Hashes the exact rendered judge request, excluding threshold because callers recompute pass from score. */
const computeJudgeCacheKey = (request: JudgeRequest): string => {
  const prompt = buildJudgePrompt(request);
  return createHash('sha256')
    .update(
      canonicalStringify({
        promptVersion: JUDGE_PROMPT_VERSION,
        model: request.model,
        system: prompt.system,
        user: prompt.user,
        params: JUDGE_REQUEST_PARAMS,
      }),
    )
    .digest('hex');
};

/** Reads the cache, calls the provider on a miss, and stores the verdict. */
const callThroughCache = async (
  cache: JudgeCache,
  key: string,
  request: JudgeRequest,
  scope: JudgeCallScope,
): Promise<CachedJudgeCall> => {
  scope.signal?.throwIfAborted();
  const cached = await cache.get(key);
  scope.signal?.throwIfAborted();
  if (cached !== undefined) {
    return { outcome: cached, source: 'hit' };
  }

  const outcome = await scope.client.scoreRubric(request, {
    timeoutMs: scope.timeoutMs,
    signal: scope.signal,
  });
  scope.signal?.throwIfAborted();
  try {
    await cache.set(key, outcome);
  } catch {
    // Cache persistence is advisory: a completed provider verdict remains the source of truth for this run.
  }
  return { outcome, source: 'miss' };
};

/**
 * Resolves a judge request through the cache. Concurrent cases of one run that render the same
 * prompt join the first caller's in-flight provider call instead of paying for a duplicate.
 */
const resolveThroughJudgeCache = async (
  cache: JudgeCache,
  request: JudgeRequest,
  scope: JudgeCallScope,
): Promise<{ outcome: JudgeOutcome; source: JudgeCacheSource; key: string }> => {
  const key = computeJudgeCacheKey(request);
  let inFlightCalls = inFlightCallsByCache.get(cache);
  if (inFlightCalls === undefined) {
    inFlightCalls = new Map();
    inFlightCallsByCache.set(cache, inFlightCalls);
  }

  const inFlight = inFlightCalls.get(key);
  if (
    inFlight !== undefined &&
    inFlight.client === scope.client &&
    inFlight.signal === scope.signal &&
    inFlight.timeoutMs === scope.timeoutMs
  ) {
    const shared = await inFlight.promise;
    return { outcome: shared.outcome, source: shared.source === 'hit' ? 'hit' : 'coalesced', key };
  }

  const promise = callThroughCache(cache, key, request, scope);
  if (inFlight === undefined) {
    const call = { ...scope, promise };
    const release = (): void => {
      if (inFlightCalls.get(key) === call) inFlightCalls.delete(key);
    };
    inFlightCalls.set(key, call);
    // Detached on purpose: callers await the call promise itself; this only frees the slot.
    void promise.then(release, release);
  }
  const resolved = await promise;
  return { ...resolved, key };
};

export { resolveThroughJudgeCache, type JudgeCache };
