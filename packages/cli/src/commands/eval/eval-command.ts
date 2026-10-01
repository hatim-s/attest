import {
  COMMAND_REQUEST_SCHEMA_ID,
  type EvalCancelRequest,
  type EvalRunRequest,
} from '@attest/contracts';
import { cancelConfiguration, readRequestDocument, runConfiguration } from '@attest/local/eval';
import type { Command } from 'commander';

import {
  AttestCliError,
  CliExit,
  renderCliError,
  serializeCliError,
} from '../../errors/cli-error.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import { createCliSuccessResult, serializeCliResult } from '../../output/cli-protocol.js';
import {
  collect,
  commonOption,
  isInteractive,
  nonInteractiveOption,
  outputOption,
  projectOption,
} from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { withProcessSignals } from '../shared/process-signals.js';
import { collectEvalEvents } from './eval-event-stream.js';
import { failedRunResult, renderHumanFinalResult } from './eval-output.js';
import {
  assertNoCancelFlags,
  assertNoRunFlags,
  createEvalCancelRequest,
  createEvalRunRequest,
  parseEvalCancelRequest,
  parseEvalRunRequest,
  requestedOutput,
  type EvalCancelRequestFields,
  type EvalRunRequestFields,
} from './eval-request.js';

type CommonEvalOptions = {
  fromJson?: string;
  nonInteractive?: boolean;
  project?: string;
};

type EvalRunCliOptions = CommonEvalOptions &
  Omit<EvalRunRequestFields, 'caseIds' | 'datasetIds' | 'folders' | 'tags' | 'testIds'> & {
    case?: string[];
    dataset?: string[];
    folder?: string[];
    tag?: string[];
  };

type EvalCancelCliOptions = CommonEvalOptions & Omit<EvalCancelRequestFields, 'runId'>;

const REQUEST_DOCUMENT_HINT = `Provide one ${COMMAND_REQUEST_SCHEMA_ID} document.`;

/**
 * Builds the run request from flags, or reads it from `--from-json`. A document's own `output`
 * becomes the command's output first, so even an invalid document fails in the mode it asked for.
 */
const readRunRequest = async (
  fields: EvalRunRequestFields & { fromJson?: string; nonInteractive?: boolean },
  command: Command,
  signal: AbortSignal,
  context: CommandContext,
): Promise<EvalRunRequest> => {
  if (fields.fromJson === undefined) {
    return createEvalRunRequest(fields, {
      interactive: isInteractive(fields, context.interaction),
      prompt: context.interaction.prompt,
      signal,
    });
  }
  assertNoRunFlags(fields.fromJson, fields);
  const document = await readRequestDocument(fields.fromJson, {
    hint: REQUEST_DOCUMENT_HINT,
    readStdin: context.interaction.readStdin,
    workingDirectory: context.workingDirectory,
  });
  const output = requestedOutput(document);
  if (output !== undefined) command.setOptionValueWithSource('output', output, 'config');
  return parseEvalRunRequest(document);
};

/** Runs one eval, streaming progress or JSONL, and prints the final result in the chosen mode. */
const executeEvalRun = async (
  request: EvalRunRequest,
  project: string | undefined,
  signal: AbortSignal,
  context: CommandContext,
): Promise<void> => {
  const source = await runConfiguration(request, {
    argv: context.argv,
    project,
    signal,
    terminalFailure: (code, message) =>
      failedRunResult(serializeCliError(new AttestCliError(code, message))),
    workingDirectory: context.workingDirectory,
  });
  const events = await collectEvalEvents(source, {
    io: context.io,
    now: () => new Date(),
    streamJsonl: request.output === 'jsonl',
    watch: request.output === 'human' && request.watch === true,
  });
  const final = events.at(-1);
  if (final?.event !== 'result') {
    throw new AttestCliError('run_failed', 'Eval stream did not produce a final result.');
  }
  if (request.output === 'json') context.io.output(serializeCliResult(final.data.result));
  if (request.output === 'human') {
    if (!final.data.result.ok) context.io.error(renderCliError(final.data.result.error));
    context.io.output(renderHumanFinalResult(final.data));
  }
  if (final.data.exit_code !== 0) throw new CliExit(final.data.exit_code);
};

/**
 * Builds the cancel request from flags, or reads it from `--from-json`. A document's own
 * `output` becomes the command's output before validation, as for `eval run`.
 */
const readCancelRequest = async (
  runId: string | undefined,
  options: EvalCancelCliOptions,
  command: Command,
  context: CommandContext,
): Promise<EvalCancelRequest> => {
  if (options.fromJson === undefined) {
    return createEvalCancelRequest({ output: options.output, runId });
  }
  assertNoCancelFlags(options.fromJson, { output: options.output, runId });
  const document = await readRequestDocument(options.fromJson, {
    hint: REQUEST_DOCUMENT_HINT,
    readStdin: context.interaction.readStdin,
    workingDirectory: context.workingDirectory,
  });
  const output = requestedOutput(document);
  if (output === 'human' || output === 'json') {
    command.setOptionValueWithSource('output', output, 'config');
  }
  return parseEvalCancelRequest(document);
};

/** Registers `eval run` and `eval cancel`, which call the local eval runner directly. */
const registerEvalCommands = (context: CommandContext): void => {
  const evalCommand = context.program.command('eval').description('Run and cancel evaluations.');
  const run = evalCommand
    .command('run')
    .description('Run selected tests and persist one immutable evaluation.')
    .argument('[test-id...]', 'test ids; pass --all to select every test')
    .option('--all', 'run every test')
    .option('--case <case-id>', 'select an exact case id; repeatable', collect)
    .option('--tag <tag>', 'select cases with every repeated tag; repeatable', collect)
    .option('--folder <folder>', 'select a logical folder and descendants; repeatable', collect)
    .option('--dataset <dataset-id>', 'select cases from an attached dataset; repeatable', collect)
    .option('--sample <n>', 'sample up to n matching cases across selected tests')
    .option(
      '--seed <seed>',
      'reproduce sample membership for an unchanged population; requires --sample',
    )
    .option('--concurrency <n>', 'override project and test concurrency')
    .option('--timeout <duration>', 'cap the complete eval run, such as 60s or 2m')
    .option('--baseline <run-id>', 'include a persisted diff against a prior run')
    .option('--junit <path>', 'write JUnit XML atomically')
    .option('--watch', 'render live human progress')
    .option('--from-json <path|->', 'read one eval run request from a file or stdin')
    .addOption(commonOption(projectOption()))
    .addOption(commonOption(outputOption('output format', ['human', 'json', 'jsonl'])))
    .addOption(
      commonOption(nonInteractiveOption('disable prompts and fail when selection is missing')),
    )
    .action(async (testIds: string[], options: EvalRunCliOptions, command: Command) => {
      const fields = {
        ...options,
        caseIds: options.case,
        datasetIds: options.dataset,
        folders: options.folder,
        tags: options.tag,
        testIds,
      };
      await withProcessSignals(async (signal) => {
        try {
          const request = await readRunRequest(fields, command, signal, context);
          if (signal.aborted) {
            throw new AttestCliError('cancelled', 'Evaluation was cancelled before execution.');
          }
          await executeEvalRun(request, options.project, signal, context);
        } catch (error: unknown) {
          if (!signal.aborted || error instanceof CliExit) throw error;
          throw new AttestCliError('cancelled', 'Evaluation was cancelled by a process signal.', {
            cause: error,
          });
        }
      });
    });
  setCliCommandHelpMetadata(run, {
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
    examples: [
      'attest eval run refund --case refund-basic --output human',
      'attest eval run --all --concurrency 4 --timeout 2m --output json',
      'attest eval run --from-json ./eval-run.json',
    ],
    constraints: [
      'Provide one or more test ids or --all; the interactive wizard may supply the selection.',
      '--all and explicit test ids are mutually exclusive.',
      '--watch is available only with human output.',
      '--seed requires --sample; filters apply before sampling across selected tests.',
      'JSONL ends with exactly one result event and uses contiguous zero-based sequences.',
    ],
    options: {
      all: { conflicts: ['test-id', 'from-json'] },
      case: { conflicts: ['from-json'] },
      tag: { conflicts: ['from-json'] },
      folder: { conflicts: ['from-json'] },
      dataset: { conflicts: ['from-json'] },
      sample: { conflicts: ['from-json'] },
      seed: { conflicts: ['from-json'], implies: ['sample'] },
      concurrency: { conflicts: ['from-json'] },
      timeout: { conflicts: ['from-json'] },
      baseline: { conflicts: ['from-json'] },
      junit: { conflicts: ['from-json'] },
      watch: { conflicts: ['from-json', 'output=json', 'output=jsonl'] },
      output: { conflicts: ['from-json'], implies: ['non-interactive'] },
      'from-json': {
        conflicts: [
          'test-id',
          'all',
          'case',
          'tag',
          'folder',
          'dataset',
          'sample',
          'seed',
          'concurrency',
          'timeout',
          'baseline',
          'junit',
          'watch',
          'output',
        ],
        implies: ['non-interactive'],
      },
    },
  });

  const cancel = evalCommand
    .command('cancel')
    .description('Request cancellation of one immutable eval run.')
    .argument('[run-id]', 'eval run id')
    .option('--from-json <path|->', 'read one cancellation request from a file or stdin')
    .addOption(commonOption(projectOption()))
    .addOption(commonOption(outputOption()))
    .addOption(
      commonOption(nonInteractiveOption('disable prompts and fail when the run id is missing')),
    )
    .action(async (runId: string | undefined, options: EvalCancelCliOptions, command: Command) => {
      const request = await readCancelRequest(runId, options, command, context);
      const result = await cancelConfiguration(request, {
        project: options.project,
        workingDirectory: context.workingDirectory,
      });
      if (request.output === 'json') {
        const document = createCliSuccessResult(
          'eval.cancel',
          { run_id: result.runId, status: result.status },
          { projectHashBefore: result.projectHash, projectHashAfter: result.projectHash },
        );
        context.io.output(serializeCliResult(document));
        return;
      }
      context.io.output(`Run ${result.runId}: ${result.status.replaceAll('_', ' ')}.`);
    });
  setCliCommandHelpMetadata(cancel, {
    requestSchema: COMMAND_REQUEST_SCHEMA_ID,
    examples: [
      'attest eval cancel 01ARZ3NDEKTSV4RRFFQ69G5FAV --output json',
      'attest eval cancel --from-json ./eval-cancel.json',
    ],
    constraints: ['Provide one run id argument or one complete --from-json request.'],
    options: {
      output: { conflicts: ['from-json'], implies: ['non-interactive'] },
      'from-json': { conflicts: ['run-id', 'output'], implies: ['non-interactive'] },
    },
  });
};

export { registerEvalCommands };
