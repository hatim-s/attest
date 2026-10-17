import { candidateFromLoadedProject, loadCommandProject } from '../project/load-command-project.js';
import type { CommandResult, MutationResult } from '../shared/command-result.js';
import { assertNewId } from '../shared/resource-lookup.js';
import { redactAgentResource } from '../show/redact-resource.js';
import { assertSafeNativeAgentResource } from './authoring/resource-validation.js';
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

  assertNewId('agent', loaded.agents, request.agent.id);

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
