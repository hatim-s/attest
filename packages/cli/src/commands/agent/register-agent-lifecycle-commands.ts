import { runAgentRemoveCommand, runAgentRenameCommand } from '@attest/local/agent';
import type { Command } from 'commander';

import { renderCommandResult } from '../shared/command-result.js';
import {
  addMutationOptions,
  isInteractive,
  mergeCommonOptions,
  outputFormat,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import {
  markAgentMutationHelp,
  mutationArguments,
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
      const result = await runAgentRenameCommand({
        ...mutationArguments(options, context),
        agentId,
        interactive: isInteractive(options, context.interaction, options.fromJson),
        newId,
        prompt: context.interaction.prompt,
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
      const result = await runAgentRemoveCommand({
        ...mutationArguments(options, context),
        agentId,
        detach: options.detach,
        interactive: isInteractive(options, context.interaction, options.fromJson),
        prompt: context.interaction.prompt,
      });
      context.io.output(renderCommandResult('agent.remove', outputFormat(options), result));
    });
  markAgentMutationHelp(remove, ['attest agent remove support --dry-run'], {
    'agent-id': [],
    detach: [],
  });
};

export { registerAgentLifecycleCommands };
