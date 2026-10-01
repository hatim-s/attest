import { Option, type Command } from 'commander';

import {
  addMutationOptions,
  isInteractive,
  mergeCommonOptions,
  type MutationCliOptions,
} from '../shared/cli-options.js';
import {
  assertNoMetricRequestOverlap,
  markMetricMutationHelp,
  metricMutationFields,
  readOrBuildMetricMutation,
  requiredMetricInput,
  runMetricMutation,
  type RegisterMetricCommandsOptions,
} from './registration-support.js';

type ImportOptions = MutationCliOptions & { as?: string; name?: string; type?: 'json' };

/** Registers canonical JSON metric imports. */
const registerMetricImportCommand = (
  metric: Command,
  context: RegisterMetricCommandsOptions,
): void => {
  const importCommand = addMutationOptions(
    metric.command('import').description('Import one canonical JSON metric from a file or stdin.'),
  )
    .argument('[path|-]', 'canonical metric resource or metric.add request')
    .option('--as <metric-id>', 'imported metric id')
    .addOption(new Option('--type <type>', 'import type').choices(['json']))
    .option('--name <name>', 'override the imported display name')
    .action(async (source: string | undefined, raw: ImportOptions, command: Command) => {
      const options = mergeCommonOptions(raw, command, context.program);
      assertNoMetricRequestOverlap(options, {
        as: options.as,
        name: options.name,
        path: source,
        type: options.type,
      });
      const interactive = isInteractive(options, context.interaction, options.fromJson);
      const request = await readOrBuildMetricMutation(
        'metric.import',
        options,
        context,
        async () => ({
          ...metricMutationFields('metric.import', options),
          source: await requiredMetricInput(
            source,
            '<path|->',
            'Metric JSON path or -: ',
            interactive,
            context,
          ),
          source_type: 'json',
          as: await requiredMetricInput(
            options.as,
            '--as',
            'Imported metric id: ',
            interactive,
            context,
          ),
          ...(options.name === undefined ? {} : { name: options.name }),
        }),
      );
      await runMetricMutation(request, options, interactive, context);
    });
  markMetricMutationHelp(
    importCommand,
    [
      'attest metric import ./metric.json --type json --as correct',
      'attest metric import - --type json --as correct',
      'attest metric import --from-json ./metric-import.json --output json',
    ],
    ['path', 'as', 'type', 'name'],
  );
};

export { registerMetricImportCommand };
