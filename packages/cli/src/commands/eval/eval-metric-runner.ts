import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_VERSION,
  METRIC_PROTOCOL,
  type AgentRequest,
  type AgentResource,
  type JsonValue,
  type MetricDefinition,
  type MetricResource,
} from '@attest/contracts';
import {
  caseExecutionToMetricContext,
  createTanstackJudgeClient,
  evaluateMetrics,
  invokeMappedHttpAgent,
  type CacheStore,
  type CaseExecution,
  type JudgeCache,
  type JudgeCacheEntry,
  type MetricContext,
  type MetricEvaluation,
} from '@attest/core';

import { AttestCliError } from '../../errors.js';
import {
  createBaseEnvironment,
  readSecretReference,
  resolveNativeAgent,
} from '../agent/native-agent-adapter.js';
import type { ResolvedEvalCaseInput, ResolvedEvalMetric } from './eval-resolver.js';

const isContainedPath = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
};

/** Adapts the shared SQLite response cache to the judge metric cache contract. */
const createJudgeCache = (cacheStore: CacheStore): JudgeCache => ({
  get: async (key) => (await cacheStore.get('judge', key)) as JudgeCacheEntry | undefined,
  set: (key, entry) => cacheStore.put('judge', key, entry),
});

/** Resolves one executable metric environment at invocation time without persisting secret values. */
const resolveExecutableMetric = async (
  metric: Extract<MetricResource['definition'], { kind: 'exec' }>,
  projectRoot: string,
): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> => {
  const cwd = await realpath(resolve(projectRoot, metric.cwd ?? '.'));
  if (!isContainedPath(projectRoot, cwd)) {
    throw new AttestCliError('metric_infrastructure_failed', 'Metric cwd escapes the project.', {
      path: metric.cwd ?? '.',
    });
  }
  const env: NodeJS.ProcessEnv = createBaseEnvironment();
  for (const [name, reference] of Object.entries(metric.env ?? {})) {
    env[name] = await readSecretReference(reference, projectRoot);
  }
  return { cwd, env };
};

const decodePointerSegment = (segment: string): string | undefined => {
  if (/~(?:[^01]|$)/u.test(segment)) return undefined;
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
};

/** Reads one strict RFC 6901 pointer without traversing inherited properties. */
const readJsonPointer = (value: unknown, pointer: string): unknown => {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = decodePointerSegment(encoded);
    if (segment === undefined || current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
    } else {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = Reflect.get(current, segment);
    }
  }
  return current;
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && Object.values(value).every(isJsonValue);
};

/** Converts a v2 HTTP metric response mapping into the existing metric result evidence shape. */
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
  const details =
    definition.extraction.details_pointer === undefined
      ? undefined
      : readJsonPointer(value, definition.extraction.details_pointer);
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    typeof pass !== 'boolean' ||
    (rationale !== undefined && typeof rationale !== 'string') ||
    (details !== undefined && !isJsonValue(details))
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
      ...(details === undefined ? {} : { details }),
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
  const metricRequest = {
    protocol: METRIC_PROTOCOL,
    case: context.caseDefinition,
    output: context.execution.output,
    trace: context.execution.trace as unknown as JsonValue,
  } as JsonValue;
  const syntheticAgent: AgentResource = {
    schema: AGENT_RESOURCE_SCHEMA_VERSION,
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
  if (resolved.mappedAgent === undefined) throw new Error('HTTP metric adapter was not resolved.');
  const startedAt = performance.now();
  const invocation = await invokeMappedHttpAgent(
    resolved.mappedAgent,
    { ...request, input: metricRequest },
    {
      headers: resolved.httpHeaders,
      query: resolved.httpQuery,
      secrets: resolved.secrets,
      signal,
    },
  );
  const durationMs = performance.now() - startedAt;
  if (invocation.status === 'invocation_error') {
    return {
      metricName: metric.metric.id,
      kind: 'exec',
      status: 'error',
      error: {
        code: invocation.error.code === 'timeout' ? 'exec_timeout' : 'http_request_failed',
        message: invocation.error.message,
      },
      durationMs,
    };
  }
  const response = invocation.report?.ok === true ? invocation.report.value : undefined;
  return extractHttpMetricResult(
    metric.metric.id,
    definition,
    response !== undefined && 'output' in response ? response.output : undefined,
    durationMs,
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

/** Creates the per-run metric bridge from v2 resources to existing assertion/exec/judge engines. */
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
      evaluations.push(applyAttachedThreshold(evaluation, resolvedMetric.threshold));
    }
    return evaluations;
  };

  return { evaluate };
};

export { createEvalMetricEvaluator, extractHttpMetricResult, readJsonPointer };
