import { TEST_RESOURCE_SCHEMA_ID } from '@attest/contracts';
import type { Command } from 'commander';

import {
  addCommonOptions,
  addMutationOptions,
  collect,
  commonRequestFields,
  confirmRemoval,
  isInteractive,
  markMutationHelp,
  outputFormat,
  renderCommandResult,
  requestFromSource,
  requiredInput,
  runMutation,
  type CommonOptions,
  type MutationOptions,
  type RegisterTestCommandsOptions,
  type TestOptions,
} from './support.js';
import { runTestListCommand, runTestShowCommand } from '../test-command.js';

/** Registers test resource authoring and inspection commands. */
const registerTestResourceCommands = (
  test: Command,
  context: RegisterTestCommandsOptions,
): void => {
  const add = addMutationOptions(test.command('add').description('Add a test bound to one agent.'))
    .argument('[test-id]', 'test id')
    .option('--agent <agent-id>', 'existing agent id')
    .option('--name <name>', 'test display name')
    .option('--metric <metric-id>', 'attached metric id', collect);
  add.action(async (testId: string | undefined, options: TestOptions) => {
    const interactive = isInteractive(options, context.interaction, options.fromJson);
    const request = await requestFromSource(
      'test.add',
      options,
      { 'test-id': testId, agent: options.agent, metric: options.metric, name: options.name },
      context,
      async () => {
        const id = await requiredInput(
          testId,
          '<test-id>',
          'Test id: ',
          interactive,
          context.interaction,
        );
        const agentId = await requiredInput(
          options.agent,
          '--agent',
          'Existing agent id: ',
          interactive,
          context.interaction,
        );
        return {
          ...commonRequestFields('test.add', options),
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
    );
    await runMutation('test.add', request, options, context);
  });
  markMutationHelp(add, [
    'attest test add smoke --agent support',
    'attest test add --from-json ./test-add.json --output json',
  ]);

  addCommonOptions(test.command('list').description('List tests.')).action(
    async (options: CommonOptions) => {
      const result = await runTestListCommand({
        project: options.project,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('test.list', outputFormat(options), result));
    },
  );

  addCommonOptions(test.command('show').description('Show one test.'))
    .argument('[test-id]', 'test id')
    .action(async (testId: string | undefined, options: CommonOptions) => {
      const id = await requiredInput(
        testId,
        '<test-id>',
        'Test id: ',
        isInteractive(options, context.interaction),
        context.interaction,
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
    .argument('[new-id]', 'new test id');
  rename.action(
    async (testId: string | undefined, newId: string | undefined, options: MutationOptions) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await requestFromSource(
        'test.rename',
        options,
        { 'test-id': testId, 'new-id': newId },
        context,
        async () => ({
          ...commonRequestFields('test.rename', options),
          test_id: await requiredInput(
            testId,
            '<test-id>',
            'Current test id: ',
            interactive,
            context.interaction,
          ),
          new_id: await requiredInput(
            newId,
            '<new-id>',
            'New test id: ',
            interactive,
            context.interaction,
          ),
        }),
      );
      await runMutation('test.rename', request, options, context);
    },
  );
  markMutationHelp(rename, ['attest test rename smoke smoke-renamed --dry-run']);

  const remove = addMutationOptions(
    test.command('remove').description('Remove one test.'),
  ).argument('[test-id]', 'test id');
  remove.action(async (testId: string | undefined, options: MutationOptions) => {
    const request = await requestFromSource(
      'test.remove',
      options,
      { 'test-id': testId },
      context,
      async () => ({
        ...commonRequestFields('test.remove', options),
        test_id: await requiredInput(
          testId,
          '<test-id>',
          'Test id: ',
          isInteractive(options, context.interaction, options.fromJson),
          context.interaction,
        ),
      }),
    );
    if (!(await confirmRemoval(request, `test ${request.test_id}`, options, context))) return;
    await runMutation('test.remove', request, options, context);
  });
  markMutationHelp(remove, ['attest test remove smoke --yes']);
};

export { registerTestResourceCommands };
