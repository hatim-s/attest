import { LocalError } from '../../errors/index.js';
import * as Effect from 'effect/Effect';
import { candidateFromLoadedProject, loadCommandProject } from '../project/load-command-project.js';

import { assertNewId, findResource } from '../shared/resource-lookup.js';
import { mutationResult } from './agent-mutation.js';
import type { AgentMutationCommandOptions, AgentRequest } from './types.js';

/** Renames an agent and every test reference in one atomic transaction. */
const runAgentRenameCommand = Effect.fn('runAgentRenameCommand')(function* (
  options: AgentMutationCommandOptions<AgentRequest<'agent.rename'>>,
) {
  try {
    const { request } = options;

    const loaded = yield* loadCommandProject({
      project: options.project,
      recover: request.dry_run !== true,
      workingDirectory: options.workingDirectory,
    });

    const current = findResource('agent', loaded.agents, request.agent_id);

    assertNewId('agent', loaded.agents, request.new_id);

    let candidate = candidateFromLoadedProject(loaded);
    candidate = {
      ...candidate,
      agents: candidate.agents.map((agent) =>
        agent.id === current.id ? { ...agent, id: request.new_id } : agent,
      ),
    };
    candidate = {
      ...candidate,
      tests: candidate.tests.map((test) =>
        test.agent_id === current.id ? { ...test, agent_id: request.new_id } : test,
      ),
    };

    return yield* mutationResult({
      command: 'agent.rename',
      loaded,
      candidate,
      request,
      renames: [{ from: request.agent_id, to: request.new_id, type: 'agent' as const }],
      confirmation: {
        interactive: options.interactive,
        nextCommand: `attest agent test ${request.new_id}`,
        prompt: options.prompt,
        requireExplicit: false,
        yes: request.yes,
      },
    });
  } catch (error) {
    if (error instanceof LocalError) return yield* Effect.fail(error);
    throw error;
  }
});

export { runAgentRenameCommand };
