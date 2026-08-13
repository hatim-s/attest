import type { CommandRequest } from '@attest/contracts';

import type { PublishObserver } from '../../../project/transaction/index.js';
import type { ReadInput } from '../agent-request.js';

type Prompt = (question: string, options?: { signal?: AbortSignal }) => Promise<string>;

type MutationFields = {
  dryRun?: boolean;
  expectedProjectHash?: string;
  fromJson?: string;
  project?: string;
  publishObserver?: PublishObserver;
  readStdin: ReadInput;
  workingDirectory: string;
  yes?: boolean;
};

type AgentAddCommandOptions = MutationFields & {
  acknowledgementPointer?: string;
  acknowledgementValues?: readonly string[];
  agentId?: string;
  argvJson?: string;
  attemptTimeout?: string;
  backgroundCommand?: string;
  bridgeConcurrency?: 'serial' | 'multiplexed';
  cancellationGrace?: string;
  closeTimeout?: string;
  connectionMode?: 'serial' | 'multiplexed';
  cwd?: string;
  env?: readonly string[];
  errorPointer?: string;
  eventName?: string;
  headerEnv?: readonly string[];
  incrementalOutputMode?: 'text' | 'array';
  incrementalOutputPointer?: string;
  idleTimeout?: string;
  interactive: boolean;
  invokeUrl?: string;
  jsonlCommand?: string;
  name?: string;
  nativeCommand?: string;
  nativeHttp?: string;
  openTimeout?: string;
  pingInterval?: string;
  prompt?: Prompt;
  readinessHttp?: string;
  readinessStderr?: string;
  readinessTcp?: string;
  requestIdPointer?: string;
  requestTemplate?: string;
  responsePointer?: string;
  shutdownUrl?: string;
  stopTimeout?: string;
  streamFraming?: 'sse' | 'jsonl';
  streamUrl?: string;
  terminalPointer?: string;
  terminalValues?: readonly string[];
  timeout?: string;
  trace?: boolean;
  tracePointer?: string;
  webSocketLifecycle?: 'per_case' | 'per_run';
  webSocketSubprotocol?: string;
  webSocketUrl?: string;
};

type AgentImportCommandOptions = MutationFields & {
  agentId?: string;
  attemptTimeout?: string;
  bodyTimeout?: string;
  connectTimeout?: string;
  errorPointer?: string;
  firstByteTimeout?: string;
  headerEnv?: readonly string[];
  idempotencyHeader?: string;
  interactive: boolean;
  mapBody?: readonly string[];
  name?: string;
  pollFailure?: readonly string[];
  pollJobIdPointer?: string;
  pollMaximumInterval?: string;
  pollMinimumInterval?: string;
  pollStatusPointer?: string;
  pollStatusUrlPointer?: string;
  pollStatusUrlTemplate?: string;
  pollSuccess?: readonly string[];
  prompt?: Prompt;
  queryEnv?: readonly string[];
  requestCapBytes?: string;
  responseCapBytes?: string;
  responsePointer?: string;
  retries?: string;
  retryDelay?: string;
  remoteJobIdPointer?: string;
  source?: string;
  sourceType?: string;
  tracePointer?: string;
};

type AgentRenameCommandOptions = MutationFields & {
  agentId?: string;
  interactive: boolean;
  newId?: string;
  prompt?: Prompt;
};

type AgentRemoveCommandOptions = MutationFields & {
  agentId?: string;
  detach?: boolean;
  interactive: boolean;
  prompt?: Prompt;
};

type AgentTestCommandOptions = {
  agentId?: string;
  fromJson?: string;
  input?: string;
  inputFile?: string;
  interactive: boolean;
  onProgress?: (message: string) => void;
  project?: string;
  prompt?: Prompt;
  readStdin: ReadInput;
  signal?: AbortSignal;
  watch?: boolean;
  record?: boolean;
  workingDirectory: string;
};

type AgentMutationRequest = Extract<
  CommandRequest,
  { command: 'agent.add' | 'agent.import' | 'agent.remove' | 'agent.rename' }
>;

type CurlImportRequest = Extract<CommandRequest, { command: 'agent.import'; source_type: 'curl' }>;

export {
  type AgentAddCommandOptions,
  type AgentImportCommandOptions,
  type AgentMutationRequest,
  type AgentRemoveCommandOptions,
  type AgentRenameCommandOptions,
  type AgentTestCommandOptions,
  type CurlImportRequest,
  type MutationFields,
  type Prompt,
};
