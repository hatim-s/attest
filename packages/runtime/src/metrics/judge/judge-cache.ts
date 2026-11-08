import { mustPropagateMetricCause, hasMetricCleanupFailure } from '../internal/operation.js';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Effect from 'effect/Effect';
import * as Deferred from 'effect/Deferred';
import { createHash } from 'node:crypto';

import { canonicalStringify } from '@attest/core';

import { judgeCancelled } from '../errors.js';

import type { JudgeClient, JudgeRequest } from './judge-client.js';
import type { JudgeOutcome } from './judge-outcome-schema.js';
import { buildJudgePrompt, JUDGE_PROMPT_VERSION, JUDGE_REQUEST_PARAMS } from './rubric-prompt.js';

/**
 * Advisory content-addressed store for judge outcomes, so runs avoid repeated provider calls when
 * the judge inputs have not changed.
 */
interface JudgeCache {
  get(key: string): Effect.Effect<JudgeOutcome | undefined, Error>;
  set(key: string, outcome: JudgeOutcome): Effect.Effect<void, Error>;
}

/** The provider settings a shared in-flight call must match before another caller may join it. */
type JudgeCallScope = { client: JudgeClient; signal: AbortSignal | undefined; timeoutMs: number };

type CachedJudgeCall = { outcome: JudgeOutcome; source: 'hit' | 'miss' };

type InFlightJudgeCall = JudgeCallScope & {
  result: Deferred.Deferred<Exit.Exit<CachedJudgeCall, Error>>;
};

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
const callThroughCache = Effect.fn('callThroughCache')(function* (
  cache: JudgeCache,
  key: string,
  request: JudgeRequest,
  scope: JudgeCallScope,
) {
  if (scope.signal?.aborted) return yield* judgeCancelled();
  const cached = yield* cache.get(key);

  if (scope.signal?.aborted) return yield* judgeCancelled();

  if (cached !== undefined) return { outcome: cached, source: 'hit' as const };

  const outcome = yield* scope.client.scoreRubric(request, {
    timeoutMs: scope.timeoutMs,
    signal: scope.signal,
  });

  if (scope.signal?.aborted) return yield* judgeCancelled();
  // A storage failure cannot invalidate a completed verdict. Defects and interruption still propagate.
  yield* cache
    .set(key, outcome)
    .pipe(
      Effect.catchCause((cause) =>
        mustPropagateMetricCause(cause) ? Effect.failCause(cause) : Effect.void,
      ),
    );

  return { outcome, source: 'miss' as const };
});

/** Shares a call only within the same cache, provider and cancellation scope. The owner publishes its full Exit. */
const resolveThroughJudgeCache = Effect.fn('resolveThroughJudgeCache')(function* (
  cache: JudgeCache,
  request: JudgeRequest,
  scope: JudgeCallScope,
) {
  const key = computeJudgeCacheKey(request);
  let calls = inFlightCallsByCache.get(cache);

  if (calls === undefined) {
    calls = new Map();
    inFlightCallsByCache.set(cache, calls);
  }

  for (;;) {
    const existing = calls.get(key);

    if (
      existing !== undefined &&
      existing.client === scope.client &&
      existing.signal === scope.signal &&
      existing.timeoutMs === scope.timeoutMs
    ) {
      // The owner's Exit is data. Interrupting this waiter still interrupts only its own await.
      const settled = yield* Deferred.await(existing.result);

      if (
        Exit.isFailure(settled) &&
        Cause.hasInterruptsOnly(settled.cause) &&
        !hasMetricCleanupFailure(settled.cause)
      )
        continue;
      const shared = yield* settled;

      return {
        outcome: shared.outcome,
        source: shared.source === 'hit' ? ('hit' as const) : ('coalesced' as const),
        key,
      };
    }

    if (existing !== undefined)
      return { ...(yield* callThroughCache(cache, key, request, scope)), key };

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* Deferred.make<Exit.Exit<CachedJudgeCall, Error>>();
        const call = { ...scope, result };
        calls.set(key, call);
        const exit = yield* Effect.exit(restore(callThroughCache(cache, key, request, scope)));

        // Retire before waking waiters, so an interrupted owner cannot be selected again.
        if (calls.get(key) === call) calls.delete(key);
        yield* Deferred.succeed(result, exit);

        return { ...(yield* exit), key };
      }),
    );
  }
});

export { resolveThroughJudgeCache, type JudgeCache };
