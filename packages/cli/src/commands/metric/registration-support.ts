import { COMMAND_REQUEST_SCHEMA_ID, type MetricPreset } from '@attest/contracts';
import {
  readMetricCommandRequest,
  runMetricMutationCommand,
  validateMetricCommandRequest,
  type MetricAddFields,
  type MetricAuthoringRequest,
} from '@attest/local/metric';
import type { Command } from 'commander';

import { AttestCliError } from '../../errors/index.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import type { CliIo } from '../../run-cli.js';
import { renderCommandResult } from '../shared/command-result.js';
import type { CliInteraction } from '../shared/cli-interaction.js';
import { outputFormat, type MutationCliOptions } from '../shared/cli-options.js';

type RegisterMetricCommandsOptions = {
  interaction: CliInteraction;
  io: CliIo;
  program: Command;
  workingDirectory: string;
};

type MetricAddOptions = MutationCliOptions &
  Omit<MetricAddFields, 'metricId' | 'readStdin' | 'workingDirectory'>;

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

/** Reads a required metric value from a flag or an interactive prompt. */
const requiredMetricInput = async (
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

/** Builds the request fields shared by every metric mutation. */
const metricMutationFields = (command: string, options: MutationCliOptions) => ({
  schema: COMMAND_REQUEST_SCHEMA_ID,
  command,
  ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
  ...(options.yes === undefined ? {} : { yes: options.yes }),
  ...(options.ifProjectHash === undefined ? {} : { if_project_hash: options.ifProjectHash }),
});

/** Rejects flags and arguments that overlap a complete metric request document. */
const assertNoMetricRequestOverlap = (
  options: MutationCliOptions,
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

/** Reads a complete metric mutation request or validates one built from CLI fields. */
const readOrBuildMetricMutation = async <TCommand extends MetricAuthoringRequest['command']>(
  command: TCommand,
  options: MutationCliOptions,
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

/** Executes one metric mutation and renders its stable command result. */
const runMetricMutation = async (
  request: MetricAuthoringRequest,
  options: MutationCliOptions,
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

/** Records request-source conflicts and repeatable fields for a metric mutation command. */
const markMetricMutationHelp = (
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

export {
  assertNoMetricRequestOverlap,
  markMetricMutationHelp,
  metricMutationFields,
  readOrBuildMetricMutation,
  requiredMetricInput,
  runMetricMutation,
  type MetricAddOptions,
  type RegisterMetricCommandsOptions,
};
