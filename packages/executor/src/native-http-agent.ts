import type { AgentRequest } from '@attest/contracts';
import { invokeHttpAgent } from './http-invoker.js';
import { invokeWithRetries } from './internal/invocation-retry.js';
import type { InvocationResult, InvokeOptions, NativeAgentTarget } from './types.js';

/** Invokes and validates one native HTTP request without retrying interrupted remote work. */
const invokeNativeHttpAgent = (
  target: Extract<NativeAgentTarget, { type: 'http' }>,
  request: AgentRequest,
  options: InvokeOptions,
): Promise<InvocationResult> =>
  invokeWithRetries(() => invokeHttpAgent(target, request, options), 0);

export { invokeNativeHttpAgent };
