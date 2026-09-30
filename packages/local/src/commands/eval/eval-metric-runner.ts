import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  METRIC_PROTOCOL,
  type AgentRequest,
  type AgentResource,
  type MetricDefinition,
  type MetricResource,
} from '@attest/contracts';
import { type CacheStore } from '@attest/core';
import { invokeMappedHttpAgent, type CaseExecution } from '@attest/executor';
import {
  caseExecutionToMetricContext,
  createTanstackJudgeClient,
  evaluateMetrics,
  type JudgeCache,
  type JudgeCacheEntry,
  type MetricContext,
  type MetricEvaluation,
} from '@attest/runtime';
import { z } from 'zod';

import { LocalError } from '../../errors/index.js';
import { readJsonPointer } from '../../internal/json-pointer.js';
import { isProjectPath } from '../../project/project-path.js';
import {
  redactMetricEvaluation,
  resolveNativeAgent,
  resolveProcessEnvironment,
} from '../agent/native-agent-adapter/index.js';
import type { ResolvedEvalCaseInput, ResolvedEvalMetric } from './eval-resolver.js';

/** Adapts the shared SQLite response cache to the judge metric cache contract. */
const createJudgeCache = (cacheStore: CacheStore): JudgeCache => ({
  get: async (key) => (await cacheStore.get('judge', key)) as JudgeCacheEntry | undefined,
  set: (key, entry) => cacheStore.put('judge', key, entry),
});

/** Resolves one executable metric environment at invocation time without persisting secret values. */
const resolveExecutableMetric = async (
  metric: Extract<MetricResource['definition'], { kind: 'exec' }>,
  projectRoot: string,
): Promise<{ cwd: string; env: NodeJS.ProcessEnv; secrets: string[] }> => {
  const cwd = await realpath(resolve(projectRoot, metric.cwd ?? '.'));
  if (!isProjectPath(projectRoot, cwd)) {
    throw new LocalError('metric_infrastructure_failed', 'Metric cwd escapes the project.', {
      path: metric.cwd ?? '.',
    });
  }
  const { env, secrets } = await resolveProcessEnvironment(metric.env, projectRoot);
  return { cwd, env, secrets };
};

/** Converts a HTTP metric response mapping into the existing metric result evidence shape. */
const extractHttpMetricResult = (
  metricId: string,
  definition: Extract<MetricResource['definition'], { kind: 'http' }>,
  value: unknown,
  durationMs: number,
): MetricEvaluation => {
  const score = readJsonPointer(value, definition.extraction.score_pointer);
  const pass = readJsonPointer(value, definition.extraction.pass_pointer);
  const rationale =
    definition.extraction.rationale_pointer === undefined
      ? undefined
      : readJsonPointer(value, definition.extraction.rationale_pointer);
  const rawDetails =
    definition.extraction.details_pointer === undefined
      ? undefined
      : readJsonPointer(value, definition.extraction.details_pointer);
  const details = rawDetails === undefined ? undefined : z.json().safeParse(rawDetails);
  // Runtime's MetricEvaluation has no HTTP kind; an HTTP metric reports like an exec metric
  // because both return a score and pass result from outside the process.
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    typeof pass !== 'boolean' ||
    (rationale !== undefined && typeof rationale !== 'string') ||
    details?.success === false
  ) {
    return {
      metricName: metricId,
      kind: 'exec',
      status: 'error',
      error: {
        code: 'exec_malformed_output',
        message: 'HTTP metric extraction did not produce a finite score and boolean pass result.',
      },
      durationMs,
    };
  }
  return {
    metricName: metricId,
    kind: 'exec',
    status: 'evaluated',
    result: {
      score,
      pass,
      ...(rationale === undefined ? {} : { rationale }),
      ...(details?.success === true ? { details: details.data } : {}),
    },
    durationMs,
  };
};

/** Executes one mapped HTTP metric through the hardened existing HTTP agent adapter. */
const evaluateHttpMetric = async (
  metric: ResolvedEvalMetric,
  context: MetricContext,
  request: AgentRequest,
  projectRoot: string,
  signal: AbortSignal,
): Promise<MetricEvaluation> => {
  const definition = metric.metric.definition;
  if (definition.kind !== 'http') throw new Error('Expected an HTTP metric definition.');
  if (context.execution.outcome !== 'completed') {
    return (
      await evaluateMetrics(
        [{ name: metric.metric.id, type: 'exec', url: definition.request.url }],
        context,
      )
    )[0]!;
  }
  // Trace extensions are intentionally open, so validate their JSON shape at the HTTP boundary.
  const metricRequest = z.json().parse({
    protocol: METRIC_PROTOCOL,
    case: context.caseDefinition,
    output: context.execution.output,
    trace: context.execution.trace,
  });
  const syntheticAgent: AgentResource = {
    schema: AGENT_RESOURCE_SCHEMA_ID,
    id: metric.metric.id,
    name: metric.metric.name,
    transport: {
      kind: 'http',
      lifecycle: 'external',
      response_mode: 'mapped',
      request: {
        ...definition.request,
        // With no authored mapping, send the native metric envelope as the JSON body.
        body: definition.request.body ?? '{{input}}',
      },
      extraction: { result_pointer: '' },
    },
    ...(definition.timeout_ms === undefined
      ? {}
      : { timeouts: { attempt_ms: definition.timeout_ms } }),
    ...(definition.retry === undefined ? {} : { retry: definition.retry }),
  };
  const resolved = await resolveNativeAgent(syntheticAgent, projectRoot);
  if (resolved.kind !== 'mapped_http') {
    throw new Error('HTTP metric adapter was not resolved.');
  }
  const startedAt = performance.now();
  const invocation = await invokeMappedHttpAgent(
    resolved.agent,
    { ...request, input: metricRequest },
    {
      headers: resolved.headers,
      query: resolved.query,
      secrets: resolved.secrets,
      signal,
    },
  );
  const durationMs = performance.now() - startedAt;
  if (invocation.status === 'invocation_error') {
    return redactMetricEvaluation(
      {
        metricName: metric.metric.id,
        kind: 'exec',
        status: 'error',
        error: {
          code: invocation.error.code === 'timeout' ? 'exec_timeout' : 'http_request_failed',
          message: invocation.error.message,
        },
        durationMs,
      },
      resolved.secrets,
    );
  }
  const response = invocation.report?.ok === true ? invocation.report.value : undefined;
  return redactMetricEvaluation(
    extractHttpMetricResult(
      metric.metric.id,
      definition,
      response !== undefined && 'output' in response ? response.output : undefined,
      durationMs,
    ),
    resolved.secrets,
  );
};

const applyAttachedThreshold = (
  evaluation: MetricEvaluation,
  threshold: number | undefined,
): MetricEvaluation =>
  threshold === undefined || evaluation.status === 'error'
    ? evaluation
    : {
        ...evaluation,
        result: { ...evaluation.result, pass: evaluation.result.score >= threshold },
      };

/** Creates the per-run metric bridge from resources to existing assertion/exec/judge engines. */
const createEvalMetricEvaluator = (projectRoot: string, cacheStore: CacheStore) => {
  const judgeCache = createJudgeCache(cacheStore);
  let judgeClient: ReturnType<typeof createTanstackJudgeClient> | undefined;

  /** Evaluates attached metrics in authored order while retaining each metric's own runtime policy. */
  const evaluate = async (
    runId: string,
    payload: ResolvedEvalCaseInput,
    execution: CaseExecution,
    signal: AbortSignal,
  ): Promise<MetricEvaluation[]> => {
    const context = caseExecutionToMetricContext(payload.case, execution);
    const request: AgentRequest = {
      protocol: AGENT_PROTOCOL,
      run_id: runId,
      case_id: payload.case_id,
      input: payload.case.input,
      ...(payload.case.params === undefined ? {} : { params: payload.case.params }),
    };
    const evaluations: MetricEvaluation[] = [];
    for (const resolvedMetric of payload.metrics) {
      const { definition } = resolvedMetric.metric;
      let evaluation: MetricEvaluation;
      let secrets: readonly string[] = [];
      if (definition.kind === 'http') {
        evaluation = await evaluateHttpMetric(
          resolvedMetric,
          context,
          request,
          projectRoot,
          signal,
        );
      } else {
        let metricDefinition: MetricDefinition;
        let options: Parameters<typeof evaluateMetrics>[2] = { signal };
        if (definition.kind === 'assertion') {
          metricDefinition = {
            name: resolvedMetric.metric.id,
            type: 'assertion',
            assert: definition.assertions,
          };
        } else if (definition.kind === 'judge') {
          judgeClient ??= createTanstackJudgeClient();
          metricDefinition = {
            name: resolvedMetric.metric.id,
            type: 'judge',
            model: definition.model,
            rubric: definition.rubric,
            threshold: resolvedMetric.threshold ?? definition.threshold,
          };
          options = { cache: judgeCache, judgeClient, signal };
        } else {
          const runtime = await resolveExecutableMetric(definition, projectRoot);
          secrets = runtime.secrets;
          metricDefinition = {
            name: resolvedMetric.metric.id,
            type: 'exec',
            command: definition.argv,
          };
          options = {
            execCwd: runtime.cwd,
            execEnv: runtime.env,
            execTimeoutMs: definition.timeout_ms,
            signal,
          };
        }
        const evaluated = await evaluateMetrics([metricDefinition], context, options);
        const first = evaluated[0];
        if (first === undefined) throw new Error('Metric engine returned no evaluation.');
        evaluation = first;
      }
      evaluations.push(
        redactMetricEvaluation(
          applyAttachedThreshold(evaluation, resolvedMetric.threshold),
          secrets,
        ),
      );
    }
    return evaluations;
  };

  return { evaluate };
};

export { createEvalMetricEvaluator };
