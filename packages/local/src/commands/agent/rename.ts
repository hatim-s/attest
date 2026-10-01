import { LocalError } from '../../errors/index.js';
import { candidateFromLoadedProject, loadCommandProject } from '../project/load-command-project.js';
import type { CommandResult, MutationResult } from '../shared/command-result.js';
import { findAgent, mutationResult } from './agent-mutation.js';
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
  const current = findAgent(loaded.agents, request.agent_id);
  if (loaded.agents.some(({ id }) => id === request.new_id)) {
    throw new LocalError('project_invalid', `Agent ${request.new_id} already exists.`, {
      path: request.new_id,
    });
  }
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
