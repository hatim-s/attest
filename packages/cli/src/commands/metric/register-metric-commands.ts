import {
  COMMAND_REQUEST_SCHEMA_VERSION,
  METRIC_PRESETS,
  type MetricPreset,
  type MetricPresetId,
} from '@attest/contracts';
import { Command, Option } from 'commander';

import { AttestCliError } from '../../errors.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import type { CliIo } from '../../run-cli.js';
import { renderCommandResult } from '../command-result.js';
import type { CliInteraction } from '../register-project-resource-commands.js';
import {
  createMetricResource,
  readMetricCommandRequest,
  validateMetricCommandRequest,
  type MetricAddFields,
} from './metric-command-input.js';
import {
  runMetricListCommand,
  runMetricMutationCommand,
  runMetricShowCommand,
  runMetricTestCommand,
  type MetricAuthoringRequest,
} from './metric-command.js';

type RegisterMetricCommandsOptions = {
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

type AddOptions = MutationOptions &
  Omit<MetricAddFields, 'metricId' | 'readStdin' | 'workingDirectory'>;
type ImportOptions = MutationOptions & { as?: string; name?: string; type?: 'json' };
type RemoveOptions = MutationOptions & { detach?: boolean };
type TestOptions = CommonOptions & { fixture?: string; fromJson?: string };

const PRESET_IDS = METRIC_PRESETS.map(({ id }) => id);
const REPEATABLE_METRIC_FIELDS = new Set([
  'arg-contains',
  'arg-equals',
  'arg-exists',
  'assert-json',
  'attribute',
  'env',
  'header-env',
  'order',
  'query-env',
]);

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
    .option('--yes', 'accept confirmation prompts without inventing missing values')
    .option('--from-json <path|->', 'read one versioned command request from a file or stdin')
    .option('--if-project-hash <sha256>', 'fail if the project changed since it was read');

/** Merges root-position common options while rejecting duplicate local ownership. */
const mergeCommonOptions = <Options extends CommonOptions>(
  options: Options,
  command: Command,
  program: Command,
): Options => {
  const root = program.opts<CommonOptions>();
  for (const name of ['project', 'output', 'nonInteractive'] as const) {
    if (
      program.getOptionValueSource(name) === 'cli' &&
      command.getOptionValueSource(name) === 'cli'
    ) {
      const flag = name === 'nonInteractive' ? 'non-interactive' : name;
      throw new AttestCliError('cli_usage', `Common option --${flag} was provided twice.`, {
        path: `--${flag}`,
      });
    }
  }
  return { ...root, ...options };
};

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
  context: RegisterMetricCommandsOptions,
): Promise<string> => {
  if (value?.trim()) return value.trim();
  if (interactive) {
    const answer = (await context.interaction.prompt(question)).trim();
    if (answer.length > 0) return answer;
  }
  throw new AttestCliError('cli_missing_input', `Required metric input ${path} is missing.`, {
    path,
    hint: `Pass ${path} or provide it in a complete --from-json request.`,
  });
};

const mutationFields = (command: string, options: MutationOptions) => ({
  schema: COMMAND_REQUEST_SCHEMA_VERSION,
  command,
  ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
  ...(options.yes === undefined ? {} : { yes: options.yes }),
  ...(options.ifProjectHash === undefined ? {} : { if_project_hash: options.ifProjectHash }),
});

const assertNoFromJsonFields = (
  options: MutationOptions,
  fields: Readonly<Record<string, unknown>>,
): void => {
  if (options.fromJson === undefined) return;
  const conflicts = [
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== false)
      .map(([name]) => name),
    ...(options.dryRun === undefined ? [] : ['dry-run']),
    ...(options.ifProjectHash === undefined ? [] : ['if-project-hash']),
    ...(options.yes === undefined ? [] : ['yes']),
  ].sort();
  if (conflicts.length === 0) return;
  throw new AttestCliError('cli_usage', 'Metric command request sources overlap.', {
    path: '--from-json',
    hint: 'Pass authored values through either flags/arguments or --from-json, not both.',
    details: { conflicting_fields: conflicts },
  });
};

const readOrBuildMutation = async <TCommand extends MetricAuthoringRequest['command']>(
  command: TCommand,
  options: MutationOptions,
  context: RegisterMetricCommandsOptions,
  build: () => Promise<unknown>,
): Promise<Extract<MetricAuthoringRequest, { command: TCommand }>> => {
  if (options.fromJson !== undefined) {
    const request = (await readMetricCommandRequest(
      command,
      options.fromJson,
      context.workingDirectory,
      context.interaction.readStdin,
    )) as MetricAuthoringRequest;
    if (options.fromJson === '-' && request.command === 'metric.import' && request.source === '-') {
      throw new AttestCliError('cli_usage', 'One stdin stream cannot contain two metric inputs.', {
        path: '--from-json',
        hint: 'Put either the command request or imported metric resource in a file.',
      });
    }
    return request as Extract<MetricAuthoringRequest, { command: TCommand }>;
  }
  return validateMetricCommandRequest(command, await build());
};

const guidedPreset = async (
  options: AddOptions,
  interactive: boolean,
  context: RegisterMetricCommandsOptions,
): Promise<MetricPresetId | undefined> => {
  if (options.preset !== undefined) return options.preset;
  const hasDirectAssertion =
    options.assertJson !== undefined ||
    options.path !== undefined ||
    options.pattern !== undefined ||
    [options.lt, options.lte, options.gt, options.gte].some((value) => value !== undefined);
  if (!interactive || hasDirectAssertion) return undefined;
  const catalog = METRIC_PRESETS.map((preset, index) => {
    const required =
      preset.required_inputs.length === 0 ? 'none' : preset.required_inputs.join(', ');
    const configurable =
      preset.configurable_fields.length === 0 ? 'none' : preset.configurable_fields.join(', ');
    return `  ${preset.id}${index === 0 ? ' (default)' : ''}: ${preset.description}\n    required: ${required}; configurable: ${configurable}`;
  }).join('\n');
  const answer = (
    await context.interaction.prompt(
      `Preset catalog (${METRIC_PRESETS[0]?.schema ?? 'unknown'}):\n${catalog}\nPreset [${PRESET_IDS[0]}]: `,
    )
  ).trim();
  if (answer.length === 0) return PRESET_IDS[0];
  if (PRESET_IDS.includes(answer as MetricPresetId)) return answer as MetricPresetId;
  throw new AttestCliError('cli_usage', 'Unknown metric preset.', {
    path: '--preset',
    hint: `Choose one of: ${PRESET_IDS.join(', ')}.`,
  });
};

/** Fills only missing required preset inputs; every answer enters the same flag-built resource. */
const guidedAddFields = async (
  options: AddOptions,
  preset: MetricPresetId | undefined,
  interactive: boolean,
  context: RegisterMetricCommandsOptions,
): Promise<AddOptions> => {
  if (!interactive || preset === undefined) return { ...options, preset };
  const guided: AddOptions = { ...options, preset };
  if ((preset === 'output-equals' || preset === 'output-contains') && guided.value === undefined) {
    guided.value = await requiredInput(undefined, '--value', 'JSON value: ', true, context);
  } else if (
    preset === 'output-schema' &&
    guided.jsonSchema === undefined &&
    guided.jsonSchemaFile === undefined
  ) {
    guided.jsonSchema = await requiredInput(
      undefined,
      '--json-schema',
      'JSON Schema: ',
      true,
      context,
    );
  } else if (preset === 'judge-rubric') {
    guided.model = await requiredInput(guided.model, '--model', 'Provider/model: ', true, context);
    if (guided.rubric === undefined && guided.rubricFile === undefined) {
      guided.rubric = await requiredInput(undefined, '--rubric', 'Rubric: ', true, context);
    }
  } else if (preset === 'command') {
    guided.argvJson = await requiredInput(
      guided.argvJson,
      '--argv-json',
      'Metric argv JSON: ',
      true,
      context,
    );
  } else if (preset === 'http') {
    guided.url = await requiredInput(guided.url, '--url', 'Metric URL: ', true, context);
  } else if (preset === 'tool-called') {
    guided.tool = await requiredInput(guided.tool, '--tool', 'Tool name: ', true, context);
  } else if (preset === 'tool-order' && (guided.order === undefined || guided.order.length === 0)) {
    const order = await requiredInput(
      undefined,
      '--order',
      'Tool names in order (comma-separated): ',
      true,
      context,
    );
    guided.order = order
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  } else if (
    preset === 'trace-span' &&
    guided.spanKind === undefined &&
    guided.spanName === undefined &&
    guided.spanStatus === undefined &&
    guided.attribute === undefined
  ) {
    guided.spanKind = (await context.interaction.prompt('Span kind [other]: ')).trim() || 'other';
  }
  return guided;
};

const runMutation = async (
  request: MetricAuthoringRequest,
  options: MutationOptions,
  interactive: boolean,
  context: RegisterMetricCommandsOptions,
): Promise<void> => {
  const result = await runMetricMutationCommand({
    interactive,
    project: options.project,
    prompt: context.interaction.prompt,
    readStdin: context.interaction.readStdin,
    request,
    workingDirectory: context.workingDirectory,
  });
  context.io.output(renderCommandResult(request.command, outputFormat(options), result));
};

const markMutationHelp = (
  command: Command,
  examples: string[],
  fields: string[],
  presets?: readonly MetricPreset[],
): void => {
  setCliCommandHelpMetadata(command, {
    examples,
    ...(presets === undefined ? {} : { presets }),
    requestSchema: COMMAND_REQUEST_SCHEMA_VERSION,
    options: {
      output: { implies: ['non-interactive'] },
      'from-json': {
        conflicts: ['dry-run', 'yes', 'if-project-hash', ...fields],
        implies: ['non-interactive'],
      },
      ...Object.fromEntries(
        fields.map((field) => [
          field,
          {
            conflicts: ['from-json'],
            ...(REPEATABLE_METRIC_FIELDS.has(field) ? { repeatable: true } : {}),
          },
        ]),
      ),
    },
  });
};

/** Registers CLI2.9 metric CRUD, local fixture tests, and redacted inspection commands. */
const registerMetricCommands = (context: RegisterMetricCommandsOptions): void => {
  const metric = context.program.command('metric').description('Author and test metric resources.');

  const add = addMutationOptions(
    metric.command('add').description('Add one assertion, judge, executable, or HTTP metric.'),
  )
    .argument('[metric-id]', 'metric id')
    .option('--name <name>', 'metric display name; defaults to the id')
    .addOption(new Option('--preset <preset>', 'stable metric preset').choices(PRESET_IDS))
    .option('--assert-json <json>', 'complete assertion check; repeatable', collect)
    .option('--path <path>', 'assertion evidence path; alone authors exists')
    .option('--value <json>', 'equals or contains JSON value')
    .option('--pattern <regex>', 'regular-expression assertion pattern')
    .option('--flags <flags>', 'regular-expression flags')
    .option('--json-schema <json>', 'Draft 2020-12 JSON Schema')
    .option('--json-schema-file <path|->', 'read JSON Schema from a file or stdin')
    .option('--lt <number>', 'numeric less-than assertion')
    .option('--lte <number>', 'numeric less-than-or-equal assertion')
    .option('--gt <number>', 'numeric greater-than assertion')
    .option('--gte <number>', 'numeric greater-than-or-equal assertion')
    .option('--tool <name>', 'tool name for tool-called')
    .addOption(new Option('--tool-status <status>', 'tool status').choices(['ok', 'error']))
    .option('--count <integer>', 'tool-call or span count')
    .option('--order <name>', 'tool or span name in chronological order; repeatable', collect)
    .option('--arg-equals <path=json>', 'tool argument equals matcher; repeatable', collect)
    .option('--arg-contains <path=json>', 'tool argument contains matcher; repeatable', collect)
    .option('--arg-exists <path>', 'tool argument exists matcher; repeatable', collect)
    .addOption(
      new Option('--span-kind <kind>', 'trace span kind').choices([
        'agent',
        'llm',
        'tool',
        'retrieval',
        'other',
      ]),
    )
    .option('--span-name <name>', 'trace span name')
    .addOption(new Option('--span-status <status>', 'trace span status').choices(['ok', 'error']))
    .option('--attribute <name=json>', 'trace span attribute matcher; repeatable', collect)
    .option('--model <provider/model>', 'judge provider/model identifier')
    .option('--rubric <text>', 'literal judge rubric')
    .option('--rubric-file <path|->', 'read judge rubric from a file or stdin')
    .option('--threshold <number>', 'judge pass threshold; defaults to 0.8')
    .option('--argv-json <json>', 'trusted executable argv JSON array')
    .option('--cwd <path>', 'project-relative executable working directory')
    .option('--env <target=source-env>', 'executable environment secret reference', collect)
    .option('--timeout <duration>', 'executable or HTTP timeout such as 30s')
    .option('--url <url>', 'HTTP metric URL')
    .addOption(
      new Option('--http-method <method>', 'HTTP metric method').choices([
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
      ]),
    )
    .option('--header-env <header=source-env>', 'HTTP header secret reference', collect)
    .option('--query-env <name=source-env>', 'HTTP query secret reference', collect)
    .option('--body-json <json>', 'HTTP metric request body')
    .option('--score-pointer <pointer>', 'HTTP result score pointer; defaults to /score')
    .option('--pass-pointer <pointer>', 'HTTP result pass pointer; defaults to /pass')
    .option('--rationale-pointer <pointer>', 'HTTP result rationale pointer')
    .option('--details-pointer <pointer>', 'HTTP result details pointer')
    .action(async (metricId: string | undefined, raw: AddOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      const directFields: Record<string, unknown> = { ...options, 'metric-id': metricId };
      for (const field of [
        'dryRun',
        'fromJson',
        'ifProjectHash',
        'nonInteractive',
        'output',
        'project',
        'yes',
      ]) {
        Reflect.deleteProperty(directFields, field);
      }
      assertNoFromJsonFields(options, directFields);
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await readOrBuildMutation('metric.add', options, context, async () => {
        const id = await requiredInput(
          metricId,
          '<metric-id>',
          'Metric id: ',
          interactive,
          context,
        );
        const preset = await guidedPreset(options, interactive, context);
        const guided = await guidedAddFields(options, preset, interactive, context);
        const resource = await createMetricResource({
          ...guided,
          metricId: id,
          preset,
          readStdin: context.interaction.readStdin,
          workingDirectory: context.workingDirectory,
        });
        return { ...mutationFields('metric.add', options), metric: resource };
      });
      await runMutation(request, options, interactive, context);
    });
  const addFields = [
    'metric-id',
    'name',
    'preset',
    'assert-json',
    'path',
    'value',
    'pattern',
    'flags',
    'json-schema',
    'json-schema-file',
    'lt',
    'lte',
    'gt',
    'gte',
    'tool',
    'tool-status',
    'count',
    'order',
    'arg-equals',
    'arg-contains',
    'arg-exists',
    'span-kind',
    'span-name',
    'span-status',
    'attribute',
    'model',
    'rubric',
    'rubric-file',
    'threshold',
    'argv-json',
    'cwd',
    'env',
    'timeout',
    'url',
    'http-method',
    'header-env',
    'query-env',
    'body-json',
    'score-pointer',
    'pass-pointer',
    'rationale-pointer',
    'details-pointer',
  ];
  markMutationHelp(
    add,
    [
      'attest metric add exact --preset output-equals --value \'"Paris"\'',
      'attest metric add safe --assert-json \'{"not":{"tool_calls":{"status":"error"}}}\'',
      'attest metric add --from-json ./metric-add.json --output json',
    ],
    addFields,
    METRIC_PRESETS,
  );

  const importCommand = addMutationOptions(
    metric.command('import').description('Import one canonical JSON metric from a file or stdin.'),
  )
    .argument('[path|-]', 'canonical metric resource or metric.add request')
    .option('--as <metric-id>', 'imported metric id')
    .addOption(new Option('--type <type>', 'import type').choices(['json']))
    .option('--name <name>', 'override the imported display name')
    .action(async (source: string | undefined, raw: ImportOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      assertNoFromJsonFields(options, {
        as: options.as,
        name: options.name,
        path: source,
        type: options.type,
      });
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await readOrBuildMutation('metric.import', options, context, async () => ({
        ...mutationFields('metric.import', options),
        source: await requiredInput(
          source,
          '<path|->',
          'Metric JSON path or -: ',
          interactive,
          context,
        ),
        source_type: 'json',
        as: await requiredInput(options.as, '--as', 'Imported metric id: ', interactive, context),
        ...(options.name === undefined ? {} : { name: options.name }),
      }));
      await runMutation(request, options, interactive, context);
    });
  markMutationHelp(
    importCommand,
    [
      'attest metric import ./metric.json --type json --as correct',
      'attest metric import - --type json --as correct',
      'attest metric import --from-json ./metric-import.json --output json',
    ],
    ['path', 'as', 'type', 'name'],
  );

  const listCompatibility = addCommonOptions(
    metric.command('list').description('Compatibility alias for `attest list metrics`.'),
  ).action(async (raw: CommonOptions, command: Command) => {
    const options = mergeCommonOptions(raw, command, context.program);
    const result = await runMetricListCommand({
      project: options.project,
      workingDirectory: context.workingDirectory,
    });
    context.io.output(renderCommandResult('list', outputFormat(options), result));
  });
  setCliCommandHelpMetadata(listCompatibility, {
    aliasFor: 'list',
    deprecated: 'Use `attest list metrics`; this compatibility path has the same result identity.',
    examples: ['attest list metrics --output json'],
  });

  const showCompatibility = addCommonOptions(
    metric.command('show').description('Compatibility alias for `attest show metric <id>`.'),
  )
    .argument('[metric-id]', 'metric id')
    .action(async (metricId: string | undefined, raw: CommonOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      const interactive = isInteractive(options, context.interaction);
      const id = await requiredInput(metricId, '<metric-id>', 'Metric id: ', interactive, context);
      const result = await runMetricShowCommand({
        metricId: id,
        project: options.project,
        workingDirectory: context.workingDirectory,
      });
      context.io.output(renderCommandResult('show', outputFormat(options), result));
    });
  setCliCommandHelpMetadata(showCompatibility, {
    aliasFor: 'show',
    deprecated:
      'Use `attest show metric <id>`; this compatibility path has the same result identity.',
    examples: ['attest show metric exact --output json'],
  });

  const testCommand = addCommonOptions(
    metric.command('test').description('Test one metric against a local fixture.'),
  )
    .argument('[metric-id]', 'metric id')
    .option('--fixture <path|->', 'strict local metric-test fixture')
    .option('--from-json <path|->', 'read one versioned metric.test request')
    .action(async (metricId: string | undefined, raw: TestOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      if (
        options.fromJson !== undefined &&
        (metricId !== undefined || options.fixture !== undefined)
      ) {
        throw new AttestCliError('cli_usage', 'Metric test input sources overlap.', {
          path: '--from-json',
        });
      }
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request =
        options.fromJson === undefined
          ? validateMetricCommandRequest('metric.test', {
              schema: COMMAND_REQUEST_SCHEMA_VERSION,
              command: 'metric.test',
              metric_id: await requiredInput(
                metricId,
                '<metric-id>',
                'Metric id: ',
                interactive,
                context,
              ),
              fixture: await requiredInput(
                options.fixture,
                '--fixture',
                'Fixture path or -: ',
                interactive,
                context,
              ),
            })
          : await readMetricCommandRequest(
              'metric.test',
              options.fromJson,
              context.workingDirectory,
              context.interaction.readStdin,
            );
      if (options.fromJson === '-' && request.fixture === '-') {
        throw new AttestCliError(
          'cli_usage',
          'One stdin stream cannot contain two metric inputs.',
          {
            path: '--from-json',
          },
        );
      }
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const result = await runMetricTestCommand({
          fixture: request.fixture,
          metricId: request.metric_id,
          project: options.project,
          readStdin: context.interaction.readStdin,
          signal: controller.signal,
          workingDirectory: context.workingDirectory,
        });
        context.io.output(renderCommandResult('metric.test', outputFormat(options), result));
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
      }
    });
  setCliCommandHelpMetadata(testCommand, {
    examples: [
      'attest metric test exact --fixture ./fixtures/case-result.json --output json',
      'attest metric test exact --fixture - --output json',
      'attest metric test --from-json ./metric-test.json --output json',
    ],
    requestSchema: COMMAND_REQUEST_SCHEMA_VERSION,
    options: {
      output: { implies: ['non-interactive'] },
      fixture: { conflicts: ['from-json'] },
      'from-json': { conflicts: ['metric-id', 'fixture'], implies: ['non-interactive'] },
    },
  });

  const rename = addMutationOptions(
    metric.command('rename').description('Rename metric references atomically.'),
  )
    .argument('[metric-id]', 'current metric id')
    .argument('[new-id]', 'new metric id')
    .action(
      async (
        metricId: string | undefined,
        newId: string | undefined,
        raw: MutationOptions,
        command: Command,
      ) => {
        const options = mergeCommonOptions(raw, command, context.program);
        assertNoFromJsonFields(options, { 'metric-id': metricId, 'new-id': newId });
        const interactive = isInteractive(options, context.interaction, options.fromJson);
        const request = await readOrBuildMutation('metric.rename', options, context, async () => ({
          ...mutationFields('metric.rename', options),
          metric_id: await requiredInput(
            metricId,
            '<metric-id>',
            'Metric id: ',
            interactive,
            context,
          ),
          new_id: await requiredInput(newId, '<new-id>', 'New metric id: ', interactive, context),
        }));
        await runMutation(request, options, interactive, context);
      },
    );
  markMutationHelp(rename, ['attest metric rename correct correctness'], ['metric-id', 'new-id']);

  const remove = addMutationOptions(
    metric.command('remove').description('Remove one metric resource.'),
  )
    .argument('[metric-id]', 'metric id')
    .option('--detach', 'remove every test and case reference atomically')
    .action(async (metricId: string | undefined, raw: RemoveOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      assertNoFromJsonFields(options, { 'metric-id': metricId, detach: options.detach });
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await readOrBuildMutation('metric.remove', options, context, async () => ({
        ...mutationFields('metric.remove', options),
        metric_id: await requiredInput(
          metricId,
          '<metric-id>',
          'Metric id: ',
          interactive,
          context,
        ),
        ...(options.detach === undefined ? {} : { detach: options.detach }),
      }));
      await runMutation(request, options, interactive, context);
    });
  markMutationHelp(remove, ['attest metric remove correct --dry-run'], ['metric-id', 'detach']);

  setCliCommandHelpMetadata(metric, {
    examples: [
      'attest metric add correct --preset output-equals --value \'"Paris"\'',
      'attest metric test correct --fixture ./fixtures/result.json',
      'attest metric list --output json',
    ],
  });
};

export { registerMetricCommands, type RegisterMetricCommandsOptions };
