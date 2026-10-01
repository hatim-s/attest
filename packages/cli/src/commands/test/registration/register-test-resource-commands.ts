import { TEST_RESOURCE_SCHEMA_ID } from '@attest/contracts';
import { runTestListCommand, runTestShowCommand } from '@attest/local/test';
import type { Command } from 'commander';

import { setMutationHelp } from '../../../help/command-help.js';
import {
  addCommonOptions,
  addMutationOptions,
  collect,
  isInteractive,
  mutationRequestFields,
  outputFormat,
  type CommonCliOptions,
  type MutationCliOptions,
} from '../../shared/cli-options.js';
import type { CommandContext } from '../../shared/command-context.js';
import { readOrBuildRequest } from '../../shared/command-request.js';
import { renderCommandResult } from '../../shared/command-result.js';
import { requiredInput } from '../../shared/required-input.js';
import { confirmRemoval } from './confirm-removal.js';
import { runTestMutation } from './run-test-mutation.js';

type TestAddOptions = MutationCliOptions & {
  agent?: string;
  metric?: string[];
  name?: string;
};

/** Registers test resource authoring and inspection commands. */
const registerTestResourceCommands = (test: Command, context: CommandContext): void => {
  const add = addMutationOptions(test.command('add').description('Add a test bound to one agent.'))
    .argument('[test-id]', 'test id')
    .option('--agent <agent-id>', 'existing agent id')
    .option('--name <name>', 'test display name')
    .option('--metric <metric-id>', 'attached metric id', collect)
    .action(async (testId: string | undefined, options: TestAddOptions, leaf: Command) => {
      const prompt = {
        interactive: isInteractive(options, context.interaction, options.fromJson),
        prompt: context.interaction.prompt,
      };
      const request = await readOrBuildRequest({
        command: 'test.add',
        context,
        leaf,
        options,
        build: async () => {
          const id = await requiredInput(
            testId,
            { path: '<test-id>', question: 'Test id: ' },
            prompt,
          );
          const agentId = await requiredInput(
            options.agent,
            { path: '--agent', question: 'Existing agent id: ' },
            prompt,
          );
          return {
            ...mutationRequestFields('test.add', options),
            test: {
              schema: TEST_RESOURCE_SCHEMA_ID,
              id,
              name: options.name?.trim() || id,
              agent_id: agentId,
              cases: [],
              datasets: [],
              metrics: (options.metric ?? []).map((metric_id) => ({ metric_id })),
            },
          };
        },
      });
      await runTestMutation(request, options, context);
    });
  setMutationHelp(add, {
    examples: [
      'attest test add smoke --agent support',
      'attest test add --from-json ./test-add.json --output json',
    ],
  });

  addCommonOptions(test.command('list').description('List tests.')).action(
    async (options: CommonCliOptions) => {
      const result = await runTestListCommand({
        project: options.project,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('test.list', outputFormat(options), result));
    },
  );

  addCommonOptions(test.command('show').description('Show one test.'))
    .argument('[test-id]', 'test id')
    .action(async (testId: string | undefined, options: CommonCliOptions) => {
      const id = await requiredInput(
        testId,
        { path: '<test-id>', question: 'Test id: ' },
        {
          interactive: isInteractive(options, context.interaction),
          prompt: context.interaction.prompt,
        },
      );
      const result = await runTestShowCommand({
        project: options.project,
        testId: id,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('test.show', outputFormat(options), result));
    });

  const rename = addMutationOptions(test.command('rename').description('Rename one test.'))
    .argument('[test-id]', 'current test id')
    .argument('[new-id]', 'new test id')
    .action(
      async (
        testId: string | undefined,
        newId: string | undefined,
        options: MutationCliOptions,
        leaf: Command,
      ) => {
        const prompt = {
          interactive: isInteractive(options, context.interaction, options.fromJson),
          prompt: context.interaction.prompt,
        };
        const request = await readOrBuildRequest({
          command: 'test.rename',
          context,
          leaf,
          options,
          build: async () => ({
            ...mutationRequestFields('test.rename', options),
            test_id: await requiredInput(
              testId,
              { path: '<test-id>', question: 'Current test id: ' },
              prompt,
            ),
            new_id: await requiredInput(
              newId,
              { path: '<new-id>', question: 'New test id: ' },
              prompt,
            ),
          }),
        });
        await runTestMutation(request, options, context);
      },
    );
  setMutationHelp(rename, { examples: ['attest test rename smoke smoke-renamed --dry-run'] });

  const remove = addMutationOptions(test.command('remove').description('Remove one test.'))
    .argument('[test-id]', 'test id')
    .action(async (testId: string | undefined, options: MutationCliOptions, leaf: Command) => {
      const request = await readOrBuildRequest({
        command: 'test.remove',
        context,
        leaf,
        options,
        build: async () => ({
          ...mutationRequestFields('test.remove', options),
          test_id: await requiredInput(
            testId,
            { path: '<test-id>', question: 'Test id: ' },
            {
              interactive: isInteractive(options, context.interaction, options.fromJson),
              prompt: context.interaction.prompt,
            },
          ),
        }),
      });
      if (!(await confirmRemoval(request, `test ${request.test_id}`, options, context))) return;
      await runTestMutation(request, options, context);
    });
  setMutationHelp(remove, { examples: ['attest test remove smoke --yes'] });
};

export { registerTestResourceCommands };
