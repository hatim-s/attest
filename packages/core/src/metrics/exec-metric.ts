import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  parseMetricResult,
  type ContractIssue,
  type MetricDefinition,
  type MetricResult,
} from '@attest/contracts';

import type { MetricContext, MetricErrorInfo, MetricEvaluation } from './metric-evaluation.js';
import { buildMetricRequest } from './internal/metric-request.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAXIMUM_STDOUT_BYTES = 1024 * 1024;
const MAXIMUM_STDERR_BYTES = 4 * 1024;
const PROCESS_KILL_GRACE_MS = 2_000;

/** Narrows the shared metric contract to executable definitions accepted by this runner edge. */
type ExecutableMetricDefinition = Extract<MetricDefinition, { type: 'exec' }>;

/** Lets callers bound metric work or stop it alongside the enclosing run. */
type ExecuteMetricOptions = { timeoutMs?: number; signal?: AbortSignal };

type InvocationOutcome = { ok: true; text: string } | { ok: false; error: MetricErrorInfo };

/** Appends only the remaining diagnostic capacity so a single stderr chunk cannot bypass its cap. */
const appendExcerpt = (value: string, chunk: Buffer, maximumBytes: number): string => {
  const remainingBytes = maximumBytes - Buffer.byteLength(value);
  if (remainingBytes <= 0) {
    return value;
  }

  return `${value}${chunk.subarray(0, remainingBytes).toString()}`;
};

/** Produces the result union used by every exit path, preserving metric errors apart from failing scores. */
const metricError = (
  definition: ExecutableMetricDefinition,
  error: MetricErrorInfo,
  durationMs: number,
): MetricEvaluation => ({
  metricName: definition.name,
  kind: 'exec',
  status: 'error',
  error,
  durationMs,
});

/** Makes parser diagnostics renderable and diffable without relying on Zod's internal issue objects. */
const contractIssueDetails = (issues: ContractIssue[]): MetricErrorInfo['details'] => ({
  issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
});

/** Parses one transport body into the contract result, turning protocol violations into metric errors. */
const parseInvocationResult = (text: string): MetricResult | MetricErrorInfo => {
  let candidate: unknown;

  try {
    candidate = JSON.parse(text);
  } catch (error: unknown) {
    return {
      code: 'exec_malformed_output',
      message: `Metric output was not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }

  const parsed = parseMetricResult(candidate);
  if (!parsed.ok) {
    return {
      code: 'exec_malformed_output',
      message: 'Metric output did not match the result contract.',
      details: contractIssueDetails(parsed.error),
    };
  }

  return parsed.value;
};

/** Ends the full detached process group because the metric command may have forked children. */
const terminateProcessGroup = (processIdentifier: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-processIdentifier, signal);
  } catch {
    // The group can already have exited between the timeout and this cleanup attempt.
  }
};

/** Invokes a CLI metric while enforcing the output cap and owning its complete process lifecycle. */
const invokeCommandMetric = (
  definition: ExecutableMetricDefinition & { command: string[] },
  requestBody: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<InvocationOutcome> =>
  new Promise((resolve) => {
    const [command, ...arguments_] = definition.command;
    if (command === undefined) {
      resolve({
        ok: false,
        error: { code: 'exec_spawn_failed', message: 'Metric command was unexpectedly empty.' },
      });
      return;
    }
    const child = spawn(command, arguments_, { detached: true });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => terminate(false), timeoutMs);

    const settle = (outcome: InvocationOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined && outcome.ok) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener('abort', abort);
      resolve(outcome);
    };

    const terminate = (cancelled: boolean): void => {
      // Signal the process group, not just its leader: children may fork and otherwise survive the run.
      terminateProcessGroup(child.pid!, 'SIGTERM');
      killTimer = setTimeout(
        () => terminateProcessGroup(child.pid!, 'SIGKILL'),
        PROCESS_KILL_GRACE_MS,
      );
      settle({
        ok: false,
        error: {
          code: 'exec_timeout',
          message: cancelled
            ? 'Metric execution was cancelled.'
            : `Metric execution exceeded ${timeoutMs} ms.`,
        },
      });
    };

    const abort = (): void => terminate(true);

    child.once('error', (error) => {
      settle({
        ok: false,
        error: {
          code: 'exec_spawn_failed',
          message: `Could not start metric command: ${error.message}`,
        },
      });
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAXIMUM_STDOUT_BYTES) {
        // A runaway writer can have children too, so apply the same group cleanup as a deadline.
        terminateProcessGroup(child.pid!, 'SIGTERM');
        killTimer = setTimeout(
          () => terminateProcessGroup(child.pid!, 'SIGKILL'),
          PROCESS_KILL_GRACE_MS,
        );
        settle({
          ok: false,
          error: {
            code: 'exec_malformed_output',
            message: `Metric stdout exceeded the ${MAXIMUM_STDOUT_BYTES}-byte limit.`,
          },
        });
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendExcerpt(stderr, chunk, MAXIMUM_STDERR_BYTES);
    });
    child.once('close', (exitCode) => {
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

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(requestBody);
  });

/** Posts a metric envelope through the web-compatible HTTP boundary with a composed cancellation deadline. */
const invokeHttpMetric = async (
  definition: ExecutableMetricDefinition & { url: string },
  requestBody: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<InvocationOutcome> => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const composedSignal =
    signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, signal]);

  try {
    const response = await fetch(definition.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
      signal: composedSignal,
    });
    if (response.status !== 200) {
      return {
        ok: false,
        error: {
          code: 'http_bad_status',
          message: `Metric HTTP endpoint returned ${response.status}, expected 200.`,
          details: { status: response.status },
        },
      };
    }

    return { ok: true, text: await response.text() };
  } catch (error: unknown) {
    if (composedSignal.aborted) {
      return {
        ok: false,
        error: {
          code: 'exec_timeout',
          message: signal?.aborted
            ? 'Metric execution was cancelled.'
            : `Metric execution exceeded ${timeoutMs} ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'http_request_failed',
        message: `Could not call metric HTTP endpoint: ${error instanceof Error ? error.message : 'unknown error'}`,
      },
    };
  }
};

/**
 * Runs one executable metric (CLI command or HTTP POST) and normalizes to a MetricEvaluation.
 * Invocation faults remain runner diagnostics so a metric never masquerades as a genuine failing score.
 */
const executeExecutableMetric = async (
  definition: ExecutableMetricDefinition,
  context: MetricContext,
  options: ExecuteMetricOptions = {},
): Promise<MetricEvaluation> => {
  const startedAt = performance.now();
  if (context.execution.outcome !== 'completed') {
    return metricError(
      definition,
      {
        code: 'skipped_no_output',
        message: 'Metric was not invoked because the case execution produced no completed output.',
      },
      performance.now() - startedAt,
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (options.signal?.aborted) {
    return metricError(
      definition,
      { code: 'exec_timeout', message: 'Metric execution was cancelled.' },
      performance.now() - startedAt,
    );
  }
  const requestBody = JSON.stringify(buildMetricRequest(context));
  const outcome =
    'command' in definition
      ? await invokeCommandMetric(definition, requestBody, timeoutMs, options.signal)
      : await invokeHttpMetric(definition, requestBody, timeoutMs, options.signal);
  const result = outcome.ok ? parseInvocationResult(outcome.text) : outcome.error;
  const durationMs = performance.now() - startedAt;

  if ('code' in result) {
    return metricError(definition, result, durationMs);
  }

  return {
    metricName: definition.name,
    kind: 'exec',
    status: 'evaluated',
    result,
    durationMs,
  };
};

export { executeExecutableMetric, type ExecutableMetricDefinition, type ExecuteMetricOptions };
