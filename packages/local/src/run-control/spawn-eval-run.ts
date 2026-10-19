import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { evalEventSchema, type EvalRunRequest } from '@attest/contracts';
import { StoreError } from '@attest/core';
import type { CliDiagnostics } from '@attest/core/records';

/** How to invoke the attest CLI: the executable and the arguments that come before `eval run`. */
type CliCommand = { command: string; args: readonly string[] };

type SpawnEvalRunOptions = {
  command: CliCommand;
  projectRoot: string;
  document: EvalRunRequest;
};

type ProcessEnd = { exitCode: number | null; signal: NodeJS.Signals | null } | { error: Error };

type OutputLine =
  | { kind: 'started'; runId: string }
  | { kind: 'failed'; diagnostics: CliDiagnostics }
  | { kind: 'event' }
  | { kind: 'text' };

const POLL_INTERVAL_MS = 25;

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
    const message = `Could not run ${command.command}: ${end.error.message}`;

    return new StoreError('RUN_START_FAILED', message, {
      cause: end.error,
      details: { code: 'run_failed', message },
    });
  }

  const status = end.signal === null ? `code ${String(end.exitCode)}` : `signal ${end.signal}`;
  const message = `The attest CLI exited with ${status} before the run started.`;

  // The output can hold stacks and paths; it goes to the diagnostics, never into the message.
  return new StoreError('RUN_START_FAILED', message, {
    details: { code: 'run_failed', message, details: { output: [...tail] } },
  });
};

/** Must be called right after spawn: a spawn failure is emitted on the next tick. */
const watchEnd = (child: ChildProcess): Promise<ProcessEnd> =>
  new Promise((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    child.once('error', (error) => resolve({ error }));
  });

type AwaitRunStartedOptions = {
  child: ChildProcess;
  command: CliCommand;
  ended: Promise<ProcessEnd>;
  log: FileHandle;
};

/**
 * Follows the child's output until it reports `run_started` or exits. After the start the child
 * is released: it writes the rest of its output to a file nobody reads and outlives the server.
 */
const awaitRunStarted = async ({
  child,
  command,
  ended,
  log,
}: AwaitRunStartedOptions): Promise<{ runId: string }> => {
  const reader = createOutputReader(log);
  let failure: CliDiagnostics | undefined;
  let tail: string[] = [];

  for (;;) {
    const end = await Promise.race([ended, delay(POLL_INTERVAL_MS).then(() => undefined)]);
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
  }
};

/**
 * Starts `attest eval run` in the project as a detached process with the server's environment
 * and resolves with the run id once the CLI has recorded the run. The CLI keeps ownership of
 * validation, signals, exit codes and the cancellation registry. Its output goes to an unlinked
 * temporary file rather than a pipe: a Node CLI dies of EPIPE when the reader of its stdout goes
 * away, and the run must survive the dashboard closing.
 */
const spawnEvalRun = async ({
  command,
  projectRoot,
  document,
}: SpawnEvalRunOptions): Promise<{ runId: string }> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-run-start-'));

  try {
    const log = await open(join(directory, 'output.log'), 'w+', 0o600);

    try {
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

      const ended = watchEnd(child);

      // The child holds its own descriptor, so the file can go now; the server keeps `log` open.
      await rm(directory, { recursive: true, force: true });
      // A CLI that exits before reading its request breaks this pipe; its exit says why.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(`${JSON.stringify(document)}\n`);

      return await awaitRunStarted({ child, command, ended, log });
    } finally {
      await log.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export { spawnEvalRun, type CliCommand };
