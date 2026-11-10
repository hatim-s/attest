import * as Effect from 'effect/Effect';
import {
  METRIC_PRESETS,
  httpRequestTemplateSchema,
  metricPresetIdSchema,
  spanFilterSchema,
  spanKindSchema,
  spanStatusSchema,
} from '@attest/contracts';
import { createMetricResource } from '@attest/local/metric';
import { Option, type Command } from 'commander';

import { setMutationHelp } from '../../help/command-help.js';
import {
  addMutationOptions,
  collect,
  mutationRequestFields,
  promptContext,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { readOrBuildRequest } from '../shared/command-request.js';
import { requiredInput } from '../shared/required-input.js';
import { fillGuidedMetricFields, selectGuidedMetricFields } from './guided-metric-add.js';
import type { GuidedMetricFields } from './guided-metric-prompts.js';
import { runMetricMutation } from './run-metric-mutation.js';

type MetricAddOptions = MutationCliOptions & GuidedMetricFields;

/** Registers assertion, judge, executable, and HTTP metric authoring. */
const registerMetricAddCommand = (metric: Command, context: CommandContext): void => {
  const add = addMutationOptions(
    metric.command('add').description('Add one assertion, judge, executable, or HTTP metric.'),
  )
    .argument('[metric-id]', 'metric id')
    .option('--name <name>', 'metric display name; defaults to the id')
    .addOption(
      new Option('--preset <preset>', 'stable metric preset').choices(
        metricPresetIdSchema.literals,
      ),
    )
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
    .addOption(
      new Option('--tool-status <status>', 'tool status').choices(
        spanStatusSchema.schema.fields.code.literals,
      ),
    )
    .option('--count <integer>', 'tool-call or span count')
    .option('--order <name>', 'tool or span name in chronological order; repeatable', collect)
    .option('--arg-equals <path=json>', 'tool argument equals matcher; repeatable', collect)
    .option('--arg-contains <path=json>', 'tool argument contains matcher; repeatable', collect)
    .option('--arg-exists <path>', 'tool argument exists matcher; repeatable', collect)
    .addOption(new Option('--span-kind <kind>', 'trace span kind').choices(spanKindSchema.literals))
    .option('--span-name <name>', 'trace span name')
    .addOption(
      new Option('--span-status <status>', 'trace span status').choices(
        spanFilterSchema.fields.status.schema.members[0].literals,
      ),
    )
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
      new Option('--http-method <method>', 'HTTP metric method').choices(
        httpRequestTemplateSchema.fields.method.literals,
      ),
    )
    .option('--header-env <header=source-env>', 'HTTP header secret reference', collect)
    .option('--query-env <name=source-env>', 'HTTP query secret reference', collect)
    .option('--body-json <json>', 'HTTP metric request body')
    .option('--score-pointer <pointer>', 'HTTP result score pointer; defaults to /score')
    .option('--pass-pointer <pointer>', 'HTTP result pass pointer; defaults to /pass')
    .option('--rationale-pointer <pointer>', 'HTTP result rationale pointer')
    .option('--details-pointer <pointer>', 'HTTP result details pointer')
    .action((metricId: string | undefined, options: MetricAddOptions, leaf: Command) =>
      context.submit(
        Effect.gen(function* () {
          const prompt = promptContext(options, context.interaction, context.signal);

          const request = yield* readOrBuildRequest({
            command: 'metric.add',
            context,
            leaf,
            options,
            build: () =>
              Effect.gen(function* () {
                const id = yield* requiredInput(
                  metricId,
                  { path: '<metric-id>', question: 'Metric id: ' },
                  prompt,
                );

                const selected = yield* selectGuidedMetricFields(options, prompt, context);
                const guided = yield* fillGuidedMetricFields(selected, prompt);

                const resource = yield* createMetricResource({
                  ...guided,
                  metricId: id,
                  readStdin: context.interaction.readStdin,
                  workingDirectory: context.workingDirectory,
                });

                return { ...mutationRequestFields('metric.add', options), metric: resource };
              }),
          });

          yield* runMetricMutation({ request, options, prompt, context });
        }),
      ),
    );

  setMutationHelp(add, {
    examples: [
      'attest metric add exact --preset output-equals --value \'"Paris"\'',
      'attest metric add safe --assert-json \'{"not":{"tool_calls":{"status":"error"}}}\'',
      'attest metric add --from-json ./metric-add.json --output json',
    ],
    presets: METRIC_PRESETS,
  });
};

export { registerMetricAddCommand };
