import type { AgentRequest } from '@attest/contracts';

import { invokeCliAgent } from './cli-invoker.js';
import { invokeHttpAgent } from './http-invoker.js';
import { invokeWithRetries, isRetryableInvocationError } from './internal/invocation-retry.js';
import type {
  InvocationAttempt,
  InvocationResult,
  InvokeAgentOptions,
  NativeAgentTarget,
} from './types.js';

type RunnerInvokeAgentOptions = Omit<InvokeAgentOptions, 'env'> & {
  env?: Record<string, string>;
  envAllowlist?: readonly string[];
};

const invokeOnce = async (
  target: NativeAgentTarget,
  request: AgentRequest,
  options: RunnerInvokeAgentOptions,
): Promise<InvocationAttempt> => {
  if (target.type === 'cli') {
    return invokeCliAgent(target, request, options);
  }
  if (target.type === 'http') {
    return invokeHttpAgent(target, request, { ...options, env: options.env ?? {} });
  }

  target satisfies never;
  throw new TypeError('Unsupported agent target');
};

/** Dispatches one target and retains every validated retry attempt for deterministic recording. */
const invokeAgent = async (
  target: NativeAgentTarget,
  request: AgentRequest,
  options: RunnerInvokeAgentOptions,
): Promise<InvocationResult> => {
  return invokeWithRetries(() => invokeOnce(target, request, options), options.retries);
};

export { invokeAgent, isRetryableInvocationError };
