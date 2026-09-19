import { METRIC_PRESETS } from '@attest/contracts';
import { createMetricResource } from '@attest/local/metric';
import { Option, type Command } from 'commander';

import {
  addMutationOptions,
  collectOption as collect,
  isInteractive,
  mergeCommonOptions,
} from '../shared/cli-options.js';
import { fillGuidedMetricFields, selectGuidedMetricFields } from './guided-metric-add.js';
import {
  assertNoMetricRequestOverlap,
  markMetricMutationHelp,
  metricMutationFields,
  readOrBuildMetricMutation,
  requiredMetricInput,
  runMetricMutation,
  type MetricAddOptions,
  type RegisterMetricCommandsOptions,
} from './registration-support.js';

const PRESET_IDS = METRIC_PRESETS.map(({ id }) => id);
const ADD_FIELDS = [
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

/** Registers assertion, judge, executable, and HTTP metric authoring. */
const registerMetricAddCommand = (
  metric: Command,
  context: RegisterMetricCommandsOptions,
): void => {
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
    .action(async (metricId: string | undefined, raw: MetricAddOptions, command: Command) => {
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
      assertNoMetricRequestOverlap(options, directFields);
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await readOrBuildMetricMutation('metric.add', options, context, async () => {
        const id = await requiredMetricInput(
          metricId,
          '<metric-id>',
          'Metric id: ',
          interactive,
          context,
        );
        const selected = await selectGuidedMetricFields(options, interactive, context);
        const guided = await fillGuidedMetricFields(
          selected,
          selected.preset,
          interactive,
          context,
        );
        const resource = await createMetricResource({
          ...guided,
          metricId: id,
          preset: guided.preset,
          readStdin: context.interaction.readStdin,
          workingDirectory: context.workingDirectory,
        });
        return { ...metricMutationFields('metric.add', options), metric: resource };
      });
      await runMetricMutation(request, options, interactive, context);
    });

  markMetricMutationHelp(
    add,
    [
      'attest metric add exact --preset output-equals --value \'"Paris"\'',
      'attest metric add safe --assert-json \'{"not":{"tool_calls":{"status":"error"}}}\'',
      'attest metric add --from-json ./metric-add.json --output json',
    ],
    ADD_FIELDS,
    METRIC_PRESETS,
  );
};

export { registerMetricAddCommand };
