import * as Effect from 'effect/Effect';
import { TEST_RESOURCE_SCHEMA_ID } from '@attest/contracts';
import { runTestListCommand, runTestShowCommand } from '@attest/local/test';
import type { Command } from 'commander';

import { setMutationHelp } from '../../../help/command-help.js';
import {
  addCommonOptions,
  addMutationOptions,
  collect,
  mutationRequestFields,
  outputFormat,
  promptContext,
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
    .action((testId: string | undefined, options: TestAddOptions, leaf: Command) =>
      context.submit(
        Effect.gen(function* () {
          const prompt = promptContext(options, context.interaction, context.signal);

          const request = yield* readOrBuildRequest({
            command: 'test.add',
            context,
            leaf,
            options,
            build: () =>
              Effect.gen(function* () {
                const id = yield* requiredInput(
                  testId,
                  { path: '<test-id>', question: 'Test id: ' },
                  prompt,
                );

                const agentId = yield* requiredInput(
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
              }),
          });

          const result = yield* runTestMutation(request, options, context);

          context.io.output(renderCommandResult(request.command, outputFormat(options), result));
        }),
      ),
    );

  setMutationHelp(add, {
    examples: [
      'attest test add smoke --agent support',
      'attest test add --from-json ./test-add.json --output json',
    ],
  });

  addCommonOptions(test.command('list').description('List tests.')).action(
    (options: CommonCliOptions) =>
      context.submit(
        Effect.gen(function* () {
          const result = yield* runTestListCommand({
            project: options.project,
            workingDirectory: context.workingDirectory,
          });

          context.io.output(renderCommandResult('test.list', outputFormat(options), result));
        }),
      ),
  );

  addCommonOptions(test.command('show').description('Show one test.'))
    .argument('[test-id]', 'test id')
    .action((testId: string | undefined, options: CommonCliOptions) =>
      context.submit(
        Effect.gen(function* () {
          const id = yield* requiredInput(
            testId,
            { path: '<test-id>', question: 'Test id: ' },
            promptContext(options, context.interaction, context.signal),
          );

          const result = yield* runTestShowCommand({
            project: options.project,
            testId: id,
            workingDirectory: context.workingDirectory,
          });

          context.io.output(renderCommandResult('test.show', outputFormat(options), result));
        }),
      ),
    );

  const rename = addMutationOptions(test.command('rename').description('Rename one test.'))
    .argument('[test-id]', 'current test id')
    .argument('[new-id]', 'new test id')
    .action(
      (
        testId: string | undefined,
        newId: string | undefined,
        options: MutationCliOptions,
        leaf: Command,
      ) =>
        context.submit(
          Effect.gen(function* () {
            const prompt = promptContext(options, context.interaction, context.signal);

            const request = yield* readOrBuildRequest({
              command: 'test.rename',
              context,
              leaf,
              options,
              build: () =>
                Effect.gen(function* () {
                  return {
                    ...mutationRequestFields('test.rename', options),
                    test_id: yield* requiredInput(
                      testId,
                      { path: '<test-id>', question: 'Current test id: ' },
                      prompt,
                    ),
                    new_id: yield* requiredInput(
                      newId,
                      { path: '<new-id>', question: 'New test id: ' },
                      prompt,
                    ),
                  };
                }),
            });

            const result = yield* runTestMutation(request, options, context);

            context.io.output(renderCommandResult(request.command, outputFormat(options), result));
          }),
        ),
    );

  setMutationHelp(rename, { examples: ['attest test rename smoke smoke-renamed --dry-run'] });

  const remove = addMutationOptions(test.command('remove').description('Remove one test.'))
    .argument('[test-id]', 'test id')
    .action((testId: string | undefined, options: MutationCliOptions, leaf: Command) =>
      context.submit(
        Effect.gen(function* () {
          const request = yield* readOrBuildRequest({
            command: 'test.remove',
            context,
            leaf,
            options,
            build: () =>
              Effect.gen(function* () {
                return {
                  ...mutationRequestFields('test.remove', options),
                  test_id: yield* requiredInput(
                    testId,
                    { path: '<test-id>', question: 'Test id: ' },
                    promptContext(options, context.interaction, context.signal),
                  ),
                };
              }),
          });

          if (
            !(yield* confirmRemoval({
              request,
              label: `test ${request.test_id}`,
              options,
              context,
            }))
          )
            return;
          const result = yield* runTestMutation(request, options, context);

          context.io.output(renderCommandResult(request.command, outputFormat(options), result));
        }),
      ),
    );

  setMutationHelp(remove, { examples: ['attest test remove smoke --yes'] });
};

export { registerTestResourceCommands };
