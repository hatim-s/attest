import type { AgentResource } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import type { HttpJsonResponse } from './http-client.js';

type HttpAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'http' | 'polling' }>;
};

type MappedHttpInvokeOptions = {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  secrets?: readonly string[];
  signal?: AbortSignal;
};

type CompletedHttpResponse = {
  durationMs: number;
  remoteJobId?: string | number;
  response: HttpJsonResponse;
};

type TimedInvocationError = AgentInvocationError & {
  attemptDurationMs?: number;
};

export {
  type CompletedHttpResponse,
  type HttpAgentResource,
  type MappedHttpInvokeOptions,
  type TimedInvocationError,
};
