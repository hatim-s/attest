import { candidateFromLoadedProject, loadCommandProject } from '../project/load-command-project.js';
import type { CommandResult, MutationResult } from '../shared/command-result.js';
import { assertNewId, findResource } from '../shared/resource-lookup.js';
import { mutationResult } from './agent-mutation.js';
import type { AgentMutationCommandOptions, AgentRequest } from './types.js';

/** Renames an agent and every test reference in one atomic transaction. */
const runAgentRenameCommand = async (
  options: AgentMutationCommandOptions<AgentRequest<'agent.rename'>>,
): Promise<CommandResult<'mutation', MutationResult>> => {
  const { request } = options;

  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });

  const current = findResource('agent', loaded.agents, request.agent_id);

  assertNewId('agent', loaded.agents, request.new_id);

  const candidate = candidateFromLoadedProject(loaded);
  candidate.agents = candidate.agents.map((agent) =>
    agent.id === current.id ? { ...agent, id: request.new_id } : agent,
  );
  candidate.tests = candidate.tests.map((test) =>
    test.agent_id === current.id ? { ...test, agent_id: request.new_id } : test,
  );

  return mutationResult({
    command: 'agent.rename',
    loaded,
    candidate,
    request,
    renames: [{ from: request.agent_id, to: request.new_id, type: 'agent' }],
    confirmation: {
      interactive: options.interactive,
      nextCommand: `attest agent test ${request.new_id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request.yes,
    },
  });
};

export { runAgentRenameCommand };
