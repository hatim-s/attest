import { LocalError } from '../../../errors/index.js';
import {
  candidateFromLoadedProject,
  loadCommandProject,
} from '../../project/load-command-project.js';
import type { CommandResult, MutationResult } from '../../shared/command-result.js';
import { redactAgentResource } from '../../show/redact-resource.js';
import { assertSafeNativeAgentResource } from '../authoring/index.js';
import { mutationResult } from './agent-mutation.js';
import type { AgentMutationCommandOptions, AgentRequest } from './types.js';

/** Adds one agent resource through the shared transactional project writer. */
const runAgentAddCommand = async (
  options: AgentMutationCommandOptions<AgentRequest<'agent.add'>>,
): Promise<CommandResult<'mutation', MutationResult>> => {
  const { request } = options;
  assertSafeNativeAgentResource(request.agent);
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  if (loaded.agents.some(({ id }) => id === request.agent.id)) {
    throw new LocalError('project_invalid', `Agent ${request.agent.id} already exists.`, {
      path: request.agent.id,
      hint: 'Choose another id or remove the existing agent first.',
    });
  }
  const candidate = candidateFromLoadedProject(loaded);
  candidate.agents.push(request.agent);
  return mutationResult({
    command: 'agent.add',
    loaded,
    candidate,
    request,
    confirmation: {
      definitionPreview:
        request.agent.transport.kind === 'websocket'
          ? redactAgentResource(request.agent)
          : undefined,
      interactive: options.interactive,
      nextCommand: `attest agent test ${request.agent.id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request.yes,
    },
  });
};

export { runAgentAddCommand };
