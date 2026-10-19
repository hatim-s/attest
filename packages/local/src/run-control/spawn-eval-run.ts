import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { evalEventSchema, type EvalRunRequest } from '@attest/contracts';
import { StoreError } from '@attest/core';
import type { CliDiagnostics } from '@attest/core/records';
import { killProcessTree } from '@attest/executor';

/** How to invoke the attest CLI: the executable and the arguments that come before `eval run`. */
type CliCommand = { command: string; args: readonly string[] };

type SpawnEvalRunOptions = {
  command: CliCommand;
  projectRoot: string;
  document: EvalRunRequest;
  /** How long the CLI has to report `run_started`; the launcher always passes START_TIMEOUT_MS. */
  startTimeoutMs: number;
};

type ProcessEnd = { exitCode: number | null; signal: NodeJS.Signals | null } | { error: Error };

type OutputLine =
  | { kind: 'started'; runId: string }
  | { kind: 'failed'; diagnostics: CliDiagnostics }
  | { kind: 'event' }
  | { kind: 'text' };

const POLL_INTERVAL_MS = 25;

/**
 * Everything before `run_started` is bounded: project load, git metadata, the store and journal
 * recovery. No hook or agent runs before it, so a start that takes a minute is stuck.
 */
const START_TIMEOUT_MS = 60_000;

/** How long a stopped CLI gets to finalize after SIGTERM before its group is killed. */
const STOP_GRACE_MS = 5_000;

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * A longer unterminated line is cut here and read as text. The CLI's events are far smaller, so
 * only output that could not be an event is cut, and a child that never ends a line stays bounded.
 */
const MAX_LINE_CHARACTERS = 64 * 1024;

/** The unstructured output kept to explain a CLI that crashed before reporting anything. */
const OUTPUT_TAIL_LINES = 32;

const OUTPUT_TAIL_CHARACTERS = 16 * 1024;

/** Keeps the last lines of output within both limits; a single long line keeps its end. */
const appendToTail = (tail: readonly string[], line: string): string[] => {
  const kept = [...tail, line.slice(-OUTPUT_TAIL_CHARACTERS)].slice(-OUTPUT_TAIL_LINES);
  let characters = kept.reduce((total, entry) => total + entry.length, 0);

  while (characters > OUTPUT_TAIL_CHARACTERS) characters -= kept.shift()?.length ?? 0;

  return kept;
};

/** Parses one line of the child's output; anything outside the eval event vocabulary is text. */
const classifyLine = (line: string): OutputLine => {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'text' };
  }

  const parsed = evalEventSchema.safeParse(value);

  if (!parsed.success) return { kind: 'text' };

  const event = parsed.data;

  if (event.event === 'run_started') return { kind: 'started', runId: event.data.run_id };

  if (event.event !== 'result' || event.data.result.ok) return { kind: 'event' };

  return { kind: 'failed', diagnostics: event.data.result.error };
};

/** Reads what the child appended to its output file since the previous read, one line at a time. */
const createOutputReader = (log: FileHandle) => {
  const decoder = new TextDecoder();
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  let position = 0;
  let pending = '';

  return {
    readLines: async (): Promise<string[]> => {
      const lines: string[] = [];

      for (;;) {
        const { bytesRead } = await log.read(buffer, 0, buffer.length, position);

        if (bytesRead === 0) return lines;

        position += bytesRead;
        pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        lines.push(...parts);

        if (pending.length > MAX_LINE_CHARACTERS) {
          lines.push(pending);
          pending = '';
        }
      }
    },
    /** The unterminated last line, once the child has exited and will write no more. */
    rest: (): string => pending + decoder.decode(),
  };
};

/** Why the launcher stopped following a CLI that was still running. */
type StopReason = { kind: 'timeout'; startTimeoutMs: number } | { kind: 'stdin'; error: Error };

const runFailed = (
  message: string,
  tail: readonly string[],
  options: { cause?: Error; hint?: string } = {},
): StoreError =>
  // The output can hold stacks and paths; it goes to the diagnostics, never into the message.
  new StoreError('RUN_START_FAILED', message, {
    cause: options.cause,
    details: { code: 'run_failed', message, hint: options.hint, details: { output: [...tail] } },
  });

const startFailure = (
  command: CliCommand,
  end: ProcessEnd,
  failure: CliDiagnostics | undefined,
  tail: readonly string[],
): StoreError => {
  if (failure !== undefined) {
    return new StoreError('RUN_START_FAILED', failure.message, { details: failure });
  }

  if ('error' in end) {
    return runFailed(`Could not run ${command.command}: ${end.error.message}`, tail, {
      cause: end.error,
    });
  }

  const status = end.signal === null ? `code ${String(end.exitCode)}` : `signal ${end.signal}`;

  return runFailed(`The attest CLI exited with ${status} before the run started.`, tail);
};

const stopFailure = (reason: StopReason, tail: readonly string[]): StoreError =>
  reason.kind === 'timeout'
    ? runFailed(
        `The attest CLI did not report run_started within ${String(reason.startTimeoutMs / 1000)}s.`,
        tail,
        { hint: 'Run attest eval run from a terminal in the project to see where it stops.' },
      )
    : runFailed(`Could not send the run request to the attest CLI: ${reason.error.message}`, tail, {
        cause: reason.error,
      });

/** What has happened to the child so far; the launcher polls it with the output. */
type ChildState = { end: ProcessEnd | undefined; stdinError: Error | undefined };

/** Must be called right after spawn: a spawn failure is emitted on the next tick. */
const watchChild = (child: ChildProcess): ChildState => {
  const state: ChildState = { end: undefined, stdinError: undefined };

  child.once('exit', (exitCode, signal) => {
    state.end = { exitCode, signal };
  });
  child.once('error', (error) => {
    state.end = { error };
  });
  child.stdin?.on('error', (error) => {
    state.stdinError = error;
  });

  return state;
};

type AwaitRunStartedOptions = {
  child: ChildProcess;
  command: CliCommand;
  state: ChildState;
  log: FileHandle;
  startTimeoutMs: number;
};

/**
 * Follows the child's output until it reports `run_started`, exits, misses the start deadline or
 * cannot take its request. After the start the child is released: it writes the rest of its
 * output to a file nobody reads and outlives the server. Every other outcome throws, and the
 * caller stops a child that is still running.
 */
const awaitRunStarted = async ({
  child,
  command,
  state,
  log,
  startTimeoutMs,
}: AwaitRunStartedOptions): Promise<{ runId: string }> => {
  const reader = createOutputReader(log);
  const startDeadline = Date.now() + startTimeoutMs;
  let stdinDeadline: number | undefined;
  let failure: CliDiagnostics | undefined;
  let tail: string[] = [];

  for (;;) {
    await delay(POLL_INTERVAL_MS);
    // Taken before the read, so the read after an exit sees everything the child wrote.
    const end = state.end;
    const lines = await reader.readLines();

    // Read once more after the exit so the last, possibly unterminated, line is not lost.
    if (end !== undefined) lines.push(reader.rest());

    for (const line of lines) {
      const output = classifyLine(line);

      if (output.kind === 'started') {
        child.stdin?.destroy();
        child.unref();

        return { runId: output.runId };
      }

      if (output.kind === 'failed') failure = output.diagnostics;

      if (output.kind === 'text' && line.trim() !== '') tail = appendToTail(tail, line);
    }

    if (end !== undefined) throw startFailure(command, end, failure, tail);

    if (Date.now() >= startDeadline) throw stopFailure({ kind: 'timeout', startTimeoutMs }, tail);

    if (state.stdinError !== undefined) {
      // A CLI that exits before reading its request breaks the pipe, and its exit says why, so
      // the child gets a grace period to exit before the broken pipe is the reason.
      stdinDeadline ??= Date.now() + STOP_GRACE_MS;

      if (Date.now() >= stdinDeadline) {
        throw stopFailure({ kind: 'stdin', error: state.stdinError }, tail);
      }
    }
  }
};

/**
 * Starts `attest eval run` in the project as a detached process with the server's environment
 * and resolves with the run id once the CLI has recorded the run. The CLI keeps ownership of
 * validation, signals, exit codes and the cancellation registry. Its output goes to an unlinked
 * temporary file rather than a pipe: a Node CLI dies of EPIPE when the reader of its stdout goes
 * away, and the run must survive the dashboard closing. The file stays on disk, unnamed, until
 * the run exits.
 */
const spawnEvalRun = async ({
  command,
  projectRoot,
  document,
  startTimeoutMs,
}: SpawnEvalRunOptions): Promise<{ runId: string }> => {
  const path = join(tmpdir(), `attest-run-start-${randomUUID()}.log`);
  const log = await open(path, 'wx+', 0o600);

  try {
    // The child inherits the descriptor, not the name, so the name can go before it starts.
    await unlink(path);

    const child = spawn(
      command.command,
      [
        ...command.args,
        'eval',
        'run',
        '--project',
        projectRoot,
        '--non-interactive',
        '--from-json',
        '-',
      ],
      { cwd: projectRoot, env: process.env, detached: true, stdio: ['pipe', log.fd, log.fd] },
    );

    const state = watchChild(child);
    child.stdin?.end(`${JSON.stringify(document)}\n`);

    try {
      return await awaitRunStarted({ child, command, state, log, startTimeoutMs });
    } catch (error: unknown) {
      // SIGTERM lets the CLI finalize what it recorded; the group is killed after the grace.
      if (child.exitCode === null && child.signalCode === null) {
        await killProcessTree(child, { graceMs: STOP_GRACE_MS, signalProcessGroup: true });
      }

      throw error;
    }
  } finally {
    await log.close();
  }
};

export { spawnEvalRun, START_TIMEOUT_MS, type CliCommand };
