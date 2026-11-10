import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import { COMMAND_REQUEST_SCHEMA_ID, type EvalEvent, type EvalRunRequest } from '@attest/contracts';
import {
  authenticatedCloudClient,
  resolveCloudUploadProject,
  uploadCloudRun,
} from '@attest/local/cloud';
import { cancelConfiguration, readRequestDocument, runConfiguration } from '@attest/local/eval';
import type { Command } from 'commander';
import {
  AttestCliError,
  renderCliError,
  serializeCliError,
  type SerializedCliFailure,
} from '../../errors/cli-error.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import { createCliSuccessResult, serializeCliResult } from '../../output/cli-protocol.js';
import {
  commonOption,
  nonInteractiveOption,
  outputOption,
  projectOption,
  promptContext,
} from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import {
  addEvalSelectionOptions,
  evalSelectionFields,
  type EvalSelectionOptions,
} from './eval-selection-options.js';
import { collectEvalEvents } from './eval-event-stream.js';
import { failedRunResult, renderHumanFinalResult } from './eval-output.js';
import {
  assertNoEvalFlags,
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
  Omit<EvalRunRequestFields, 'caseIds' | 'datasetIds' | 'folders' | 'tags' | 'testIds'> &
  EvalSelectionOptions & { upload?: boolean };

type EvalCancelCliOptions = CommonEvalOptions & Omit<EvalCancelRequestFields, 'runId'>;

const REQUEST_DOCUMENT_HINT = `Provide one ${COMMAND_REQUEST_SCHEMA_ID} document.`;

/**
 * Builds the run request from flags, or reads it from `--from-json`. A document's own `output`
 * becomes the command's output first, so even an invalid document fails in the mode it asked for.
 */
const readRunRequest = (
  fields: EvalRunRequestFields & {
    fromJson?: string;
    nonInteractive?: boolean;
  },
  command: Command,
  signal: AbortSignal,
  context: CommandContext,
) =>
  Effect.gen(function* () {
    if (fields.fromJson === undefined) {
      return yield* createEvalRunRequest(
        fields,
        promptContext(fields, context.interaction, signal),
      );
    }

    yield* assertNoEvalFlags(fields.fromJson, command);

    const document = yield* readRequestDocument(fields.fromJson, {
      hint: REQUEST_DOCUMENT_HINT,
      readStdin: context.interaction.readStdin,
      workingDirectory: context.workingDirectory,
    });

    const output = requestedOutput(document);

    if (output !== undefined) command.setOptionValueWithSource('output', output, 'config');

    return yield* parseEvalRunRequest(document);
  });

/** Runs one eval, streaming progress or JSONL, and prints the final result in the chosen mode. */
const executeEvalRun = (
  request: EvalRunRequest,
  options: {
    project: string | undefined;
    signal: AbortSignal;
    context: CommandContext;
    upload: boolean;
  },
) =>
  Effect.gen(function* () {
    const { project, signal, context, upload } = options;
    const execute = context.services?.eval?.runConfiguration ?? runConfiguration;

    const cloud = {
      authenticatedCloudClient,
      resolveCloudUploadProject,
      uploadCloudRun,
      ...context.services?.cloud,
    };

    const uploadContext = upload
      ? yield* cloud.resolveCloudUploadProject({
          client: yield* cloud.authenticatedCloudClient(context.credentialPath),
          workingDirectory: context.workingDirectory,
          project,
          signal,
        })
      : undefined;

    const source = yield* execute(request, {
      argv: context.argv,
      project,
      signal,
      terminalFailure: (code, message) =>
        failedRunResult(serializeCliError(new AttestCliError(code, message))),
      workingDirectory: context.workingDirectory,
    }).pipe(Effect.provideContext(context.evalContext));

    let uploadNotice: string | undefined;
    let publishTerminal: (failure?: SerializedCliFailure) => void = () => {};

    const events = yield* collectEvalEvents(source, {
      deferTerminal: (publish) => {
        publishTerminal = publish;
      },
      io: context.io,
      now: () => new Date(),
      streamJsonl: request.output === 'jsonl',
      watch: request.output === 'human' && request.watch === true,
    });

    const final = events.at(-1);

    if (final?.event !== 'result') {
      return yield* Effect.fail(
        new AttestCliError('run_failed', 'Eval stream did not produce a final result.'),
      );
    }

    context.complete((failure) => {
      // A terminal infrastructure failure stays primary; pass/fail/cancel outcomes may still
      // become cleanup failures when the application closes its shared store.
      const primaryFailed = !final.data.result.ok && final.data.result.error.code !== 'cancelled';
      const cleanupFailure = primaryFailed ? undefined : failure;
      publishTerminal(cleanupFailure);
      const result = cleanupFailure === undefined ? final.data : failedRunResult(cleanupFailure);

      if (request.output === 'json') context.io.output(serializeCliResult(result.result));

      if (request.output === 'human') {
        if (!result.result.ok) context.io.error(renderCliError(result.result.error));
        context.io.output(renderHumanFinalResult(result));
      }

      if (uploadNotice !== undefined) context.io.error(uploadNotice);

      return result.exit_code;
    });

    const completed = events.findLast(
      (
        event,
      ): event is Extract<
        EvalEvent,
        {
          event: 'run_completed';
        }
      > => event.event === 'run_completed',
    );

    if (uploadContext !== undefined && completed !== undefined) {
      const uploaded = yield* Effect.exit(
        Effect.suspend(() =>
          cloud.uploadCloudRun({
            ...uploadContext,
            runId: completed.data.run_id,
            signal,
          }),
        ),
      );

      if (Exit.isSuccess(uploaded)) uploadNotice = uploaded.value.url;
      else {
        if (Cause.hasInterrupts(uploaded.cause)) return yield* Effect.failCause(uploaded.cause);
        uploadNotice = renderCliError(serializeCliError(Cause.squash(uploaded.cause)).error);
      }
    }

    return final.data.exit_code;
  });

/**
 * Builds the cancel request from flags, or reads it from `--from-json`. A document's own
 * `output` becomes the command's output before validation, as for `eval run`.
 */
const readCancelRequest = (
  runId: string | undefined,
  options: EvalCancelCliOptions,
  command: Command,
  context: CommandContext,
) =>
  Effect.gen(function* () {
    if (options.fromJson === undefined) {
      return yield* createEvalCancelRequest({ output: options.output, runId });
    }

    yield* assertNoEvalFlags(options.fromJson, command);

    const document = yield* readRequestDocument(options.fromJson, {
      hint: REQUEST_DOCUMENT_HINT,
      readStdin: context.interaction.readStdin,
      workingDirectory: context.workingDirectory,
    });

    const output = requestedOutput(document);

    if (output === 'human' || output === 'json') {
      command.setOptionValueWithSource('output', output, 'config');
    }

    return yield* parseEvalCancelRequest(document);
  });

/** Registers `eval run` and `eval cancel`, which call the local eval runner directly. */
const registerEvalCommands = (context: CommandContext): void => {
  const evalCommand = context.program.command('eval').description('Run and cancel evaluations.');

  const run = addEvalSelectionOptions(
    evalCommand
      .command('run')
      .description('Run selected tests and persist one immutable evaluation.')
      .argument('[test-id...]', 'test ids; pass --all to select every test')
      .option('--all', 'run every test'),
  )
    .option('--sample <n>', 'sample up to n matching cases across selected tests')
    .option(
      '--seed <seed>',
      'reproduce sample membership for an unchanged population; requires --sample',
    )
    .option('--concurrency <n>', 'override project and test concurrency')
    .option('--timeout <duration>', 'cap the complete eval run, such as 60s or 2m')
    .option('--baseline <run-id>', 'include a persisted diff against a prior run')
    .option('--junit <path>', 'write JUnit XML atomically')
    .option('--upload', 'upload the finished run to Attest Cloud')
    .option('--watch', 'render live human progress')
    .option('--from-json <path|->', 'read one eval run request from a file or stdin')
    .addOption(commonOption(projectOption()))
    .addOption(commonOption(outputOption('output format', ['human', 'json', 'jsonl'])))
    .addOption(
      commonOption(nonInteractiveOption('disable prompts and fail when selection is missing')),
    )
    .action((testIds: string[], options: EvalRunCliOptions, command: Command) =>
      context.submit(
        Effect.gen(function* () {
          const fields = {
            ...options,
            ...evalSelectionFields(options),
            testIds,
          };

          const signal = context.signal;
          const request = yield* readRunRequest(fields, command, signal, context);

          if (signal.aborted) {
            return yield* Effect.fail(
              new AttestCliError('cancelled', 'Evaluation was cancelled before execution.'),
            );
          }

          return yield* executeEvalRun(request, {
            project: options.project,
            signal,
            context,
            upload: options.upload === true,
          });
        }),
        {
          cancellation: 'owned',
          cancellationMessage: 'Evaluation was cancelled by a process signal.',
        },
      ),
    );

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
      upload: { conflicts: ['from-json'] },
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
          'upload',
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
    .action((runId: string | undefined, options: EvalCancelCliOptions, command: Command) =>
      context.submit(
        Effect.gen(function* () {
          const request = yield* readCancelRequest(runId, options, command, context);
          const cancel = context.services?.eval?.cancelConfiguration ?? cancelConfiguration;

          const result = yield* cancel(request, {
            project: options.project,
            workingDirectory: context.workingDirectory,
          }).pipe(Effect.provideContext(context.evalContext));

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
        }),
      ),
    );

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
