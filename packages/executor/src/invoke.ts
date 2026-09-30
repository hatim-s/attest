import type { AgentRequest } from '@attest/contracts';

import { invokeCliAgent } from './cli-invoker.js';
import { invokeHttpAgent } from './http-invoker.js';
import { invokeWithRetries } from './internal/invocation-retry.js';
import type {
  InvocationAttempt,
  InvocationResult,
  InvokeAgentOptions,
  NativeAgentTarget,
} from './types.js';

const invokeOnce = (
  target: NativeAgentTarget,
  request: AgentRequest,
  options: InvokeAgentOptions,
): Promise<InvocationAttempt> => {
  if (target.type === 'cli') return invokeCliAgent(target, request, options);
  return invokeHttpAgent(target, request, options);
};

/** Dispatches one target and retains every validated retry attempt for deterministic recording. */
const invokeAgent = async (
  target: NativeAgentTarget,
  request: AgentRequest,
  options: InvokeAgentOptions,
): Promise<InvocationResult> => {
  return invokeWithRetries(() => invokeOnce(target, request, options), options.retries);
};

export { invokeAgent };
