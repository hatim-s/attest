import * as Effect from 'effect/Effect';
import type { CommandRequest } from '@attest/contracts';
import { Option, type Command } from 'commander';

import { setMutationHelp } from '../../help/command-help.js';
import {
  addMutationOptions,
  mutationRequestFields,
  type MutationCliOptions,
  promptContext,
} from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { readOrBuildRequest } from '../shared/command-request.js';
import { requiredInput } from '../shared/required-input.js';
import { runMetricMutation } from './run-metric-mutation.js';

type ImportOptions = MutationCliOptions & { as?: string; name?: string; type?: 'json' };

/** Registers canonical JSON metric imports. */
const registerMetricImportCommand = (metric: Command, context: CommandContext): void => {
  const importCommand = addMutationOptions(
    metric.command('import').description('Import one canonical JSON metric from a file or stdin.'),
  )
    .argument('[path|-]', 'canonical metric resource or metric.add request')
    .option('--as <metric-id>', 'imported metric id')
    .addOption(new Option('--type <type>', 'import type').choices(['json']))
    .option('--name <name>', 'override the imported display name')
    .action((source: string | undefined, options: ImportOptions, leaf: Command) =>
      context.submit(
        Effect.gen(function* () {
          const prompt = promptContext(options, context.interaction, context.signal);
          const { interactive } = prompt;

          const request = yield* readOrBuildRequest({
            command: 'metric.import',
            context,
            leaf,
            options,
            build: () =>
              Effect.gen(function* () {
                let request: Extract<CommandRequest, { command: 'metric.import' }> = {
                  ...mutationRequestFields('metric.import', options),
                  source: yield* requiredInput(
                    source,
                    { path: '<path|->', question: 'Metric JSON path or -: ' },
                    prompt,
                  ),
                  source_type: 'json',
                  as: yield* requiredInput(
                    options.as,
                    { path: '--as', question: 'Imported metric id: ' },
                    prompt,
                  ),
                };

                if (options.name !== undefined) {
                  request = { ...request, name: options.name };
                }

                return request;
              }),
          });

          yield* runMetricMutation(request, options, interactive, context);
        }),
      ),
    );

  setMutationHelp(importCommand, {
    examples: [
      'attest metric import ./metric.json --type json --as correct',
      'attest metric import - --type json --as correct',
      'attest metric import --from-json ./metric-import.json --output json',
    ],
  });
};

export { registerMetricImportCommand };
