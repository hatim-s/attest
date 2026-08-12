import type { AgentResource } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import type { InvocationAttempt } from '../../types.js';

type StreamAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'stream' }>;
};

type StreamInvokeOptions = {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  secrets?: readonly string[];
  signal?: AbortSignal;
};

type StreamEvent = { eventName?: string; heartbeat: boolean; raw: unknown; source: string };
type StreamFailure = AgentInvocationError & {
  applicationStarted?: boolean;
  httpStatus?: number;
  rawExcerpt?: InvocationAttempt['rawExcerpt'];
  retryAfterMs?: number;
};

export { type StreamAgentResource, type StreamEvent, type StreamFailure, type StreamInvokeOptions };
