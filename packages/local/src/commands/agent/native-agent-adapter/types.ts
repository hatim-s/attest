import type { AgentResource, JsonValue } from '@attest/contracts';
import type { StoredCaseExecution } from '@attest/core';
import type {
  BackgroundAgentResource,
  HttpAgentResource,
  JsonlBridgeAgentResource,
  NativeAgentTarget,
  StreamAgentResource,
  WebSocketAgentResource,
} from '@attest/runtime';

type NativeAgentTestOptions = {
  agent: AgentResource;
  input: JsonValue;
  onProgress?: (message: string) => void;
  onExecution?: (execution: StoredCaseExecution) => Promise<void>;
  projectRoot: string;
  runId?: string;
  secretFileObserver?: (path: string) => Promise<void>;
  signal?: AbortSignal;
};

type ResolvedNativeAgent =
  | {
      kind: 'direct';
      env?: Record<string, string>;
      headers?: Record<string, string>;
      secrets: string[];
      target: NativeAgentTarget;
    }
  | {
      argv: readonly [string, ...string[]];
      cwd?: string;
      env: Record<string, string>;
      kind: 'vercel_sandbox';
      sandbox: NonNullable<Extract<AgentResource['transport'], { kind: 'native_cli' }>['sandbox']>;
      secrets: string[];
    }
  | {
      agent: BackgroundAgentResource;
      cwd: string;
      env: Record<string, string>;
      invokeHeaders: Record<string, string>;
      invokeQuery: Record<string, string>;
      kind: 'background';
      secrets: string[];
      shutdownHeaders: Record<string, string>;
      shutdownQuery: Record<string, string>;
    }
  | {
      agent: JsonlBridgeAgentResource;
      cwd: string;
      env: Record<string, string>;
      kind: 'jsonl_bridge';
      secrets: string[];
    }
  | {
      agent: HttpAgentResource;
      headers: Record<string, string>;
      kind: 'mapped_http';
      query: Record<string, string>;
      secrets: string[];
    }
  | {
      agent: StreamAgentResource;
      headers: Record<string, string>;
      kind: 'stream';
      query: Record<string, string>;
      secrets: string[];
    }
  | {
      agent: WebSocketAgentResource;
      headers: Record<string, string>;
      kind: 'websocket';
      secrets: string[];
    };

export { type NativeAgentTestOptions, type ResolvedNativeAgent };
