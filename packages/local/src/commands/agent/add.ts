import { candidateFromLoadedProject, loadCommandProject } from '../project/load-command-project.js';
import type { CommandResult, MutationResult } from '../shared/command-result.js';
import { assertNewId } from '../shared/resource-lookup.js';
import { redactAgentResource } from '../show/redact-resource.js';
import { createAgentResource } from './authoring/resource-builder.js';
import { assertSafeNativeAgentResource } from './authoring/resource-validation.js';
import { mutationResult } from './agent-mutation.js';
import type { AgentMutationCommandOptions, AgentRequest } from './types.js';

/** Adds one agent resource through the shared transactional project writer. */
const runAgentAddCommand = async (
  options: AgentMutationCommandOptions<AgentRequest<'agent.add'>>,
): Promise<CommandResult<'mutation', MutationResult>> => {
  const { request } = options;

  const agent =
    'agent' in request
      ? request.agent
      : createAgentResource({
          agentId: request.agent_id,
          name: request.name,
          callbackTriggerUrl: request.callback_trigger_url,
          callbackTriggerMethod: request.callback_trigger_method,
          callbackArtifactUrl: request.callback_artifact_url,
          callbackTraceUrl: request.callback_trace_url,
          callbackPublicUrl: request.callback_public_url,
          callbackPort:
            request.callback_port === undefined ? undefined : String(request.callback_port),
          idempotencyHeader: request.idempotency_header,
          header: request.header,
          headerEnv: request.header_env,
          query: request.query,
          timeout: request.timeout,
          trace: request.trace,
        });

  assertSafeNativeAgentResource(agent);

  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });

  assertNewId('agent', loaded.agents, agent.id);

  const candidate = candidateFromLoadedProject(loaded);
  candidate.agents.push(agent);

  return mutationResult({
    command: 'agent.add',
    loaded,
    candidate,
    request,
    confirmation: {
      definitionPreview:
        agent.transport.kind === 'websocket' ? redactAgentResource(agent) : undefined,
      interactive: options.interactive,
      nextCommand: `attest agent test ${agent.id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request.yes,
    },
  });
};

export { runAgentAddCommand };
