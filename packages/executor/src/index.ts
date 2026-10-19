export { AgentInvocationError, type InvocationErrorCode } from './errors.js';

export { invokeAgent } from './invoke.js';

export { invokeVercelSandboxAgent, resolveArtifactDestination } from './adapters/sandbox/index.js';

export {
  killProcessTree,
  listDescendantProcesses,
  spawnInProcessGroup,
  type ProcessIdentity,
} from './internal/process-tree.js';

export {
  invokeMappedHttpAgent,
  redactTransportText,
  type HttpAgentResource,
} from './adapters/http/index.js';

export {
  startBackgroundAgent,
  startJsonlBridgeAgent,
  type BackgroundAgentResource,
  type BackgroundAgentSession,
  type JsonlBridgeAgentResource,
  type JsonlBridgeSession,
} from './adapters/process/index.js';

export {
  completeCallbackAgent,
  createLoopbackCompletionReceiver,
  invokeCallbackAgent,
  triggerCallbackAgent,
  type CallbackAgentResource,
  type CallbackTriggerResult,
  type CompletionReceiver,
  type CompletionRegistration,
} from './adapters/callback/index.js';

export { enforceArtifactLimits } from './internal/artifact-limits.js';

export { invokeStreamingAgent, type StreamAgentResource } from './adapters/stream/index.js';

export { startWebSocketAgent, type WebSocketAgentResource } from './adapters/websocket/index.js';

export {
  type InvocationResult,
  type InvocationAttempt,
  type InvocationDiagnostics,
  type NativeAgentTarget,
} from './types.js';

export { justBashIsolation } from './isolation/just-bash.js';

export { type CaseEnvironment, type CaseEnvironmentFactory } from './isolation/types.js';

export { vercelSandboxIsolation } from './isolation/vercel.js';
