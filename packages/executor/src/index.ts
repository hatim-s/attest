export { AgentInvocationError, type InvocationErrorCode } from './errors.js';
export { invokeAgent } from './invoke.js';
export {
  invokeVercelSandboxAgent,
  type VercelSandboxCaseOptions,
  type VercelSandboxFactory,
  type VercelSandboxInvocation,
  type VercelSandboxSdk,
} from './adapters/sandbox/index.js';
export {
  killProcessTree,
  listDescendantProcesses,
  spawnInProcessGroup,
  type ProcessIdentity,
} from './internal/process-tree.js';
export {
  invokeMappedHttpAgent,
  redactEventEvidence,
  redactTransportText,
  type HttpAgentResource,
  type MappedHttpInvokeOptions,
} from './adapters/http/index.js';
export {
  BackgroundAgentSession,
  JsonlBridgeSession,
  assertLoopbackUrl,
  startBackgroundAgent,
  startJsonlBridgeAgent,
  type BackgroundAgentResource,
  type BackgroundSessionOptions,
  type JsonlBridgeAgentResource,
  type JsonlBridgeSessionOptions,
} from './adapters/process/index.js';
export {
  invokeStreamingAgent,
  type StreamAgentResource,
  type StreamInvokeOptions,
} from './adapters/stream/index.js';
export {
  type WebSocketAgentSession,
  startWebSocketAgent,
  type WebSocketAgentResource,
  type WebSocketSessionOptions,
} from './adapters/websocket/index.js';
export {
  type InvokeAgentOptions,
  type InvocationResult,
  type InvocationAttempt,
  type InvocationDiagnostics,
  type InvokeOptions,
  type NativeAgentTarget,
} from './types.js';

export { justBashIsolation, type JustBashIsolationOptions } from './isolation/just-bash.js';
export {
  type CaseEnvironment,
  type CaseEnvironmentContext,
  type CaseEnvironmentFactory,
} from './isolation/types.js';
export { vercelSandboxIsolation, type VercelIsolationOptions } from './isolation/vercel.js';
