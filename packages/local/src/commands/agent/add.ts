import * as Effect from 'effect/Effect';
import { candidateFromLoadedProject, loadCommandProject } from '../project/load-command-project.js';

import { assertNewId } from '../shared/resource-lookup.js';
import { redactAgentResource } from '../show/redact-resource.js';
import { validateNativeAgentResource } from './authoring/resource-validation.js';
import { mutationResult } from './agent-mutation.js';
import type { AgentMutationCommandOptions, AgentRequest } from './types.js';

/** Adds one agent resource through the shared transactional project writer. */
const runAgentAddCommand = Effect.fn('runAgentAddCommand')(function* (
  options: AgentMutationCommandOptions<AgentRequest<'agent.add'>>,
) {
  const { request } = options;
  yield* validateNativeAgentResource(request.agent);

  const loaded = yield* loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });

  yield* assertNewId('agent', loaded.agents, request.agent.id);

  let candidate = candidateFromLoadedProject(loaded);
  candidate = { ...candidate, agents: [...candidate.agents, request.agent] };

  return yield* mutationResult({
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
});

export { runAgentAddCommand };
