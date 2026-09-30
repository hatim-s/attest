import type { AgentResource } from '@attest/contracts';

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

export { type StreamAgentResource, type StreamEvent, type StreamInvokeOptions };
