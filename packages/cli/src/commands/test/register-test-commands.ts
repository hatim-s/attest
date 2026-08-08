import {
  CASE_SCHEMA_VERSION,
  COMMAND_REQUEST_SCHEMA_VERSION,
  DATASET_SCHEMA_VERSION,
  TEST_RESOURCE_SCHEMA_VERSION,
} from '@attest/contracts';
import { Command, Option } from 'commander';

import { AttestCliError } from '../../errors.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import type { CliIo } from '../../run-cli.js';
import { renderCommandResult } from '../command-result.js';
import type { CliInteraction } from '../register-project-resource-commands.js';
import { parseJsonFlag, readCommandRequest, validateCommandRequest } from './test-command-input.js';
import {
  runTestCaseListCommand,
  runTestCaseShowCommand,
  runTestDatasetRemovePreflight,
  runTestListCommand,
  runTestMutationCommand,
  runTestShowCommand,
  type TestAuthoringCommand,
} from './test-command.js';

type RegisterTestCommandsOptions = {
  interaction: CliInteraction;
  io: CliIo;
  program: Command;
  workingDirectory: string;
};

type CommonOptions = {
  nonInteractive?: boolean;
  output?: 'human' | 'json';
  project?: string;
};

type MutationOptions = CommonOptions & {
  dryRun?: boolean;
  fromJson?: string;
  ifProjectHash?: string;
  yes?: boolean;
};

type TestOptions = MutationOptions & {
  agent?: string;
  metric?: string[];
  name?: string;
};

type CaseOptions = MutationOptions & {
  expected?: string;
  format?: 'json' | 'jsonl';
  id?: string;
  input?: string;
  params?: string;
  tag?: string[];
};

type DatasetOptions = MutationOptions & {
  as?: string;
  format?: 'json' | 'jsonl';
  name?: string;
  tag?: string[];
};

const collect = (value: string, previous: string[] | undefined): string[] => [
  ...(previous ?? []),
  value,
];

const addCommonOptions = (command: Command): Command =>
  command
    .option('--project <dir>', 'explicit Attest project directory')
    .addOption(new Option('--output <format>', 'output format').choices(['human', 'json']))
    .option('--non-interactive', 'disable prompts and fail when required input is missing');

const addMutationOptions = (command: Command): Command =>
  addCommonOptions(command)
    .option('--dry-run', 'validate and show the semantic diff without writing')
    .option('--yes', 'accept destructive confirmation prompts')
    .option('--from-json <path|->', 'read one versioned command request from a file or stdin')
    .option('--if-project-hash <sha256>', 'fail if the project changed since it was read');

const outputFormat = (options: CommonOptions): 'human' | 'json' => options.output ?? 'human';

const isInteractive = (
  options: CommonOptions,
  interaction: CliInteraction,
  fromJson?: string,
): boolean =>
  options.nonInteractive !== true &&
  outputFormat(options) === 'human' &&
  fromJson === undefined &&
  !interaction.ci &&
  interaction.inputIsTTY &&
  interaction.outputIsTTY;

const requiredInput = async (
  value: string | undefined,
  path: string,
  question: string,
  interactive: boolean,
  interaction: CliInteraction,
): Promise<string> => {
  const existing = value?.trim();
  if (existing !== undefined && existing.length > 0) return existing;
  if (interactive) {
    const answer = (await interaction.prompt(question)).trim();
    if (answer.length > 0) return answer;
  }
  throw new AttestCliError('cli_missing_input', `Required input ${path} is missing.`, {
    path,
    hint: `Pass ${path} or provide it in a complete --from-json request.`,
  });
};

const assertUnambiguousRequestSource = (
  options: MutationOptions,
  fields: Readonly<Record<string, unknown>>,
): void => {
  if (options.fromJson === undefined) return;
  const conflicts = [
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name),
    ...(options.dryRun === undefined ? [] : ['dry-run']),
    ...(options.ifProjectHash === undefined ? [] : ['if-project-hash']),
    ...(options.yes === undefined ? [] : ['yes']),
  ].sort();
  if (conflicts.length === 0) return;
  throw new AttestCliError('cli_usage', 'Command request sources overlap.', {
    path: '--from-json',
    hint: 'Pass authored values through either CLI flags/arguments or --from-json, not both.',
    details: { conflicting_fields: conflicts },
  });
};

const requestFromSource = async <TCommand extends TestAuthoringCommand['command']>(
  command: TCommand,
  options: MutationOptions,
  fields: Readonly<Record<string, unknown>>,
  context: RegisterTestCommandsOptions,
  build: () => Promise<unknown>,
): Promise<Extract<TestAuthoringCommand, { command: TCommand }>> => {
  assertUnambiguousRequestSource(options, fields);
  if (options.fromJson !== undefined) {
    const request = await readCommandRequest(command, options.fromJson, {
      readStdin: context.interaction.readStdin,
      workingDirectory: context.workingDirectory,
    });
    if (
      options.fromJson === '-' &&
      'source' in request &&
      typeof request.source === 'string' &&
      request.source === '-'
    ) {
      throw new AttestCliError('cli_usage', 'One stdin stream cannot contain two inputs.', {
        path: '--from-json',
        hint: 'Put either the command request or native cases in a file.',
      });
    }
    return request;
  }
  return validateCommandRequest(command, await build());
};

const commonRequestFields = (command: string, options: MutationOptions) => ({
  schema: COMMAND_REQUEST_SCHEMA_VERSION,
  command,
  ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
  ...(options.yes === undefined ? {} : { yes: options.yes }),
  ...(options.ifProjectHash === undefined ? {} : { if_project_hash: options.ifProjectHash }),
});

const confirmRemoval = async (
  request: TestAuthoringCommand,
  label: string,
  options: MutationOptions,
  context: RegisterTestCommandsOptions,
): Promise<boolean> => {
  if (request.dry_run === true || request.yes === true || options.yes === true) return true;
  if (isInteractive(options, context.interaction, options.fromJson)) {
    const answer = (await context.interaction.prompt(`Remove ${label}? [y/N]: `))
      .trim()
      .toLowerCase();
    if (answer === 'y' || answer === 'yes') return true;
    context.io.output(`No changes made; ${label} was not removed.`);
    return false;
  }
  throw new AttestCliError('cli_missing_input', 'Destructive removal requires confirmation.', {
    path: '--yes',
    hint: 'Pass --yes or set `yes: true` in the command request.',
  });
};

const runMutation = async (
  command: TestAuthoringCommand['command'],
  request: TestAuthoringCommand,
  options: MutationOptions,
  context: RegisterTestCommandsOptions,
): Promise<void> => {
  const result = await runTestMutationCommand({
    project: options.project,
    readStdin: context.interaction.readStdin,
    request,
    workingDirectory: context.workingDirectory,
  });
  context.io.output(renderCommandResult(command, outputFormat(options), result));
};

const markMutationHelp = (command: Command, examples: string[]): void => {
  setCliCommandHelpMetadata(command, {
    examples,
    requestSchema: COMMAND_REQUEST_SCHEMA_VERSION,
    options: {
      output: { implies: ['non-interactive'] },
      'from-json': {
        conflicts: ['command arguments', 'command flags', 'dry-run', 'yes', 'if-project-hash'],
        implies: ['non-interactive'],
      },
    },
  });
};

/** Registers the exact CLI2.7 test, direct-case, and attached-dataset command surface. */
const registerTestCommands = (context: RegisterTestCommandsOptions): void => {
  const test = context.program.command('test').description('Author tests, cases, and datasets.');

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
            schema: TEST_RESOURCE_SCHEMA_VERSION,
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
  markMutationHelp(rename, ['attest test rename smoke smoke-v2 --dry-run']);

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

  const testCase = test.command('case').description('Author direct test cases.');
  const caseAdd = addMutationOptions(testCase.command('add').description('Add one direct case.'))
    .argument('[test-id]', 'test id')
    .option('--id <case-id>', 'case id; generated from logical content when omitted')
    .option('--input <json>', 'case input JSON')
    .option('--expected <json>', 'optional expected JSON')
    .option('--params <json>', 'optional params object JSON')
    .option('--tag <tag>', 'case tag', collect);
  caseAdd.action(async (testId: string | undefined, options: CaseOptions) => {
    const interactive = isInteractive(options, context.interaction, options.fromJson);
    const request = await requestFromSource(
      'test.case.add',
      options,
      {
        'test-id': testId,
        id: options.id,
        input: options.input,
        expected: options.expected,
        params: options.params,
        tag: options.tag,
      },
      context,
      async () => {
        const inputText = await requiredInput(
          options.input,
          '--input',
          'Case input JSON: ',
          interactive,
          context.interaction,
        );
        return {
          ...commonRequestFields('test.case.add', options),
          test_id: await requiredInput(
            testId,
            '<test-id>',
            'Test id: ',
            interactive,
            context.interaction,
          ),
          case: {
            ...(options.id === undefined ? {} : { id: options.id }),
            input: parseJsonFlag(inputText, '--input'),
            ...(options.expected === undefined
              ? {}
              : { expected: parseJsonFlag(options.expected, '--expected') }),
            ...(options.params === undefined
              ? {}
              : { params: parseJsonFlag(options.params, '--params') }),
            ...(options.tag === undefined ? {} : { tags: options.tag }),
          },
        };
      },
    );
    await runMutation('test.case.add', request, options, context);
  });
  markMutationHelp(caseAdd, ['attest test case add smoke --input \'{"question":"ping"}\'']);

  const caseImport = addMutationOptions(
    testCase.command('import').description('Import native JSON or JSONL direct cases.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[source]', 'native JSON/JSONL path or -')
    .addOption(
      new Option('--format <format>', 'stdin or explicit format').choices(['json', 'jsonl']),
    );
  caseImport.action(
    async (testId: string | undefined, source: string | undefined, options: CaseOptions) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await requestFromSource(
        'test.case.import',
        options,
        { 'test-id': testId, source, format: options.format },
        context,
        async () => ({
          ...commonRequestFields('test.case.import', options),
          test_id: await requiredInput(
            testId,
            '<test-id>',
            'Test id: ',
            interactive,
            context.interaction,
          ),
          source: await requiredInput(
            source,
            '<source>',
            'Native JSON/JSONL source: ',
            interactive,
            context.interaction,
          ),
          import: {
            ...(options.format === undefined ? {} : { format: options.format }),
          },
        }),
      );
      await runMutation('test.case.import', request, options, context);
    },
  );
  markMutationHelp(caseImport, [
    'attest test case import smoke ./cases.jsonl',
    'attest test case import smoke - --format jsonl --output json',
  ]);

  addCommonOptions(testCase.command('list').description('List direct cases.'))
    .argument('[test-id]', 'test id')
    .action(async (testId: string | undefined, options: CommonOptions) => {
      const id = await requiredInput(
        testId,
        '<test-id>',
        'Test id: ',
        isInteractive(options, context.interaction),
        context.interaction,
      );
      const result = await runTestCaseListCommand({
        project: options.project,
        testId: id,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('test.case.list', outputFormat(options), result));
    });

  addCommonOptions(testCase.command('show').description('Show one direct case.'))
    .argument('[test-id]', 'test id')
    .argument('[case-id]', 'direct case id')
    .action(
      async (testId: string | undefined, caseId: string | undefined, options: CommonOptions) => {
        const interactive = isInteractive(options, context.interaction);
        const resolvedTestId = await requiredInput(
          testId,
          '<test-id>',
          'Test id: ',
          interactive,
          context.interaction,
        );
        const resolvedCaseId = await requiredInput(
          caseId,
          '<case-id>',
          'Case id: ',
          interactive,
          context.interaction,
        );
        const result = await runTestCaseShowCommand({
          caseId: resolvedCaseId,
          project: options.project,
          testId: resolvedTestId,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult('test.case.show', outputFormat(options), result));
      },
    );

  for (const verb of ['rename', 'remove'] as const) {
    const command = addMutationOptions(
      testCase
        .command(verb)
        .description(`${verb === 'rename' ? 'Rename' : 'Remove'} a direct case.`),
    )
      .argument('[test-id]', 'test id')
      .argument('[case-id]', 'direct case id');
    if (verb === 'rename') command.argument('[new-id]', 'new direct case id');
    command.action(
      async (
        testId: string | undefined,
        caseId: string | undefined,
        newIdOrOptions: string | MutationOptions | undefined,
        maybeOptions?: MutationOptions,
      ) => {
        // Commander passes the options object immediately after the declared positional values.
        const options = (verb === 'rename' ? maybeOptions : newIdOrOptions) as MutationOptions;
        const newId = typeof newIdOrOptions === 'string' ? newIdOrOptions : undefined;
        const commandName = `test.case.${verb}` as const;
        const interactive = isInteractive(options, context.interaction, options.fromJson);
        const request = await requestFromSource(
          commandName,
          options,
          { 'test-id': testId, 'case-id': caseId, 'new-id': newId },
          context,
          async () => ({
            ...commonRequestFields(commandName, options),
            test_id: await requiredInput(
              testId,
              '<test-id>',
              'Test id: ',
              interactive,
              context.interaction,
            ),
            case_id: await requiredInput(
              caseId,
              '<case-id>',
              'Case id: ',
              interactive,
              context.interaction,
            ),
            ...(verb === 'rename'
              ? {
                  new_id: await requiredInput(
                    newId,
                    '<new-id>',
                    'New case id: ',
                    interactive,
                    context.interaction,
                  ),
                }
              : {}),
          }),
        );
        if (verb === 'remove') {
          if (!(await confirmRemoval(request, `case ${request.case_id}`, options, context))) return;
        }
        await runMutation(commandName, request, options, context);
      },
    );
    markMutationHelp(command, [
      verb === 'rename'
        ? 'attest test case rename smoke old-case new-case'
        : 'attest test case remove smoke old-case --yes',
    ]);
  }

  const dataset = test.command('dataset').description('Add, import, and attach datasets.');
  const datasetAdd = addMutationOptions(
    dataset.command('add').description('Add an empty dataset and attach it atomically.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[dataset-id]', 'new dataset id')
    .option('--name <name>', 'dataset display name');
  datasetAdd.action(
    async (testId: string | undefined, datasetId: string | undefined, options: DatasetOptions) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await requestFromSource(
        'test.dataset.add',
        options,
        { 'test-id': testId, 'dataset-id': datasetId, name: options.name },
        context,
        async () => {
          const id = await requiredInput(
            datasetId,
            '<dataset-id>',
            'Dataset id: ',
            interactive,
            context.interaction,
          );
          return {
            ...commonRequestFields('test.dataset.add', options),
            test_id: await requiredInput(
              testId,
              '<test-id>',
              'Test id: ',
              interactive,
              context.interaction,
            ),
            dataset: {
              schema: DATASET_SCHEMA_VERSION,
              case_schema: CASE_SCHEMA_VERSION,
              id,
              name: options.name?.trim() || id,
              case_count: 0,
            },
          };
        },
      );
      await runMutation('test.dataset.add', request, options, context);
    },
  );
  markMutationHelp(datasetAdd, ['attest test dataset add smoke regression']);

  const datasetImport = addMutationOptions(
    dataset.command('import').description('Import a native JSON/JSONL dataset and attach it.'),
  )
    .argument('[test-id]', 'test id')
    .argument('[source]', 'native JSON/JSONL path or -')
    .option('--as <dataset-id>', 'new dataset id')
    .option('--name <name>', 'dataset display name')
    .addOption(
      new Option('--format <format>', 'stdin or explicit format').choices(['json', 'jsonl']),
    );
  datasetImport.action(
    async (testId: string | undefined, source: string | undefined, options: DatasetOptions) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await requestFromSource(
        'test.dataset.import',
        options,
        {
          'test-id': testId,
          source,
          as: options.as,
          name: options.name,
          format: options.format,
        },
        context,
        async () => ({
          ...commonRequestFields('test.dataset.import', options),
          test_id: await requiredInput(
            testId,
            '<test-id>',
            'Test id: ',
            interactive,
            context.interaction,
          ),
          source: await requiredInput(
            source,
            '<source>',
            'Native JSON/JSONL source: ',
            interactive,
            context.interaction,
          ),
          as: await requiredInput(
            options.as,
            '--as',
            'Dataset id: ',
            interactive,
            context.interaction,
          ),
          ...(options.name === undefined ? {} : { name: options.name }),
          import: {
            ...(options.format === undefined ? {} : { format: options.format }),
          },
        }),
      );
      await runMutation('test.dataset.import', request, options, context);
    },
  );
  markMutationHelp(datasetImport, [
    'attest test dataset import smoke ./cases.jsonl --as regression',
  ]);

  for (const verb of ['attach', 'detach'] as const) {
    const command = addMutationOptions(
      dataset.command(verb).description(`${verb === 'attach' ? 'Attach' : 'Detach'} a dataset.`),
    )
      .argument('[test-id]', 'test id')
      .argument('[dataset-id]', 'dataset id');
    if (verb === 'attach') command.option('--tag <tag>', 'all-tags attachment filter', collect);
    command.action(
      async (
        testId: string | undefined,
        datasetId: string | undefined,
        options: DatasetOptions,
      ) => {
        const commandName = `test.dataset.${verb}` as const;
        const interactive = isInteractive(options, context.interaction, options.fromJson);
        const request = await requestFromSource(
          commandName,
          options,
          { 'test-id': testId, 'dataset-id': datasetId, tag: options.tag },
          context,
          async () => ({
            ...commonRequestFields(commandName, options),
            test_id: await requiredInput(
              testId,
              '<test-id>',
              'Test id: ',
              interactive,
              context.interaction,
            ),
            dataset_id: await requiredInput(
              datasetId,
              '<dataset-id>',
              'Dataset id: ',
              interactive,
              context.interaction,
            ),
            ...(verb === 'attach' && options.tag !== undefined ? { tags: options.tag } : {}),
          }),
        );
        await runMutation(commandName, request, options, context);
      },
    );
    markMutationHelp(command, [`attest test dataset ${verb} smoke regression`]);
  }

  const datasetRename = addMutationOptions(
    dataset.command('rename').description('Rename a dataset and every attachment atomically.'),
  )
    .argument('[dataset-id]', 'current dataset id')
    .argument('[new-id]', 'new dataset id');
  datasetRename.action(
    async (datasetId: string | undefined, newId: string | undefined, options: MutationOptions) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await requestFromSource(
        'test.dataset.rename',
        options,
        { 'dataset-id': datasetId, 'new-id': newId },
        context,
        async () => ({
          ...commonRequestFields('test.dataset.rename', options),
          dataset_id: await requiredInput(
            datasetId,
            '<dataset-id>',
            'Current dataset id: ',
            interactive,
            context.interaction,
          ),
          new_id: await requiredInput(
            newId,
            '<new-id>',
            'New dataset id: ',
            interactive,
            context.interaction,
          ),
        }),
      );
      await runMutation('test.dataset.rename', request, options, context);
    },
  );
  markMutationHelp(datasetRename, ['attest test dataset rename regression regression-v2']);

  const datasetRemove = addMutationOptions(
    dataset.command('remove').description('Remove an unattached dataset.'),
  ).argument('[dataset-id]', 'dataset id');
  datasetRemove.action(async (datasetId: string | undefined, options: MutationOptions) => {
    const request = await requestFromSource(
      'test.dataset.remove',
      options,
      { 'dataset-id': datasetId },
      context,
      async () => ({
        ...commonRequestFields('test.dataset.remove', options),
        dataset_id: await requiredInput(
          datasetId,
          '<dataset-id>',
          'Dataset id: ',
          isInteractive(options, context.interaction, options.fromJson),
          context.interaction,
        ),
      }),
    );
    if (request.dry_run !== true) {
      await runTestDatasetRemovePreflight({
        datasetId: request.dataset_id,
        project: options.project,
        workingDirectory: context.workingDirectory,
      });
    }
    if (!(await confirmRemoval(request, `dataset ${request.dataset_id}`, options, context))) return;
    await runMutation('test.dataset.remove', request, options, context);
  });
  markMutationHelp(datasetRemove, ['attest test dataset remove regression --yes']);

  setCliCommandHelpMetadata(test, {
    examples: [
      'attest test add smoke --agent support',
      'attest test case add smoke --input \'{"question":"ping"}\'',
      'attest test dataset import smoke ./cases.jsonl --as regression',
    ],
  });
};

export { registerTestCommands, type RegisterTestCommandsOptions };
