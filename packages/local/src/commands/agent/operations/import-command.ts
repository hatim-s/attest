import type { AgentResource, JsonValue } from '@attest/contracts';

import { LocalError } from '../../../errors/index.js';
import { discoverProject } from '../../../project/discover-project.js';
import {
  candidateFromLoadedProject,
  loadCommandProject,
} from '../../project/load-command-project.js';
import type { CommandResult, MutationResult } from '../../shared/command-result.js';
import { redactAgentResource } from '../../show/redact-resource.js';
import {
  createImportedCurlAgentResource,
  readCurlDocument,
  readImportedAgentResource,
} from '../authoring/index.js';
import { mutationResult } from './agent-mutation.js';
import type { AgentImportCommandOptions, AgentRequest } from './types.js';

/** Builds the imported agent and the redacted preview shown before confirmation. */
const importAgentResource = async (
  request: AgentRequest<'agent.import'>,
  options: AgentImportCommandOptions,
): Promise<{ agent: AgentResource; preview?: JsonValue }> => {
  if (request.source_type === 'json') {
    const agent = await readImportedAgentResource(
      request.source,
      request.as,
      request.name,
      options.workingDirectory,
      options.readStdin,
    );
    return {
      agent,
      preview: agent.transport.kind === 'websocket' ? redactAgentResource(agent) : undefined,
    };
  }
  const curlSource =
    options.sourceText ??
    (await readCurlDocument(request.source, options.workingDirectory, options.readStdin));
  const { root } = await discoverProject({
    project: options.project,
    workingDirectory: options.workingDirectory,
  });
  const imported = await createImportedCurlAgentResource(request, curlSource, root);
  return {
    agent: imported.agent,
    preview: {
      request: imported.preview,
      extraction: request.extraction,
      ...(request.polling === undefined ? {} : { polling: request.polling }),
    },
  };
};

/** Imports one canonical JSON resource or inert cURL mapping without retaining source contents. */
const runAgentImportCommand = async (
  options: AgentImportCommandOptions,
): Promise<CommandResult<'mutation', MutationResult>> => {
  const { request } = options;
  const { agent, preview } = await importAgentResource(request, options);
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  if (loaded.agents.some(({ id }) => id === agent.id)) {
    throw new LocalError('project_invalid', `Agent ${agent.id} already exists.`, {
      path: agent.id,
    });
  }
  const candidate = candidateFromLoadedProject(loaded);
  candidate.agents.push(agent);
  return mutationResult({
    command: 'agent.import',
    loaded,
    candidate,
    request,
    confirmation: {
      definitionPreview: preview,
      interactive: options.interactive,
      nextCommand: `attest agent test ${agent.id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request.yes,
    },
  });
};

export { runAgentImportCommand };
