import { valueFromExit } from '../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { LocalError } from '../../errors/index.js';
import { candidateFromLoadedProject, loadCommandProject } from '../project/load-command-project.js';
import type { CommandResult, MutationResult } from '../shared/command-result.js';
import { findResource } from '../shared/resource-lookup.js';
import { mutationResult } from './agent-mutation.js';
import type { AgentMutationCommandOptions, AgentRequest } from './types.js';

/** Removes an unreferenced agent, or explicitly cascades dependent tests with --detach. */
const runAgentRemoveCommand = async (
  options: AgentMutationCommandOptions<AgentRequest<'agent.remove'>>,
): Promise<CommandResult<'mutation', MutationResult>> => {
  const { request } = options;

  // EFFECT-BRIDGE(S8b)
  const loaded = await Effect.runPromiseExit(
    loadCommandProject({
      project: options.project,
      recover: request.dry_run !== true,
      workingDirectory: options.workingDirectory,
    }),
  ).then((exit) => valueFromExit(exit));

  findResource('agent', loaded.agents, request.agent_id);

  const dependentTests = loaded.tests.filter(
    ({ agent_id: agentId }) => agentId === request.agent_id,
  );

  if (dependentTests.length > 0 && request.detach !== true) {
    throw new LocalError('project_invalid', 'Agent is referenced by tests.', {
      path: request.agent_id,
      hint: 'Rename the reference, remove the dependent tests, or pass `--detach` to cascade them.',
      details: { dependent_test_ids: dependentTests.map(({ id }) => id) },
    });
  }

  let candidate = candidateFromLoadedProject(loaded);
  candidate = {
    ...candidate,
    agents: candidate.agents.filter(({ id }) => id !== request.agent_id),
  };
  candidate = {
    ...candidate,
    tests: candidate.tests.filter(({ agent_id: agentId }) => agentId !== request.agent_id),
  };

  const warnings =
    dependentTests.length === 0
      ? []
      : [`Removed dependent tests: ${dependentTests.map(({ id }) => id).join(', ')}`];

  return mutationResult({
    command: 'agent.remove',
    loaded,
    candidate,
    request,
    warnings,
    confirmation: {
      interactive: options.interactive,
      prompt: options.prompt,
      requireExplicit: dependentTests.length > 0,
      yes: request.yes,
    },
  });
};

export { runAgentRemoveCommand };
