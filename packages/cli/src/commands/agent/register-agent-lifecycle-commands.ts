import {
  readCommandRequest,
  runAgentRemoveCommand,
  runAgentRenameCommand,
  validateCommandRequest,
} from '@attest/local/agent';
import type { Command } from 'commander';

import { renderCommandResult } from '../shared/command-result.js';
import {
  addMutationOptions,
  isInteractive,
  mergeCommonOptions,
  outputFormat,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import { promptRequired } from './agent-prompts.js';
import {
  agentMutationFields,
  assertNoAgentRequestOverlap,
  markAgentMutationHelp,
  type RegisterAgentCommandsOptions,
} from './registration-support.js';

type RemoveOptions = MutationCliOptions & { detach?: boolean };

/** Registers agent rename and removal commands that update project references atomically. */
const registerAgentLifecycleCommands = (
  agent: Command,
  context: RegisterAgentCommandsOptions,
): void => {
  const rename = addMutationOptions(
    agent
      .command('rename')
      .description('Rename an agent and every test reference atomically.')
      .argument('[agent-id]', 'current agent id')
      .argument('[new-id]', 'new agent id'),
  ).action(
    async (
      agentId: string | undefined,
      newId: string | undefined,
      raw: MutationCliOptions,
      command: Command,
    ) => {
      const options = mergeCommonOptions(raw, command, context.program);
      assertNoAgentRequestOverlap(options, { 'agent-id': agentId, 'new-id': newId });
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const promptContext = { interactive, prompt: context.interaction.prompt };
      const request =
        options.fromJson === undefined
          ? validateCommandRequest('agent.rename', {
              ...agentMutationFields('agent.rename', options),
              agent_id: await promptRequired(agentId, 'Agent id', '<agent-id>', promptContext),
              new_id: await promptRequired(newId, 'New agent id', '<new-id>', promptContext),
            })
          : await readCommandRequest('agent.rename', options.fromJson, {
              readStdin: context.interaction.readStdin,
              workingDirectory: context.workingDirectory,
            });
      const result = await runAgentRenameCommand({
        interactive,
        project: options.project,
        prompt: context.interaction.prompt,
        request,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('agent.rename', outputFormat(options), result));
    },
  );
  markAgentMutationHelp(rename, ['attest agent rename support support-renamed'], {
    'agent-id': [],
    'new-id': [],
  });

  const remove = addMutationOptions(
    agent
      .command('remove')
      .description('Remove an agent resource.')
      .argument('[agent-id]', 'agent id'),
  )
    .option('--detach', 'also remove tests that require this agent')
    .action(async (agentId: string | undefined, raw: RemoveOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      assertNoAgentRequestOverlap(options, { 'agent-id': agentId, detach: options.detach });
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request =
        options.fromJson === undefined
          ? validateCommandRequest('agent.remove', {
              ...agentMutationFields('agent.remove', options),
              agent_id: await promptRequired(agentId, 'Agent id', '<agent-id>', {
                interactive,
                prompt: context.interaction.prompt,
              }),
              ...(options.detach === undefined ? {} : { detach: options.detach }),
            })
          : await readCommandRequest('agent.remove', options.fromJson, {
              readStdin: context.interaction.readStdin,
              workingDirectory: context.workingDirectory,
            });
      const result = await runAgentRemoveCommand({
        interactive,
        project: options.project,
        prompt: context.interaction.prompt,
        request,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('agent.remove', outputFormat(options), result));
    });
  markAgentMutationHelp(remove, ['attest agent remove support --dry-run'], {
    'agent-id': [],
    detach: [],
  });
};

export { registerAgentLifecycleCommands };
