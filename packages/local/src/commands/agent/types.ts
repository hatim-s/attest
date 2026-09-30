import type { CommandRequest } from '@attest/contracts';

import type { Prompt } from '../shared/prompt.js';
import type { ReadInput } from './authoring/types.js';

type AgentRequest<Command extends CommandRequest['command']> = Extract<
  CommandRequest,
  { command: Command }
>;

type AgentMutationRequest = AgentRequest<
  'agent.add' | 'agent.import' | 'agent.remove' | 'agent.rename'
>;

/** Inputs every agent mutation shares; the prompt is used only to confirm the preview. */
type AgentMutationCommandOptions<Request extends AgentMutationRequest> = {
  interactive: boolean;
  project?: string;
  prompt?: Prompt;
  request: Request;
  workingDirectory: string;
};

type AgentImportCommandOptions = AgentMutationCommandOptions<AgentRequest<'agent.import'>> & {
  readStdin: ReadInput;
  /** Import source the caller already read, so stdin is consumed only once. */
  sourceText?: string;
};

type AgentTestCommandOptions = {
  onProgress?: (message: string) => void;
  project?: string;
  request: AgentRequest<'agent.test'>;
  signal?: AbortSignal;
  watch?: boolean;
  workingDirectory: string;
};

export {
  type AgentImportCommandOptions,
  type AgentMutationCommandOptions,
  type AgentMutationRequest,
  type AgentRequest,
  type AgentTestCommandOptions,
};
