import { AttestCliError } from '../../../errors/index.js';
import { loadCommandProject } from '../../project/load-command-project.js';
import type { CommandResult } from '../../shared/command-result.js';
import { readAgentCommandRequest } from '../agent-request.js';
import {
  assertNoFromJsonFlags,
  candidateFromLoaded,
  findAgent,
  mutationResult,
  promptRequired,
} from './command-support.js';
import type { AgentRemoveCommandOptions, AgentRenameCommandOptions } from './types.js';

/** Renames an agent and every test reference in one atomic transaction. */
const runAgentRenameCommand = async (
  options: AgentRenameCommandOptions,
): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    'new-id': options.newId,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  const request =
    options.fromJson === undefined
      ? {
          schema: 'attest.command-request' as const,
          command: 'agent.rename' as const,
          agent_id: await promptRequired(
            options.agentId,
            'Agent id',
            '<agent-id>',
            options.interactive,
            options.prompt,
          ),
          new_id: await promptRequired(
            options.newId,
            'New agent id',
            '<new-id>',
            options.interactive,
            options.prompt,
          ),
          ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
          ...(options.expectedProjectHash === undefined
            ? {}
            : { if_project_hash: options.expectedProjectHash }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
        }
      : await readAgentCommandRequest(
          options.fromJson,
          'agent.rename',
          options.workingDirectory,
          options.readStdin,
        );
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  const current = findAgent(loaded.agents, request.agent_id);
  if (loaded.agents.some(({ id }) => id === request.new_id)) {
    throw new AttestCliError('project_invalid', `Agent ${request.new_id} already exists.`, {
      path: request.new_id,
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents = candidate.agents.map((agent) =>
    agent.id === current.id ? { ...agent, id: request.new_id } : agent,
  );
  candidate.tests = candidate.tests.map((test) =>
    test.agent_id === current.id ? { ...test, agent_id: request.new_id } : test,
  );
  return mutationResult(
    'agent.rename',
    loaded,
    candidate,
    request,
    options.publishObserver,
    [{ from: request.agent_id, to: request.new_id, type: 'agent' }],
    undefined,
    {
      interactive: options.interactive,
      nextCommand: `attest agent test ${request.new_id}`,
      prompt: options.prompt,
      requireExplicit: false,
      yes: request.yes,
    },
  );
};

/** Removes an unreferenced agent, or explicitly cascades dependent tests with --detach. */
const runAgentRemoveCommand = async (
  options: AgentRemoveCommandOptions,
): Promise<CommandResult> => {
  assertNoFromJsonFlags(options.fromJson, {
    'agent-id': options.agentId,
    detach: options.detach,
    'dry-run': options.dryRun,
    'if-project-hash': options.expectedProjectHash,
    yes: options.yes,
  });
  const request =
    options.fromJson === undefined
      ? {
          schema: 'attest.command-request' as const,
          command: 'agent.remove' as const,
          agent_id: await promptRequired(
            options.agentId,
            'Agent id',
            '<agent-id>',
            options.interactive,
            options.prompt,
          ),
          ...(options.detach === undefined ? {} : { detach: options.detach }),
          ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
          ...(options.expectedProjectHash === undefined
            ? {}
            : { if_project_hash: options.expectedProjectHash }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
        }
      : await readAgentCommandRequest(
          options.fromJson,
          'agent.remove',
          options.workingDirectory,
          options.readStdin,
        );
  const loaded = await loadCommandProject({
    project: options.project,
    recover: request.dry_run !== true,
    workingDirectory: options.workingDirectory,
  });
  findAgent(loaded.agents, request.agent_id);
  const dependentTests = loaded.tests.filter(
    ({ agent_id: agentId }) => agentId === request.agent_id,
  );
  if (dependentTests.length > 0 && request.detach !== true) {
    throw new AttestCliError('project_invalid', 'Agent is referenced by tests.', {
      path: request.agent_id,
      hint: 'Rename the reference, remove the dependent tests, or pass `--detach` to cascade them.',
      details: { dependent_test_ids: dependentTests.map(({ id }) => id) },
    });
  }
  const candidate = candidateFromLoaded(loaded);
  candidate.agents = candidate.agents.filter(({ id }) => id !== request.agent_id);
  candidate.tests = candidate.tests.filter(({ agent_id: agentId }) => agentId !== request.agent_id);
  const warnings =
    dependentTests.length === 0
      ? []
      : [`Removed dependent tests: ${dependentTests.map(({ id }) => id).join(', ')}`];
  return mutationResult(
    'agent.remove',
    loaded,
    candidate,
    request,
    options.publishObserver,
    undefined,
    warnings,
    {
      interactive: options.interactive,
      prompt: options.prompt,
      requireExplicit: dependentTests.length > 0,
      yes: request.yes,
    },
  );
};

export { runAgentRemoveCommand, runAgentRenameCommand };
