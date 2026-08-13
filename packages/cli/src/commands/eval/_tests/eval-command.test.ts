import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  CLI_EVENT_SCHEMA_ID,
  CLI_RESULT_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_ID,
  cliResultSchema,
  evalCancelResultSchema,
  evalEventStreamSchema,
  type CliExitCode,
  type EvalEvent,
  type EvalRunRequest,
} from '@attest/contracts';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliHelp } from '../../../help/command-help.js';
import { getCliErrorDefinition } from '../../../errors/index.js';
import type { CliIo } from '../../../run-cli.js';
import {
  registerEvalCommands,
  type EvalCommandServices,
  type RegisterEvalCommandsOptions,
} from '../eval-command.js';
import { createEvalRunRequest } from '../eval-request.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BASELINE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const SNAPSHOT_HASH = 'f'.repeat(64);
const PROJECT_HASH = 'a'.repeat(64);
const TIME = '2026-08-08T10:00:00.000Z';
const PTY_DRIVER = fileURLToPath(new URL('./fixtures/drive-eval-command-pty.py', import.meta.url));
const PTY_CHILD = fileURLToPath(new URL('./fixtures/eval-command-pty.ts', import.meta.url));
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

type CollectedIo = { errors: string[]; io: CliIo; output: string[] };

type EvalHarness = CollectedIo & {
  exitCode: () => CliExitCode;
  program: Command;
};

const collectIo = (): CollectedIo => {
  const errors: string[] = [];
  const output: string[] = [];
  return {
    errors,
    output,
    io: { error: (message) => errors.push(message), output: (message) => output.push(message) },
  };
};

const interaction = (
  overrides: Partial<RegisterEvalCommandsOptions['interaction']> = {},
): RegisterEvalCommandsOptions['interaction'] => ({
  ci: false,
  inputIsTTY: false,
  outputIsTTY: false,
  prompt: () => Promise.reject(new Error('prompt must not be called')),
  readStdin: () => Promise.resolve(''),
  ...overrides,
});

const cancellationSuccess = () =>
  evalCancelResultSchema.parse({
    schema: CLI_RESULT_SCHEMA_ID,
    ok: true,
    command: 'eval.cancel',
    project_hash_before: null,
    project_hash_after: null,
    result: { run_id: RUN_ID, status: 'cancellation_requested' },
    warnings: [],
  });

/** Builds a fully valid stream with completion order intentionally different from configured order. */
const completedEvents = (verdict: 'fail' | 'pass' = 'pass'): EvalEvent[] => {
  const summary = {
    total_cases: 2,
    passed_cases: verdict === 'pass' ? 2 : 1,
    failed_cases: verdict === 'pass' ? 0 : 1,
    error_cases: 0,
    metric_error_count: 0,
  };
  const exitCode = verdict === 'pass' ? 0 : 1;
  return evalEventStreamSchema.parse([
    {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 0,
      time: TIME,
      event: 'run_started',
      data: {
        run_id: RUN_ID,
        snapshot_hash: SNAPSHOT_HASH,
        total_cases: 2,
        concurrency: 2,
        timeout_ms: 60_000,
      },
    },
    {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 1,
      time: TIME,
      event: 'case_started',
      data: { run_id: RUN_ID, test_id: 'refund', case_id: 'basic', configured_index: 0 },
    },
    {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 2,
      time: TIME,
      event: 'case_started',
      data: { run_id: RUN_ID, test_id: 'refund', case_id: 'delayed', configured_index: 1 },
    },
    {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 3,
      time: TIME,
      event: 'case_completed',
      data: {
        run_id: RUN_ID,
        test_id: 'refund',
        case_id: 'delayed',
        configured_index: 1,
        completion_index: 0,
        outcome: 'completed',
        verdict: 'pass',
      },
    },
    {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 4,
      time: TIME,
      event: 'case_completed',
      data: {
        run_id: RUN_ID,
        test_id: 'refund',
        case_id: 'basic',
        configured_index: 0,
        completion_index: 1,
        outcome: 'completed',
        verdict,
      },
    },
    {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 5,
      time: TIME,
      event: 'run_completed',
      data: { run_id: RUN_ID, status: 'completed', summary },
    },
    {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 6,
      time: TIME,
      event: 'result',
      data: {
        exit_code: exitCode,
        result: {
          schema: CLI_RESULT_SCHEMA_ID,
          ok: true,
          command: 'eval.run',
          project_hash_before: PROJECT_HASH,
          project_hash_after: PROJECT_HASH,
          result: {
            run_id: RUN_ID,
            snapshot_hash: SNAPSHOT_HASH,
            status: 'completed',
            summary,
            verdict,
          },
          warnings: [],
        },
      },
    },
  ]);
};

const defaultServices = (): EvalCommandServices => ({
  cancel: () => Promise.resolve(cancellationSuccess()),
  run: () => Promise.resolve(completedEvents()),
});

/** Builds one catalog-shaped terminal infrastructure failure for renderer parity checks. */
const failedEvents = (): EvalEvent[] =>
  evalEventStreamSchema.parse([
    {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 0,
      time: TIME,
      event: 'run_started',
      data: {
        run_id: RUN_ID,
        snapshot_hash: SNAPSHOT_HASH,
        total_cases: 0,
        concurrency: 1,
        timeout_ms: 60_000,
      },
    },
    {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 1,
      time: TIME,
      event: 'run_completed',
      data: {
        run_id: RUN_ID,
        status: 'failed',
        summary: {
          total_cases: 0,
          passed_cases: 0,
          failed_cases: 0,
          error_cases: 0,
          metric_error_count: 0,
        },
      },
    },
    {
      schema: CLI_EVENT_SCHEMA_ID,
      sequence: 2,
      time: TIME,
      event: 'result',
      data: {
        exit_code: 4,
        result: {
          schema: CLI_RESULT_SCHEMA_ID,
          ok: false,
          command: 'eval.run',
          error: {
            code: 'run_failed',
            message: 'Eval run encountered an infrastructure error.',
            retryable: true,
          },
        },
      },
    },
  ]);

/** Creates the isolated command tree used by integration without mutating root registration. */
const createHarness = (
  services: EvalCommandServices = defaultServices(),
  interactionOptions: RegisterEvalCommandsOptions['interaction'] = interaction(),
  workingDirectory = process.cwd(),
): EvalHarness => {
  const collected = collectIo();
  const program = new Command().name('attest').exitOverride();
  let exitCode: CliExitCode = 0;
  registerEvalCommands({
    argv: ['eval', 'run'],
    interaction: interactionOptions,
    io: collected.io,
    program,
    services,
    setExitCode: (value) => {
      exitCode = value;
    },
    workingDirectory,
  });
  return { ...collected, exitCode: () => exitCode, program };
};

const parse = async (harness: EvalHarness, argv: readonly string[]): Promise<void> => {
  await harness.program.parseAsync([...argv], { from: 'user' });
};

const createTemporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('eval request normalization', () => {
  it('normalizes every run flag through the frozen request schema', async () => {
    const run = vi.fn<EvalCommandServices['run']>(() => Promise.resolve(completedEvents('fail')));
    const harness = createHarness({ ...defaultServices(), run });
    await parse(harness, [
      'eval',
      'run',
      'refund',
      'returns',
      '--case',
      'basic',
      '--case',
      'delayed',
      '--tag',
      'smoke',
      '--tag',
      'api',
      '--concurrency',
      '2',
      '--timeout',
      '60s',
      '--baseline',
      BASELINE_ID,
      '--junit',
      'artifacts/eval.xml',
      '--output',
      'json',
    ]);

    expect(run.mock.calls[0]?.[0]).toEqual({
      schema: COMMAND_REQUEST_SCHEMA_ID,
      command: 'eval.run',
      test_ids: ['refund', 'returns'],
      case_ids: ['basic', 'delayed'],
      tags: ['smoke', 'api'],
      concurrency: 2,
      timeout_ms: 60_000,
      baseline_run_id: BASELINE_ID,
      junit_path: 'artifacts/eval.xml',
      output: 'json',
    });
    expect(run.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(harness.exitCode()).toBe(1);
    expect(harness.output).toHaveLength(1);
    expect(cliResultSchema.parse(JSON.parse(harness.output[0]!) as unknown)).toMatchObject({
      ok: true,
      command: 'eval.run',
      result: { verdict: 'fail' },
    });
  });

  it('normalizes a complete stdin JSON request without mixing flag values', async () => {
    const request: EvalRunRequest = {
      schema: COMMAND_REQUEST_SCHEMA_ID,
      command: 'eval.run',
      all: true,
      concurrency: 3,
      output: 'jsonl',
    };
    const run = vi.fn<EvalCommandServices['run']>(() => Promise.resolve(completedEvents()));
    const harness = createHarness(
      { ...defaultServices(), run },
      interaction({ readStdin: () => Promise.resolve(JSON.stringify(request)) }),
    );
    await parse(harness, ['eval', 'run', '--from-json', '-']);

    expect(run.mock.calls[0]?.[0]).toEqual(request);
    expect(
      evalEventStreamSchema.parse(
        harness.output.map((line): unknown => JSON.parse(line) as unknown),
      ),
    ).toHaveLength(7);
    expect(JSON.parse(harness.output.at(-1)!) as { event: string }).toMatchObject({
      event: 'result',
    });
  });

  it('uses the TTY wizard only to supply a missing selection before schema validation', async () => {
    const run = vi.fn<EvalCommandServices['run']>(() => Promise.resolve(completedEvents()));
    const prompt = vi.fn<RegisterEvalCommandsOptions['interaction']['prompt']>(() =>
      Promise.resolve('refund returns'),
    );
    const harness = createHarness(
      { ...defaultServices(), run },
      interaction({ inputIsTTY: true, outputIsTTY: true, prompt }),
    );
    await parse(harness, ['eval', 'run']);

    expect(prompt.mock.calls[0]?.[0]).toBe('Test ids (space-separated) or all [all]: ');
    expect(prompt.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      command: 'eval.run',
      output: 'human',
      test_ids: ['refund', 'returns'],
    });
    expect(harness.output.at(-1)).toBe(
      'Run 01ARZ3NDEKTSV4RRFFQ69G5FAV\n  cases: 2\n  passed: 2\n  failed: 0\n  errors: 0\n  metric errors: 0\nNext:\n  attest report 01ARZ3NDEKTSV4RRFFQ69G5FAV\n  attest view --no-open\nCompare with a baseline run:\n  attest diff <base-run-id> 01ARZ3NDEKTSV4RRFFQ69G5FAV\nResult: PASS (exit 0)',
    );
    expect(harness.output.at(-1)).not.toContain('\n  attest diff\n');
  });

  it('uses all as the guided default and validates direct normalization independently', async () => {
    await expect(
      createEvalRunRequest(
        {},
        {
          interactive: true,
          prompt: () => Promise.resolve(''),
          readStdin: () => Promise.resolve(''),
          workingDirectory: process.cwd(),
        },
      ),
    ).resolves.toEqual({
      schema: COMMAND_REQUEST_SCHEMA_ID,
      command: 'eval.run',
      all: true,
      output: 'human',
    });
  });
});

describe('eval errors and no-write preflight', () => {
  it.each([
    {
      argv: ['eval', 'run', '--output', 'json'],
      code: 'cli_missing_input',
      message: 'Eval run selection is missing.',
    },
    {
      argv: ['eval', 'run', 'refund', '--all', '--output', 'json'],
      code: 'cli_usage',
      message: '`--all` conflicts with explicit test ids.',
    },
    {
      argv: ['eval', 'run', 'refund', '--watch', '--output', 'json'],
      code: 'cli_usage',
      message: '`--watch` requires human output.',
    },
  ])('emits stable $code for $message', async ({ argv, code, message }) => {
    const run = vi.fn<EvalCommandServices['run']>(() => Promise.resolve(completedEvents()));
    const harness = createHarness({ ...defaultServices(), run });
    await parse(harness, argv);

    expect(run).not.toHaveBeenCalled();
    expect(harness.exitCode()).toBe(2);
    expect(harness.errors).toEqual([]);
    expect(cliResultSchema.parse(JSON.parse(harness.output[0]!) as unknown)).toMatchObject({
      ok: false,
      command: 'eval.run',
      error: { code, message },
    });
  });

  it('reports deterministic JSON-source conflicts before dispatch', async () => {
    const run = vi.fn<EvalCommandServices['run']>(() => Promise.resolve(completedEvents()));
    const harness = createHarness({ ...defaultServices(), run });
    await parse(harness, [
      'eval',
      'run',
      'refund',
      '--from-json',
      'request.json',
      '--all',
      '--output',
      'json',
    ]);

    const failure = cliResultSchema.parse(JSON.parse(harness.output[0]!) as unknown);
    expect(failure).toMatchObject({
      ok: false,
      error: {
        code: 'cli_usage',
        details: { conflicting_fields: ['--all', '--output', '<test-id>'] },
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not create files or dispatch when validation fails', async () => {
    const root = await createTemporaryDirectory('attest-eval-no-write-');
    const run = vi.fn<EvalCommandServices['run']>(() => Promise.resolve(completedEvents()));
    const harness = createHarness({ ...defaultServices(), run }, interaction(), root);
    await parse(harness, ['eval', 'run', '--non-interactive']);

    expect(harness.exitCode()).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('uses a structured mode observed inside an invalid JSON request', async () => {
    const run = vi.fn<EvalCommandServices['run']>(() => Promise.resolve(completedEvents()));
    const harness = createHarness(
      { ...defaultServices(), run },
      interaction({
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({
              schema: COMMAND_REQUEST_SCHEMA_ID,
              command: 'eval.run',
              all: true,
              output: 'jsonl',
              watch: true,
            }),
          ),
      }),
    );
    await parse(harness, ['eval', 'run', '--from-json', '-']);

    expect(harness.output).toHaveLength(1);
    expect(evalEventStreamSchema.parse([JSON.parse(harness.output[0]!)])[0]).toMatchObject({
      sequence: 0,
      event: 'result',
      data: { exit_code: 2, result: { ok: false, command: 'eval.run' } },
    });
  });
});

describe('eval output and sequencing', () => {
  it('preserves catalog identity and retryability across human, JSON, and JSONL terminals', async () => {
    const definition = getCliErrorDefinition('run_failed');
    expect(definition).toMatchObject({ exit_code: 4, retryable: true });
    for (const output of ['human', 'json', 'jsonl'] as const) {
      const harness = createHarness({
        ...defaultServices(),
        run: () => Promise.resolve(failedEvents()),
      });
      await parse(harness, ['eval', 'run', 'refund', '--output', output]);
      expect(harness.exitCode()).toBe(definition?.exit_code);
      const serialized = [...harness.errors, ...harness.output].join('\n');
      expect(serialized).toContain('run_failed');
      if (output !== 'human') expect(serialized).toContain('"retryable":true');
    }
  });

  it('renders watch progress live only for human output and retains one final result line', async () => {
    const harness = createHarness();
    await parse(harness, ['eval', 'run', 'refund', '--watch']);

    expect(harness.errors).toEqual([]);
    expect(harness.output.slice(0, 3)).toEqual([
      `Run ${RUN_ID} started: 2 cases, concurrency 2.`,
      '[1] refund/basic started.',
      '[2] refund/delayed started.',
    ]);
    expect(harness.output.at(-1)).toContain(
      `Next:\n  attest report ${RUN_ID}\n  attest view --no-open\nCompare with a baseline run:\n  attest diff <base-run-id> ${RUN_ID}`,
    );
    expect(harness.output.at(-1)).not.toContain('\n  attest diff\n');
    expect(harness.output.at(-1)?.split('\n').at(-1)).toBe('Result: PASS (exit 0)');
  });

  it('streams validated JSONL live and preserves completion order', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async function* (): AsyncGenerator<EvalEvent> {
      const events = completedEvents();
      yield events[0]!;
      await gate;
      yield* events.slice(1);
    };
    const harness = createHarness({ ...defaultServices(), run: () => Promise.resolve(run()) });
    const parsing = parse(harness, ['eval', 'run', 'refund', '--output', 'jsonl']);

    await vi.waitFor(() => expect(harness.output).toHaveLength(1));
    release?.();
    await parsing;

    const stream = evalEventStreamSchema.parse(
      harness.output.map((line): unknown => JSON.parse(line) as unknown),
    );
    expect(stream.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      stream.filter(({ event }) => event === 'case_completed').map((event) => event.data),
    ).toMatchObject([
      { configured_index: 1, completion_index: 0 },
      { configured_index: 0, completion_index: 1 },
    ]);
    expect(stream.at(-1)).toMatchObject({ event: 'result', data: { exit_code: 0 } });
  });

  it('finishes a live JSONL prefix contiguously when its event source throws', async () => {
    const run = async function* (): AsyncGenerator<EvalEvent> {
      yield completedEvents()[0]!;
      await Promise.resolve();
      throw new Error('producer failed');
    };
    const harness = createHarness({ ...defaultServices(), run: () => Promise.resolve(run()) });

    await parse(harness, ['eval', 'run', 'refund', '--output', 'jsonl']);

    const stream = evalEventStreamSchema.parse(
      harness.output.map((line): unknown => JSON.parse(line) as unknown),
    );
    expect(stream.map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
    expect(stream.map(({ event }) => event)).toEqual(['run_started', 'run_completed', 'result']);
    expect(stream.at(-2)).toMatchObject({
      event: 'run_completed',
      data: { status: 'failed', summary: { total_cases: 2, error_cases: 2 } },
    });
    expect(stream.at(-1)).toMatchObject({ event: 'result', data: { exit_code: 4 } });
    expect(harness.exitCode()).toBe(4);
  });

  it('turns a sequence violation into one stable machine failure', async () => {
    const invalid = completedEvents();
    invalid[1] = { ...invalid[1]!, sequence: 7 };
    const harness = createHarness({
      ...defaultServices(),
      run: () => Promise.resolve(invalid),
    });
    await parse(harness, ['eval', 'run', 'refund', '--output', 'json']);

    expect(harness.exitCode()).toBe(4);
    expect(harness.output).toHaveLength(1);
    expect(cliResultSchema.parse(JSON.parse(harness.output[0]!) as unknown)).toMatchObject({
      ok: false,
      command: 'eval.run',
      error: { code: 'run_failed', path: '/events/1/sequence' },
    });
  });
});

describe('eval cancellation command', () => {
  it('normalizes the run id and emits the frozen JSON cancellation result', async () => {
    const cancel = vi.fn<EvalCommandServices['cancel']>(() =>
      Promise.resolve(cancellationSuccess()),
    );
    const harness = createHarness({ ...defaultServices(), cancel });
    await parse(harness, ['eval', 'cancel', RUN_ID, '--project', '/tmp/demo', '--output', 'json']);

    expect(cancel).toHaveBeenCalledWith(
      {
        schema: COMMAND_REQUEST_SCHEMA_ID,
        command: 'eval.cancel',
        run_id: RUN_ID,
        output: 'json',
      },
      { project: '/tmp/demo', workingDirectory: process.cwd() },
    );
    expect(evalCancelResultSchema.parse(JSON.parse(harness.output[0]!) as unknown)).toEqual(
      cancellationSuccess(),
    );
    expect(harness.exitCode()).toBe(0);
  });

  it('accepts one complete cancellation request from JSON', async () => {
    const root = await createTemporaryDirectory('attest-eval-cancel-json-');
    await writeFile(
      join(root, 'cancel.json'),
      JSON.stringify({
        schema: COMMAND_REQUEST_SCHEMA_ID,
        command: 'eval.cancel',
        run_id: RUN_ID,
        output: 'human',
      }),
    );
    const cancel = vi.fn<EvalCommandServices['cancel']>(() =>
      Promise.resolve(cancellationSuccess()),
    );
    const harness = createHarness({ ...defaultServices(), cancel }, interaction(), root);
    await parse(harness, ['eval', 'cancel', '--from-json', 'cancel.json']);

    expect(cancel.mock.calls[0]?.[0]).toMatchObject({ command: 'eval.cancel', run_id: RUN_ID });
    expect(harness.output).toEqual([`Run ${RUN_ID}: cancellation requested.`]);
  });

  it('rejects missing and overlapping run ids before cancellation dispatch', async () => {
    const cancel = vi.fn<EvalCommandServices['cancel']>(() =>
      Promise.resolve(cancellationSuccess()),
    );
    const missing = createHarness({ ...defaultServices(), cancel });
    await parse(missing, ['eval', 'cancel', '--output', 'json']);
    expect(missing.exitCode()).toBe(2);
    expect(cliResultSchema.parse(JSON.parse(missing.output[0]!) as unknown)).toMatchObject({
      error: { code: 'cli_missing_input' },
    });

    const overlapping = createHarness({ ...defaultServices(), cancel });
    await parse(overlapping, [
      'eval',
      'cancel',
      RUN_ID,
      '--from-json',
      'cancel.json',
      '--output',
      'json',
    ]);
    expect(cliResultSchema.parse(JSON.parse(overlapping.output[0]!) as unknown)).toMatchObject({
      error: {
        code: 'cli_usage',
        details: { conflicting_fields: ['--output', '<run-id>'] },
      },
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('eval command grammar and terminal behavior', () => {
  it('publishes structured help metadata without registering a top-level run alias', () => {
    const harness = createHarness();
    const help = createCliHelp(harness.program, ['eval', 'run']);

    expect(harness.program.commands.map((command) => command.name())).toEqual(['eval']);
    expect(harness.program.commands.some((command) => command.name() === 'run')).toBe(false);
    expect(help.command).toMatchObject({
      path: ['eval', 'run'],
      request_schema: COMMAND_REQUEST_SCHEMA_ID,
      arguments: [{ name: 'test-id', variadic: true, required: false }],
    });
    expect(help.command.options.find(({ name }) => name === 'case')).toMatchObject({
      repeatable: true,
      conflicts: ['from-json'],
    });
    expect(help.command.options.find(({ name }) => name === 'watch')?.conflicts).toEqual([
      'from-json',
      'output=json',
      'output=jsonl',
    ]);
    expect(help.command.constraints).toContain('--watch is available only with human output.');
  });

  it('returns 130 and restores terminal modes after SIGINT in the real wizard PTY', async () => {
    const { stderr, stdout } = await execFileAsync('python3', [PTY_DRIVER, 'bun', PTY_CHILD], {
      timeout: 20_000,
    });
    expect(stderr).toBe('');
    const evidence = JSON.parse(stdout) as {
      exit_code: number;
      output: string;
      prompt_seen: boolean;
      run_seen: boolean;
      terminal_restored: boolean;
    };
    expect(evidence).toMatchObject({
      exit_code: 130,
      prompt_seen: true,
      run_seen: true,
      terminal_restored: true,
    });
    expect(evidence.output).toContain('Result: CANCELLED (exit 130)');
  });
});
