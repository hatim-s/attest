import { COMMAND_REQUEST_SCHEMA_ID, type DatasetImportMapping } from '@attest/contracts';
import { Command, Option } from 'commander';

import { AttestCliError } from '../../../errors/index.js';
import { setCliCommandHelpMetadata } from '../../../help/command-help.js';
import type { JsonValue } from '../../../project/canonical-project.js';
import type { CliIo } from '../../../run-cli.js';
import type { CliInteraction } from '../../shared/cli-interaction.js';
import { renderCommandResult, type CommandResult } from '../../shared/command-result.js';
import {
  addCommonOptions,
  addMutationOptions as addSharedMutationOptions,
  collectOption as collect,
  isInteractive,
  outputFormat,
  type CommonCliOptions as CommonOptions,
  type MutationCliOptions as MutationOptions,
} from '../../shared/cli-options.js';
import {
  prepareImportSource,
  type PreparedImportSource,
} from '../import/tabular-import-adapter.js';
import { readCommandRequest, validateCommandRequest } from '../test-command-input.js';
import { runTestMutationCommand, type TestAuthoringCommand } from '../test-command.js';

type RegisterTestCommandsOptions = {
  interaction: CliInteraction;
  io: CliIo;
  program: Command;
  workingDirectory: string;
};

type TestOptions = MutationOptions & {
  agent?: string;
  metric?: string[];
  name?: string;
};

type CaseOptions = MutationOptions & {
  dedupe?: 'content' | 'id' | 'key';
  expected?: string;
  format?: 'csv' | 'json' | 'jsonl';
  id?: string;
  input?: string;
  key?: string;
  map?: string[];
  onConflict?: 'error' | 'skip' | 'update';
  params?: string;
  parseJson?: string[];
  recordsPointer?: string;
  sync?: 'append' | 'upsert';
  tag?: string[];
};

type DatasetOptions = CaseOptions & {
  as?: string;
  name?: string;
};

const addMutationOptions = (command: Command): Command =>
  addSharedMutationOptions(command, 'accept destructive confirmation prompts');

const addImportOptions = (command: Command): Command =>
  addMutationOptions(command)
    .addOption(
      new Option('--format <format>', 'stdin or explicit import format').choices([
        'csv',
        'json',
        'jsonl',
      ]),
    )
    .option('--map <destination=source>', 'explicit field mapping; repeatable', collect)
    .option('--parse-json <source>', 'parse one structured CSV column as JSON; repeatable', collect)
    .option('--records-pointer <pointer>', 'RFC 6901 pointer to a JSON records array')
    .option('--key <source>', 'stable source key for incremental imports')
    .addOption(
      new Option('--dedupe <basis>', 'within-import dedupe basis').choices([
        'id',
        'key',
        'content',
      ]),
    )
    .addOption(
      new Option('--on-conflict <policy>', 'existing-case conflict policy').choices([
        'error',
        'skip',
        'update',
      ]),
    )
    .addOption(
      new Option('--sync <policy>', 'incremental import policy').choices(['append', 'upsert']),
    );

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
  schema: COMMAND_REQUEST_SCHEMA_ID,
  command,
  ...(options.dryRun === undefined ? {} : { dry_run: options.dryRun }),
  ...(options.yes === undefined ? {} : { yes: options.yes }),
  ...(options.ifProjectHash === undefined ? {} : { if_project_hash: options.ifProjectHash }),
});

/** Parses one unambiguous destination/source mapping without treating later equals signs specially. */
const parseMapping = (value: string): DatasetImportMapping => {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new AttestCliError('cli_usage', 'Import mappings must use destination=source.', {
      path: '--map',
      hint: 'For example, pass --map input.question=prompt.',
    });
  }
  return { destination: value.slice(0, separator), source: value.slice(separator + 1) };
};

const importRequestFields = (options: CaseOptions) => ({
  ...(options.format === undefined ? {} : { format: options.format }),
  ...(options.map === undefined ? {} : { mapping: options.map.map(parseMapping) }),
  ...(options.parseJson === undefined ? {} : { parse_json: options.parseJson }),
  ...(options.recordsPointer === undefined ? {} : { records_pointer: options.recordsPointer }),
  ...(options.key === undefined ? {} : { key: options.key }),
  ...(options.dedupe === undefined ? {} : { dedupe: options.dedupe }),
  ...(options.onConflict === undefined ? {} : { on_conflict: options.onConflict }),
  ...(options.sync === undefined ? {} : { sync: options.sync }),
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

const executeMutation = async (
  request: TestAuthoringCommand,
  options: MutationOptions,
  context: Pick<RegisterTestCommandsOptions, 'interaction' | 'workingDirectory'>,
  preparedImportSource?: Uint8Array,
): Promise<CommandResult> =>
  runTestMutationCommand({
    preparedImportSource,
    project: options.project,
    readImportStdin: context.interaction.readImportStdin,
    readStdin: context.interaction.readStdin,
    request,
    workingDirectory: context.workingDirectory,
  });

type MutationExecutor = typeof executeMutation;

const runMutation = async (
  command: TestAuthoringCommand['command'],
  request: TestAuthoringCommand,
  options: MutationOptions,
  context: RegisterTestCommandsOptions,
  preparedImportSource?: Uint8Array,
): Promise<void> => {
  const result = await executeMutation(request, options, context, preparedImportSource);
  context.io.output(renderCommandResult(command, outputFormat(options), result));
};

/** Runs the mandatory shared-dataset preview before treating yes as prompt bypass. */
const runConfirmedDatasetImport = async (
  request: Extract<TestAuthoringCommand, { command: 'test.dataset.import' }>,
  options: MutationOptions,
  context: Pick<RegisterTestCommandsOptions, 'interaction' | 'io' | 'workingDirectory'>,
  execute: MutationExecutor = executeMutation,
): Promise<void> => {
  const prepared = await prepareImportSource(
    request.source,
    context.workingDirectory,
    context.interaction.readImportStdin,
    request.import.format,
  );
  const previewRequest = validateCommandRequest('test.dataset.import', {
    ...request,
    dry_run: true,
  });
  const preview = await execute(previewRequest, options, context, prepared.source);
  const previewResult = preview.result as Record<string, JsonValue>;
  const affectedTests = Array.isArray(previewResult.affected_tests)
    ? previewResult.affected_tests.filter((value): value is string => typeof value === 'string')
    : [];
  const previewProjectHash = preview.projectHashBefore;
  if (previewProjectHash === null || previewProjectHash === undefined) {
    throw new Error('Dataset import preview did not return its base project hash.');
  }

  const confirmedRequest = validateCommandRequest('test.dataset.import', {
    ...request,
    dry_run: false,
    if_project_hash: previewProjectHash,
    yes: true,
  });
  if (affectedTests.length < 2) {
    const committed = await execute(confirmedRequest, options, context, prepared.source);
    context.io.output(renderCommandResult('test.dataset.import', outputFormat(options), committed));
    return;
  }

  const committed = await execute(confirmedRequest, options, context, prepared.source);
  const committedResult = committed.result as Record<string, JsonValue>;
  const combined: CommandResult = {
    ...committed,
    human: [
      'Shared dataset update preview:',
      preview.human,
      'Confirmed shared dataset update:',
      committed.human,
    ].join('\n\n'),
    result: {
      ...committedResult,
      shared_dataset_preview: {
        affected_tests: affectedTests,
        import: previewResult.import ?? null,
        operations: previewResult.operations ?? [],
        project_hash_before: previewProjectHash,
      },
    },
  };
  context.io.output(renderCommandResult('test.dataset.import', outputFormat(options), combined));
};

/** Proposes conservative canonical mappings only from exact authored CSV headers. */
const suggestedCsvMappings = (headers: readonly string[]): DatasetImportMapping[] => {
  const sourceFor = (...candidates: string[]): string | undefined =>
    candidates.find((candidate) => headers.includes(candidate));
  return [
    ['id', sourceFor('id', 'external_id')],
    ['input', sourceFor('input', 'prompt', 'question')],
    ['expected', sourceFor('expected', 'ideal', 'answer')],
    ['params', sourceFor('params', 'parameters')],
    ['tags', sourceFor('tags')],
  ].flatMap(([destination, source]) =>
    destination === undefined || source === undefined ? [] : [{ destination, source }],
  );
};

/** Shows a bounded dry-run preview and applies only after an explicit default-no confirmation. */
const runGuidedImport = async (
  command: 'test.case.import' | 'test.dataset.import',
  request: Extract<TestAuthoringCommand, { command: 'test.case.import' | 'test.dataset.import' }>,
  options: MutationOptions,
  context: RegisterTestCommandsOptions,
): Promise<void> => {
  const prepared: PreparedImportSource = await prepareImportSource(
    request.source,
    context.workingDirectory,
    context.interaction.readImportStdin,
    request.import.format,
  );
  let guidedRequest = request;
  if (prepared.format === 'csv' && (request.import.mapping?.length ?? 0) === 0) {
    const suggestions = suggestedCsvMappings(prepared.csvHeaders);
    if (suggestions.length === 0) {
      throw new AttestCliError('cli_missing_input', 'No safe CSV field mappings were detected.', {
        path: '--map',
        hint: `Detected headers: ${prepared.csvHeaders.join(', ') || '<none>'}. Pass explicit --map destination=header options.`,
      });
    }
    const proposal = suggestions
      .map(({ destination, source }) => `${destination}=${source}`)
      .join(', ');
    const answer = (
      await context.interaction.prompt(
        `Detected CSV headers: ${prepared.csvHeaders.join(', ')}. Use mappings ${proposal}? [Y/n]: `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'n' || answer === 'no') {
      context.io.output(
        'No changes made; pass explicit --map options to choose different mappings.',
      );
      return;
    }
    guidedRequest = validateCommandRequest(command, {
      ...request,
      import: { ...request.import, mapping: suggestions },
    });
  }

  const previewRequest = validateCommandRequest(command, { ...guidedRequest, dry_run: true });
  const preview = await runTestMutationCommand({
    preparedImportSource: prepared.source,
    project: options.project,
    readImportStdin: context.interaction.readImportStdin,
    readStdin: context.interaction.readStdin,
    request: previewRequest,
    workingDirectory: context.workingDirectory,
  });
  context.io.output(renderCommandResult(command, 'human', preview));
  const answer = (await context.interaction.prompt('Apply this import? [y/N]: '))
    .trim()
    .toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    context.io.output('No changes made; import was not applied.');
    return;
  }
  const confirmed = validateCommandRequest(command, {
    ...guidedRequest,
    dry_run: false,
    if_project_hash: preview.projectHashBefore,
    yes: true,
  });
  await runMutation(command, confirmed, options, context, prepared.source);
};

const markMutationHelp = (
  command: Command,
  examples: string[],
  metadata: {
    constraints?: readonly string[];
    importOptions?: boolean;
  } = {},
): void => {
  setCliCommandHelpMetadata(command, {
    examples,
    constraints: [...(metadata.constraints ?? [])],
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
    options: {
      output: { implies: ['non-interactive'] },
      ...(metadata.importOptions === true
        ? {
            map: { repeatable: true },
            'parse-json': { repeatable: true },
            'on-conflict': { default: 'error' },
            sync: { default: 'append' },
          }
        : {}),
      'from-json': {
        conflicts: ['command arguments', 'command flags', 'dry-run', 'yes', 'if-project-hash'],
        implies: ['non-interactive'],
      },
    },
  });
};

export {
  addCommonOptions,
  addImportOptions,
  addMutationOptions,
  collect,
  commonRequestFields,
  confirmRemoval,
  importRequestFields,
  isInteractive,
  markMutationHelp,
  outputFormat,
  renderCommandResult,
  requestFromSource,
  requiredInput,
  runConfirmedDatasetImport,
  runGuidedImport,
  runMutation,
  type CaseOptions,
  type CommonOptions,
  type DatasetOptions,
  type MutationOptions,
  type RegisterTestCommandsOptions,
  type TestOptions,
};
