import { Option, type Command } from 'commander';

import { setMutationHelp } from '../../help/command-help.js';
import {
  addMutationOptions,
  isInteractive,
  mutationRequestFields,
  type MutationCliOptions,
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
    .action(async (source: string | undefined, options: ImportOptions, leaf: Command) => {
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const prompt = { interactive, prompt: context.interaction.prompt };
      const request = await readOrBuildRequest({
        command: 'metric.import',
        context,
        leaf,
        options,
        build: async () => ({
          ...mutationRequestFields('metric.import', options),
          source: await requiredInput(
            source,
            { path: '<path|->', question: 'Metric JSON path or -: ' },
            prompt,
          ),
          source_type: 'json',
          as: await requiredInput(
            options.as,
            { path: '--as', question: 'Imported metric id: ' },
            prompt,
          ),
          ...(options.name === undefined ? {} : { name: options.name }),
        }),
      });
      await runMetricMutation(request, options, interactive, context);
    });
  setMutationHelp(importCommand, {
    examples: [
      'attest metric import ./metric.json --type json --as correct',
      'attest metric import - --type json --as correct',
      'attest metric import --from-json ./metric-import.json --output json',
    ],
  });
};

export { registerMetricImportCommand };
