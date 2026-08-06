import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { MetricDefinition } from '@attest/contracts';

import type { MetricErrorInfo } from '../metric-evaluation.js';
import { createAbortContext } from './abort-context.js';

const MAXIMUM_STDERR_BYTES = 4 * 1024;
const PROCESS_KILL_GRACE_MS = 2_000;
const PROCESS_REAP_WAIT_MS = 5_000;

/** Narrows executable metric definitions to the command transport. */
type CommandMetricDefinition = Extract<MetricDefinition, { type: 'exec' }> & {
  command: string[];
};

/** Describes the limits and cancellation channel owned by one command invocation. */
type InvokeCommandMetricOptions = {
  outputCapBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
};

/** Keeps transport errors separate from successful response text. */
type CommandInvocationOutcome = { ok: true; text: string } | { ok: false; error: MetricErrorInfo };

/** Selects the stable error returned after a forced process shutdown. */
type TerminationReason = 'timeout' | 'cancelled' | 'output_cap';

/** Configures the two bounded phases of detached process-group shutdown. */
type KillProcessGroupOptions = { graceMs: number; reapWaitMs: number };

/** Appends only the remaining diagnostic capacity so a single stderr chunk cannot bypass its cap. */
const appendExcerpt = (value: string, chunk: Buffer, maximumBytes: number): string => {
  const remainingBytes = maximumBytes - Buffer.byteLength(value);
  if (remainingBytes <= 0) {
    return value;
  }

  return `${value}${chunk.subarray(0, remainingBytes).toString()}`;
};

/** Signals a detached process group while tolerating a group that already exited. */
const signalProcessGroup = (processIdentifier: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-processIdentifier, signal);
  } catch {
    // Exit can race any signal; the subsequent child exit check decides whether it was reaped.
  }
};

/** Waits for Node to observe the direct child's exit, bounded so a broken platform cannot hang a run. */
const waitForChildExit = (
  child: ChildProcessWithoutNullStreams,
  waitMs: number,
): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', exitedChild);
      resolve(exited);
    };
    const exitedChild = (): void => finish(true);
    const timer = setTimeout(() => finish(false), waitMs);
    child.once('exit', exitedChild);
  });
};

/**
 * Terminates a detached process group, escalates after a grace period, and awaits direct-child reaping.
 * Descendants that create a new process group can escape this POSIX best-effort boundary; complete
 * containment requires the runner's process-tree snapshot and will be unified at the integration gate.
 */
const killProcessGroupWithGrace = async (
  child: ChildProcessWithoutNullStreams,
  options: KillProcessGroupOptions,
): Promise<boolean> => {
  const processIdentifier = child.pid;
  if (processIdentifier === undefined) {
    return false;
  }

  signalProcessGroup(processIdentifier, 'SIGTERM');
  if (await waitForChildExit(child, options.graceMs)) {
    return true;
  }

  signalProcessGroup(processIdentifier, 'SIGKILL');
  return waitForChildExit(child, options.reapWaitMs);
};

/** Builds the metric error that is returned only after termination and bounded reaping complete. */
const terminationError = (
  reason: TerminationReason,
  options: InvokeCommandMetricOptions,
  reaped: boolean,
): MetricErrorInfo => {
  const error: MetricErrorInfo =
    reason === 'timeout'
      ? {
          code: 'exec_timeout',
          message: `Metric execution exceeded ${options.timeoutMs} ms.`,
        }
      : reason === 'cancelled'
        ? { code: 'metric_cancelled', message: 'Metric execution was cancelled.' }
        : {
            code: 'exec_malformed_output',
            message: `Metric stdout exceeded the ${options.outputCapBytes}-byte limit.`,
          };

  if (reaped) {
    return error;
  }

  // A bounded wait prevents a platform-level waitpid failure from hanging the complete evaluation run.
  return { ...error, message: `${error.message} process may be unreaped.` };
};

/** Invokes a CLI metric while enforcing its byte cap and owning the complete child lifecycle. */
const invokeCommandMetric = (
  definition: CommandMetricDefinition,
  requestBody: string,
  options: InvokeCommandMetricOptions,
): Promise<CommandInvocationOutcome> =>
  new Promise((resolve) => {
    const [command, ...commandArguments] = definition.command;
    if (command === undefined) {
      resolve({
        ok: false,
        error: { code: 'exec_spawn_failed', message: 'Metric command was unexpectedly empty.' },
      });
      return;
    }

    const child = spawn(command, commandArguments, { detached: true });
    const abortContext = createAbortContext({
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      timeoutMessage: `Metric execution exceeded ${options.timeoutMs} ms.`,
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    let terminationReason: TerminationReason | undefined;

    const settle = (outcome: CommandInvocationOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      abortContext.controller.signal.removeEventListener('abort', abort);
      abortContext.dispose();
      resolve(outcome);
    };

    function terminate(reason: TerminationReason): void {
      if (settled || terminationReason !== undefined) {
        return;
      }
      terminationReason = reason;
      killProcessGroupWithGrace(child, {
        graceMs: PROCESS_KILL_GRACE_MS,
        reapWaitMs: PROCESS_REAP_WAIT_MS,
      }).then(
        (reaped) => settle({ ok: false, error: terminationError(reason, options, reaped) }),
        (error: unknown) => {
          const cleanupError = terminationError(reason, options, false);
          settle({
            ok: false,
            error: {
              ...cleanupError,
              message: `${cleanupError.message} Cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
            },
          });
        },
      );
    }

    function abort(): void {
      terminate(abortContext.reason() ?? 'cancelled');
    }

    child.once('error', (error) => {
      settle({
        ok: false,
        error: {
          code: 'exec_spawn_failed',
          message: `Could not start metric command: ${error.message}`,
        },
      });
    });
    const processIdentifier = child.pid;
    if (processIdentifier === undefined) {
      settle({
        ok: false,
        error: {
          code: 'exec_spawn_failed',
          message:
            'Could not start metric command because no child process identifier was assigned.',
        },
      });
      return;
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (terminationReason !== undefined) {
        return;
      }
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.outputCapBytes) {
        terminate('output_cap');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendExcerpt(stderr, chunk, MAXIMUM_STDERR_BYTES);
    });
    child.once('close', (exitCode) => {
      if (terminationReason !== undefined) {
        return;
      }
      if (exitCode !== 0) {
        settle({
          ok: false,
          error: {
            code: 'exec_nonzero_exit',
            message: `Metric command exited with code ${exitCode ?? 'unknown'}.`,
            ...(stderr.length === 0 ? {} : { details: { stderr } }),
          },
        });
        return;
      }
      settle({ ok: true, text: Buffer.concat(stdoutChunks).toString() });
    });

    abortContext.controller.signal.addEventListener('abort', abort, { once: true });
    if (abortContext.controller.signal.aborted) {
      abort();
      return;
    }
    child.stdin.end(requestBody);
  });

export {
  invokeCommandMetric,
  killProcessGroupWithGrace,
  type CommandInvocationOutcome,
  type CommandMetricDefinition,
  type InvokeCommandMetricOptions,
  type KillProcessGroupOptions,
  type TerminationReason,
};
