import {
  CLI_EVENT_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_ID,
  evalCancelResultSchema,
  evalEventSchema,
  evalEventStreamSchema,
  evalFinalResultDataSchema,
  type CliExitCode,
  type EvalCancelRequest,
  type EvalCancelResult,
  type EvalEvent,
  type EvalEventStream,
  type EvalFinalResultData,
  type EvalOutputMode,
  type EvalRunRequest,
} from '@attest/contracts';
import { Command, Option } from 'commander';

import {
  AttestCliError,
  getCliErrorDefinition,
  renderCliError,
  serializeCliError,
} from '../../errors/index.js';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import { createCliFailureResult, serializeCliResult } from '../../output/cli-protocol.js';
import type { CliIo } from '../../run-cli.js';
import type { CliInteraction } from '../register-project-resource-commands.js';
import {
  createEvalCancelRequest,
  createEvalRunRequest,
  type EvalCancelRequestFields,
  type EvalRunRequestFields,
} from './eval-request.js';

type EvalRunExecutionContext = {
  argv: readonly string[];
  project?: string;
  signal: AbortSignal;
  workingDirectory: string;
};

type EvalCancelExecutionContext = {
  project?: string;
  workingDirectory: string;
};

type EvalEventSource = AsyncIterable<EvalEvent> | Iterable<EvalEvent>;

type EvalCommandServices = {
  cancel: (
    request: EvalCancelRequest,
    context: EvalCancelExecutionContext,
  ) => Promise<EvalCancelResult>;
  run: (request: EvalRunRequest, context: EvalRunExecutionContext) => Promise<EvalEventSource>;
};

type RegisterEvalCommandsOptions = {
  argv?: readonly string[];
  interaction: Pick<CliInteraction, 'ci' | 'inputIsTTY' | 'outputIsTTY' | 'prompt' | 'readStdin'>;
  io: CliIo;
  program: Command;
  services: EvalCommandServices;
  setExitCode: (exitCode: CliExitCode) => void;
  workingDirectory: string;
};

type CommonEvalOptions = {
  nonInteractive?: boolean;
  output?: EvalOutputMode;
  project?: string;
};

type EvalRunCliOptions = CommonEvalOptions &
  Omit<EvalRunRequestFields, 'caseIds' | 'output' | 'tags' | 'testIds'> & {
    case?: string[];
    tag?: string[];
  };
type EvalCancelCliOptions = Omit<CommonEvalOptions, 'output'> &
  Omit<EvalCancelRequestFields, 'output' | 'runId'> & {
    output?: Exclude<EvalOutputMode, 'jsonl'>;
  };

const collect = (value: string, previous: string[] | undefined): string[] => [
  ...(previous ?? []),
  value,
];

/** Reads inherited common options without allowing ambiguous root and leaf spellings. */
const mergeCommonOptions = <T extends CommonEvalOptions>(
  local: T,
  command: Command,
  program: Command,
): T => {
  const root = program.opts<CommonEvalOptions>();
  for (const name of ['project', 'output', 'nonInteractive'] as const) {
    if (
      program.getOptionValueSource(name) === 'cli' &&
      command.getOptionValueSource(name) === 'cli'
    ) {
      const flag = name === 'nonInteractive' ? 'non-interactive' : name;
      throw new AttestCliError('cli_usage', `Common option --${flag} was provided twice.`, {
        path: `--${flag}`,
      });
    }
  }
  return { ...root, ...local };
};

const isInteractive = (options: CommonEvalOptions, context: RegisterEvalCommandsOptions): boolean =>
  options.nonInteractive !== true &&
  (options.output ?? 'human') === 'human' &&
  !context.interaction.ci &&
  context.interaction.inputIsTTY &&
  context.interaction.outputIsTTY;

const serializeEvalEvent = (event: EvalEvent): string =>
  JSON.stringify(evalEventSchema.parse(event));

const verdictLabel = (exitCode: CliExitCode, result: EvalFinalResultData['result']): string => {
  if (result.ok) return result.result.verdict.toUpperCase();
  return exitCode === 130 ? 'CANCELLED' : 'ERROR';
};

/** Renders one live orchestration event without terminal control sequences. */
const renderHumanProgress = (event: EvalEvent): string | undefined => {
  switch (event.event) {
    case 'run_started':
      return `Run ${event.data.run_id} started: ${event.data.total_cases} cases, concurrency ${event.data.concurrency}.`;
    case 'case_started':
      return `[${event.data.configured_index + 1}] ${event.data.test_id}/${event.data.case_id} started.`;
    case 'case_completed':
      return `[${event.data.configured_index + 1}] ${event.data.test_id}/${event.data.case_id} ${event.data.verdict}.`;
    case 'run_completed':
      return `Run ${event.data.run_id} ${event.data.status}: ${event.data.summary.passed_cases} passed, ${event.data.summary.failed_cases} failed, ${event.data.summary.error_cases} errors.`;
    case 'result':
      return undefined;
  }
};

/** Renders truthful runnable follow-ups, a labeled comparison template, and the final result. */
const renderHumanFinalResult = (data: EvalFinalResultData): string => {
  const result = data.result;
  const lines = result.ok
    ? [
        `Run ${result.result.run_id}`,
        `  cases: ${result.result.summary.total_cases}`,
        `  passed: ${result.result.summary.passed_cases}`,
        `  failed: ${result.result.summary.failed_cases}`,
        `  errors: ${result.result.summary.error_cases}`,
        `  metric errors: ${result.result.summary.metric_error_count}`,
        'Next:',
        `  attest report ${result.result.run_id}`,
        '  attest view --no-open',
        'Compare with a baseline run:',
        // A successful eval has only the candidate id, so the required baseline stays explicit.
        `  attest diff <base-run-id> ${result.result.run_id}`,
      ]
    : [];
  lines.push(`Result: ${verdictLabel(data.exit_code, result)} (exit ${data.exit_code})`);
  return lines.join('\n');
};

/** Converts a failure into the selected eval output contract and records its stable exit. */
const emitEvalFailure = (
  command: 'eval.cancel' | 'eval.run',
  output: EvalOutputMode,
  error: unknown,
  context: RegisterEvalCommandsOptions,
  cancelled: boolean,
): void => {
  const failure = serializeCliError(
    cancelled
      ? new AttestCliError('cancelled', 'Evaluation was cancelled by a process signal.')
      : error,
  );
  const result = createCliFailureResult(command, failure.error);
  if (output === 'json') context.io.output(serializeCliResult(result));
  else if (output === 'jsonl' && command === 'eval.run') {
    const data = evalFinalResultDataSchema.parse({ exit_code: failure.exitCode, result });
    context.io.output(
      serializeEvalEvent({
        schema: CLI_EVENT_SCHEMA_ID,
        sequence: 0,
        time: new Date().toISOString(),
        event: 'result',
        data,
      }),
    );
  } else {
    context.io.error(renderCliError(failure.error));
    context.io.output(
      `Result: ${failure.exitCode === 130 ? 'CANCELLED' : 'ERROR'} (exit ${failure.exitCode})`,
    );
  }
  context.setExitCode(failure.exitCode);
};

/** Completes an already-live JSONL prefix without resetting its sequence or omitting run completion. */
const recoverFailedJsonlStream = (
  events: readonly EvalEvent[],
  error: unknown,
): EvalEventStream => {
  const alreadyComplete = evalEventStreamSchema.safeParse(events);
  if (alreadyComplete.success) return alreadyComplete.data;
  const started = events[0];
  if (started?.event !== 'run_started') throw error;

  // Terminal events are buffered by the collector, so they can be replaced safely after failure.
  const lifecycle = events.filter(
    (event) => event.event !== 'run_completed' && event.event !== 'result',
  );
  const openCases = new Map<string, Extract<EvalEvent, { event: 'case_started' }>['data']>();
  let completedCases = 0;
  let passedCases = 0;
  let failedCases = 0;
  let errorCases = 0;
  for (const event of lifecycle) {
    if (event.event === 'case_started') {
      openCases.set(`${event.data.test_id}\u0000${event.data.case_id}`, event.data);
    } else if (event.event === 'case_completed') {
      openCases.delete(`${event.data.test_id}\u0000${event.data.case_id}`);
      completedCases += 1;
      if (event.data.verdict === 'pass') passedCases += 1;
      else if (event.data.verdict === 'fail') failedCases += 1;
      else errorCases += 1;
    }
  }

  const recovered: EvalEvent[] = [...lifecycle];
  for (const openCase of openCases.values()) {
    recovered.push({
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: recovered.length,
      time: new Date().toISOString(),
      event: 'case_completed',
      data: {
        ...openCase,
        completion_index: completedCases,
        outcome: 'invocation_error',
        verdict: 'error',
      },
    });
    completedCases += 1;
    errorCases += 1;
  }
  // Cases never started by the failed producer are represented in the terminal error total.
  errorCases += Math.max(0, started.data.total_cases - completedCases);
  const summary = {
    total_cases: started.data.total_cases,
    passed_cases: passedCases,
    failed_cases: failedCases,
    error_cases: errorCases,
    metric_error_count: 0,
  };
  recovered.push({
    schema: CLI_EVENT_SCHEMA_ID,
    sequence: recovered.length,
    time: new Date().toISOString(),
    event: 'run_completed',
    data: { run_id: started.data.run_id, status: 'failed', summary },
  });
  const failure = serializeCliError(
    new AttestCliError('run_failed', 'Eval event source failed after orchestration started.', {
      cause: error,
    }),
  );
  recovered.push({
    schema: CLI_EVENT_SCHEMA_ID,
    sequence: recovered.length,
    time: new Date().toISOString(),
    event: 'result',
    data: evalFinalResultDataSchema.parse({
      exit_code: failure.exitCode,
      result: createCliFailureResult('eval.run', failure.error),
    }),
  });
  return evalEventStreamSchema.parse(recovered);
};

/** Collects and validates a complete event stream while optionally rendering human progress live. */
const collectEvalEvents = async (
  source: EvalEventSource,
  watch: boolean,
  io: CliIo,
  streamJsonl = false,
): Promise<EvalEventStream> => {
  const events: EvalEvent[] = [];
  let emittedJsonlEvents = 0;
  try {
    for await (const value of source) {
      const event = evalEventSchema.parse(value);
      if (event.sequence !== events.length) {
        throw new AttestCliError('run_failed', 'Eval event sequence is not deterministic.', {
          path: `/events/${events.length}/sequence`,
          hint: `Expected sequence ${events.length}; the dispatcher must emit contiguous zero-based events.`,
        });
      }
      events.push(event);
      if (streamJsonl && event.event !== 'run_completed') {
        if (event.event === 'result') {
          const completed = events.at(-2);
          if (completed?.event === 'run_completed') {
            io.output(serializeEvalEvent(completed));
            emittedJsonlEvents += 1;
          }
        }
        io.output(serializeEvalEvent(event));
        emittedJsonlEvents += 1;
      }
      if (watch && event.event !== 'result') {
        const rendered = renderHumanProgress(event);
        if (rendered !== undefined) io.output(rendered);
      }
    }
  } catch (error: unknown) {
    if (!streamJsonl || events.length === 0) throw error;
    const recovered = recoverFailedJsonlStream(events, error);
    for (const event of recovered.slice(emittedJsonlEvents)) {
      io.output(serializeEvalEvent(event));
    }
    return recovered;
  }
  const parsed = evalEventStreamSchema.safeParse(events);
  if (!parsed.success) {
    throw new AttestCliError('run_failed', 'Eval event stream violates the frozen contract.', {
      hint: 'Repair dispatcher event ordering and terminal result metadata.',
      details: {
        diagnostics: parsed.error.issues.map(({ message, path }) => ({
          message,
          path: `/${path.join('/')}`,
        })),
      },
    });
  }
  return parsed.data;
};

/** Executes one normalized eval request and renders its validated final result. */
const executeEvalRun = async (
  request: EvalRunRequest,
  controller: AbortController,
  options: CommonEvalOptions,
  context: RegisterEvalCommandsOptions,
): Promise<void> => {
  const source = await context.services.run(request, {
    argv: context.argv ?? process.argv.slice(2),
    project: options.project,
    signal: controller.signal,
    workingDirectory: context.workingDirectory,
  });
  const events = await collectEvalEvents(
    source,
    request.output === 'human' && request.watch === true,
    context.io,
    request.output === 'jsonl',
  );
  const final = events.at(-1);
  if (final?.event !== 'result') {
    throw new AttestCliError('run_failed', 'Eval stream did not produce a final result.');
  }
  if (request.output === 'json') context.io.output(serializeCliResult(final.data.result));
  else if (request.output !== 'jsonl') {
    if (!final.data.result.ok) context.io.error(renderCliError(final.data.result.error));
    context.io.output(renderHumanFinalResult(final.data));
  }
  context.setExitCode(final.data.exit_code);
};

const cancelExitCode = (result: EvalCancelResult): CliExitCode => {
  if (result.ok) return 0;
  return getCliErrorDefinition(result.error.code)?.exit_code ?? 4;
};

/** Renders the frozen cancellation result without inventing a second response envelope. */
const emitEvalCancellation = (
  request: EvalCancelRequest,
  resultValue: EvalCancelResult,
  context: RegisterEvalCommandsOptions,
): void => {
  const result = evalCancelResultSchema.parse(resultValue);
  const exitCode = cancelExitCode(result);
  if (request.output === 'json') context.io.output(serializeCliResult(result));
  else if (result.ok) {
    const status = result.result.status.replaceAll('_', ' ');
    context.io.output(`Run ${result.result.run_id}: ${status}.`);
  } else {
    context.io.error(renderCliError(result.error));
    context.io.output(`Result: ERROR (exit ${exitCode})`);
  }
  context.setExitCode(exitCode);
};

/** Registers only the eval namespace; integration owns root wiring and dispatcher services. */
const registerEvalCommands = (context: RegisterEvalCommandsOptions): void => {
  const evalCommand = context.program.command('eval').description('Run and cancel evaluations.');
  const run = evalCommand
    .command('run')
    .description('Run selected tests and persist one immutable evaluation.')
    .argument('[test-id...]', 'test ids; pass --all to select every test')
    .option('--all', 'run every test')
    .option('--case <case-id>', 'select an exact case id; repeatable', collect)
    .option('--tag <tag>', 'select cases with every repeated tag; repeatable', collect)
    .option('--concurrency <n>', 'override project and test concurrency')
    .option('--timeout <duration>', 'cap the complete eval run, such as 60s or 2m')
    .option('--baseline <run-id>', 'include a persisted diff against a prior run')
    .option('--junit <path>', 'write JUnit XML atomically')
    .option('--watch', 'render live human progress')
    .option('--from-json <path|->', 'read one eval run request from a file or stdin')
    .option('--project <dir>', 'explicit Attest project directory')
    .addOption(new Option('--output <format>', 'output format').choices(['human', 'json', 'jsonl']))
    .option('--non-interactive', 'disable prompts and fail when selection is missing')
    .action(
      async (
        testIds: string[],
        localOptions: EvalRunCliOptions,
        command: Command,
      ): Promise<void> => {
        const options = mergeCommonOptions(localOptions, command, context.program);
        let output: EvalOutputMode = options.output ?? 'human';
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        process.once('SIGINT', cancel);
        process.once('SIGTERM', cancel);
        try {
          const request = await createEvalRunRequest(
            {
              ...options,
              caseIds: options.case,
              output: options.output,
              tags: options.tag,
              testIds,
            },
            {
              interactive: isInteractive(options, context),
              onOutputMode: (mode) => {
                output = mode;
              },
              prompt: context.interaction.prompt,
              readStdin: context.interaction.readStdin,
              signal: controller.signal,
              workingDirectory: context.workingDirectory,
            },
          );
          if (controller.signal.aborted) {
            throw new AttestCliError('cancelled', 'Evaluation was cancelled before execution.');
          }
          await executeEvalRun(request, controller, options, context);
        } catch (error: unknown) {
          emitEvalFailure('eval.run', output, error, context, controller.signal.aborted);
        } finally {
          process.off('SIGINT', cancel);
          process.off('SIGTERM', cancel);
        }
      },
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
      'JSONL ends with exactly one result event and uses contiguous zero-based sequences.',
    ],
    options: {
      all: { conflicts: ['test-id', 'from-json'] },
      case: { conflicts: ['from-json'], repeatable: true },
      tag: { conflicts: ['from-json'], repeatable: true },
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
    .option('--project <dir>', 'explicit Attest project directory')
    .addOption(new Option('--output <format>', 'output format').choices(['human', 'json']))
    .option('--non-interactive', 'disable prompts and fail when the run id is missing')
    .action(
      async (
        runId: string | undefined,
        localOptions: EvalCancelCliOptions,
        command: Command,
      ): Promise<void> => {
        const options = mergeCommonOptions(localOptions, command, context.program);
        let output: EvalOutputMode = options.output ?? 'human';
        try {
          const request = await createEvalCancelRequest(
            { fromJson: options.fromJson, output: options.output, runId },
            {
              interactive: false,
              onOutputMode: (mode) => {
                output = mode;
              },
              prompt: context.interaction.prompt,
              readStdin: context.interaction.readStdin,
              workingDirectory: context.workingDirectory,
            },
          );
          const result = await context.services.cancel(request, {
            project: options.project,
            workingDirectory: context.workingDirectory,
          });
          emitEvalCancellation(request, result, context);
        } catch (error: unknown) {
          emitEvalFailure('eval.cancel', output, error, context, false);
        }
      },
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

export {
  collectEvalEvents,
  registerEvalCommands,
  renderHumanFinalResult,
  renderHumanProgress,
  type EvalCancelExecutionContext,
  type EvalCommandServices,
  type EvalEventSource,
  type EvalRunExecutionContext,
  type RegisterEvalCommandsOptions,
};
