import { parseWithSchemaEffect } from '@attest/contracts';
import type { AgentRequest, SchemaDecodeError } from '@attest/contracts';
import * as Effect from 'effect/Effect';

import { invokeCliAgent } from './cli-invoker.js';
import { invokeHttpAgent } from './http-invoker.js';
import { invokeWithRetries, retryBudgetSchema } from './internal/invocation-retry.js';
import type { InvocationResult, InvokeAgentOptions, NativeAgentTarget } from './types.js';

type InvocationFailure =
  | SchemaDecodeError
  | Effect.Error<ReturnType<typeof invokeCliAgent>>
  | Effect.Error<ReturnType<typeof invokeHttpAgent>>;

/** Composes the selected native attempt without hiding infrastructure or cleanup failures. */
const invokeOnce = Effect.fn('invokeOnce')(function* (
  target: NativeAgentTarget,
  request: AgentRequest,
  options: InvokeAgentOptions,
) {
  if (target.type === 'cli') return yield* invokeCliAgent(target, request, options);

  return yield* invokeHttpAgent(target, request, options);
});

/** Dispatches one target and retains every validated retry attempt for deterministic recording. */
const invokeAgent = Effect.fn('invokeAgent')(function* (
  target: NativeAgentTarget,
  request: AgentRequest,
  options: InvokeAgentOptions,
): Effect.fn.Return<InvocationResult, InvocationFailure> {
  const { retries } = yield* parseWithSchemaEffect(retryBudgetSchema, options);

  return yield* invokeWithRetries(() => invokeOnce(target, request, options), retries);
});

export { invokeAgent };
