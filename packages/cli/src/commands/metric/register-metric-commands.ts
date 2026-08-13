import {
  COMMAND_REQUEST_SCHEMA_ID,
  METRIC_PRESETS,
  type MetricPreset,
  type MetricPresetId,
} from '@attest/contracts';
import { Command, Option } from 'commander';

import { AttestCliError } from '../../errors/index.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import type { CliIo } from '../../run-cli.js';
import { renderCommandResult } from '../shared/command-result.js';
import {
  addCommonOptions,
  addMutationOptions,
  collectOption as collect,
  isInteractive,
  mergeCommonOptions,
  outputFormat,
  type CommonCliOptions as CommonOptions,
  type MutationCliOptions as MutationOptions,
} from '../shared/cli-options.js';
import { loadCommandProject } from '../project/load-command-project.js';
import type { CliInteraction } from '../shared/cli-interaction.js';
import {
  createMetricResource,
  readMetricCommandRequest,
  validateMetricCommandRequest,
  type MetricAddFields,
} from './metric-command-input.js';
import {
  runMetricMutationCommand,
  runMetricTestCommand,
  type MetricAuthoringRequest,
} from './metric-command.js';

type RegisterMetricCommandsOptions = {
  interaction: CliInteraction;
  io: CliIo;
  program: Command;
  workingDirectory: string;
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
  schema: COMMAND_REQUEST_SCHEMA_ID,
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

const ASSERTION_EVIDENCE = ['input', 'output', 'expected', 'trace'] as const;
const VALUE_OPERATORS = [
  'equals',
  'contains',
  'json-schema',
  'regex',
  'exists',
  'lt',
  'lte',
  'gt',
  'gte',
] as const;
const TRACE_OPERATORS = ['tool-called', 'tool-order', 'no-tool-errors', 'span'] as const;

/** Reads one guided choice without silently accepting an unrecognized value. */
const guidedChoice = async <Choice extends string>(
  question: string,
  choices: readonly Choice[],
  defaultChoice: Choice,
  path: string,
  context: RegisterMetricCommandsOptions,
): Promise<Choice> => {
  const answer = (await context.interaction.prompt(question)).trim() || defaultChoice;
  if (choices.includes(answer as Choice)) return answer as Choice;
  throw new AttestCliError('cli_usage', `Unknown guided metric choice for ${path}.`, {
    path,
    hint: `Choose one of: ${choices.join(', ')}.`,
  });
};

/** Describes the selected project's trace capability without blocking pre-trace authoring. */
const guidedTraceCapability = async (
  options: AddOptions,
  context: RegisterMetricCommandsOptions,
): Promise<string> => {
  const loaded = await loadCommandProject({
    project: options.project,
    recover: options.dryRun !== true,
    workingDirectory: context.workingDirectory,
  });
  if (loaded.agents.length === 0) {
    return 'No authored agent is available to verify trace support. Creation remains available before trace evidence exists.';
  }
  const catalog = loaded.agents
    .map(
      (agent) =>
        `  ${agent.id}: ${agent.capabilities?.trace === true ? 'advertises trace support' : 'does not advertise trace support'}`,
    )
    .join('\n');
  const defaultAgent = loaded.agents[0]!.id;
  const selectedId =
    (
      await context.interaction.prompt(
        `Agent trace capabilities:\n${catalog}\nAgent for capability guidance [${defaultAgent}]: `,
      )
    ).trim() || defaultAgent;
  const selected = loaded.agents.find(({ id }) => id === selectedId);
  if (selected === undefined) {
    throw new AttestCliError('cli_usage', 'Unknown agent selected for trace guidance.', {
      path: '<agent-id>',
      hint: `Choose one of: ${loaded.agents.map(({ id }) => id).join(', ')}.`,
    });
  }
  return `Agent ${selected.id} ${
    selected.capabilities?.trace === true
      ? 'advertises trace support'
      : 'does not advertise trace support'
  }. Creation remains available before trace evidence exists.`;
};

/** Collects metric kind, assertion evidence, and operator before any operator value. */
const guidedMetricFields = async (
  options: AddOptions,
  interactive: boolean,
  context: RegisterMetricCommandsOptions,
): Promise<AddOptions> => {
  if (options.preset !== undefined) return options;
  const hasDirectAssertion =
    options.assertJson !== undefined ||
    options.path !== undefined ||
    options.pattern !== undefined ||
    [options.lt, options.lte, options.gt, options.gte].some((value) => value !== undefined);
  if (!interactive || hasDirectAssertion) return options;
  const catalog = METRIC_PRESETS.map((preset, index) => {
    const required =
      preset.required_inputs.length === 0 ? 'none' : preset.required_inputs.join(', ');
    const configurable =
      preset.configurable_fields.length === 0 ? 'none' : preset.configurable_fields.join(', ');
    return `  ${preset.id}${index === 0 ? ' (default)' : ''}: ${preset.description}\n    required: ${required}; configurable: ${configurable}`;
  }).join('\n');
  const kind = await guidedChoice(
    `Metric catalog (${METRIC_PRESETS[0]?.schema ?? 'unknown'}):\n${catalog}\nMetric kind [assertion] (assertion|judge|command|http): `,
    ['assertion', 'judge', 'command', 'http'] as const,
    'assertion',
    'kind',
    context,
  );
  if (kind !== 'assertion') {
    const presetByKind = {
      judge: 'judge-rubric',
      command: 'command',
      http: 'http',
    } as const;
    return { ...options, preset: presetByKind[kind] };
  }

  const evidence = await guidedChoice(
    'Assertion evidence [output] (input|output|expected|trace): ',
    ASSERTION_EVIDENCE,
    'output',
    'evidence',
    context,
  );
  if (evidence === 'trace') {
    const capability = await guidedTraceCapability(options, context);
    const operator = await guidedChoice(
      `${capability}\nTrace operator [tool-called] (tool-called|tool-order|no-tool-errors|span): `,
      TRACE_OPERATORS,
      'tool-called',
      'operator',
      context,
    );
    const presetByOperator: Record<(typeof TRACE_OPERATORS)[number], MetricPresetId> = {
      'tool-called': 'tool-called',
      'tool-order': 'tool-order',
      'no-tool-errors': 'no-tool-errors',
      span: 'trace-span',
    };
    return { ...options, preset: presetByOperator[operator] };
  }

  const operator = await guidedChoice(
    `Assertion operator for $.${evidence} [equals] (${VALUE_OPERATORS.join('|')}): `,
    VALUE_OPERATORS,
    'equals',
    'operator',
    context,
  );
  const guided: AddOptions = { ...options, path: `$.${evidence}` };
  if (operator === 'equals') return { ...guided, preset: 'output-equals' };
  if (operator === 'contains') return { ...guided, preset: 'output-contains' };
  if (operator === 'json-schema') return { ...guided, preset: 'output-schema' };
  if (operator === 'exists') return guided;
  if (operator === 'regex') {
    return {
      ...guided,
      pattern: await requiredInput(
        undefined,
        '--pattern',
        `Assertion preview: evidence=$.${evidence}; operator=regex.\nRegular expression: `,
        true,
        context,
      ),
    };
  }
  return {
    ...guided,
    [operator]: await requiredInput(
      undefined,
      `--${operator}`,
      `Assertion preview: evidence=$.${evidence}; operator=${operator}.\nNumeric threshold: `,
      true,
      context,
    ),
  };
};

/** Fills only missing operator values; every answer enters the same flag-built resource. */
const guidedAddFields = async (
  options: AddOptions,
  preset: MetricPresetId | undefined,
  interactive: boolean,
  context: RegisterMetricCommandsOptions,
): Promise<AddOptions> => {
  if (!interactive || preset === undefined) return { ...options, preset };
  const guided: AddOptions = { ...options, preset };
  if ((preset === 'output-equals' || preset === 'output-contains') && guided.value === undefined) {
    guided.value = await requiredInput(
      undefined,
      '--value',
      `Assertion preview: evidence=${guided.path ?? '$.output'}; operator=${preset === 'output-equals' ? 'equals' : 'contains'}.\nJSON value: `,
      true,
      context,
    );
  } else if (
    preset === 'output-schema' &&
    guided.jsonSchema === undefined &&
    guided.jsonSchemaFile === undefined
  ) {
    guided.jsonSchema = await requiredInput(
      undefined,
      '--json-schema',
      `Assertion preview: evidence=${guided.path ?? '$.output'}; operator=json-schema.\nJSON Schema: `,
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
    guided.tool = await requiredInput(
      guided.tool,
      '--tool',
      'Assertion preview: evidence=trace; operator=tool-called.\nTool name: ',
      true,
      context,
    );
  } else if (preset === 'tool-order' && (guided.order === undefined || guided.order.length === 0)) {
    const order = await requiredInput(
      undefined,
      '--order',
      'Assertion preview: evidence=trace; operator=tool-order.\nTool names in order (comma-separated): ',
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
    guided.spanKind =
      (
        await context.interaction.prompt(
          'Assertion preview: evidence=trace; operator=span.\nSpan kind [other]: ',
        )
      ).trim() || 'other';
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
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
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

/** Registers metric CRUD, local fixture tests, and redacted inspection commands. */
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
        const selected = await guidedMetricFields(options, interactive, context);
        const guided = await guidedAddFields(selected, selected.preset, interactive, context);
        const resource = await createMetricResource({
          ...guided,
          metricId: id,
          preset: guided.preset,
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

  const testCommand = addCommonOptions(
    metric.command('test').description('Test one metric against a local fixture.'),
  )
    .argument('[metric-id]', 'metric id')
    .option('--fixture <path|->', 'strict local metric-test fixture')
    .option('--from-json <path|->', 'read one metric.test request')
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
              schema: COMMAND_REQUEST_SCHEMA_ID,
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
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
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
      'attest list metrics --output json',
      'attest show metric correct --output json',
    ],
  });
};

export { registerMetricCommands, type RegisterMetricCommandsOptions };
