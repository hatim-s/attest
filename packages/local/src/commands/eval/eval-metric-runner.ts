/**
 * The local metric bridge. `attest metric test` and eval both dispatch metrics through it, so
 * every exec metric gets the same cwd containment, secret handling and redaction.
 *
 * ```text
 * metric test ──┐                     ┌─ assertion ─▶ runtime evaluateMetrics
 *               ├─▶ evaluateMetricResource
 * eval case ────┘   (eval also runs   └─ exec: openMetricDirectory (per-segment check + descriptor)
 *                    judge and HTTP          ─▶ resolveMetricEnvironment (secrets)
 *                    metrics here)           ─▶ assertMetricDirectoryIdentity (recheck at spawn)
 *                                            ─▶ runtime evaluateMetrics (spawn in cwd)
 *
 * evaluation + metric secrets ─▶ caller redacts with agent and field-hidden secrets ─▶ stored
 * ```
 */
import { lstat, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  METRIC_PROTOCOL,
  type AgentRequest,
  type JsonValue,
  type MetricDefinition,
  type MetricResource,
} from '@attest/contracts';
import { type CacheStore, type StoredMetricEvaluation } from '@attest/core';
import { invokeMappedHttpAgent, type HttpAgentResource } from '@attest/executor';
import {
  type CaseExecution,
  caseExecutionToMetricContext,
  createTanstackJudgeClient,
  evaluateMetrics,
  type JudgeCache,
  judgeOutcomeSchema,
  type MetricContext,
} from '@attest/runtime';
import { z } from 'zod';

import { LocalError } from '../../errors/index.js';
import { readJsonPointer } from '../../internal/json-pointer.js';
import { openAnchored, type AnchoredEntry } from '../../internal/open-anchored.js';
import { resolveContainedPath } from '../../project/project-path.js';
import { redactMetricEvaluation, redactProbeValue } from '../agent/adapter/evidence-redaction.js';
import {
  resolveHttpSecrets,
  resolveProcessEnvironment,
} from '../agent/adapter/resolve-native-agent.js';
import type { ResolvedEvalCaseInput } from './eval-resolver.js';

/**
 * Adapts the shared SQLite response cache to the judge metric cache contract. The judge prompt
 * quotes the unredacted agent output, so each entry is redacted before it is written.
 */
const createJudgeCache = (cacheStore: CacheStore, secrets: readonly string[]): JudgeCache => ({
  get: async (key) => {
    const entry = await cacheStore.get('judge', key);

    return entry === undefined ? undefined : judgeOutcomeSchema.parse(entry);
  },
  set: (key, entry) => cacheStore.put('judge', key, redactProbeValue(entry, secrets)),
});

type ExecMetricDefinition = Extract<MetricResource['definition'], { kind: 'exec' }>;

type HttpMetricDefinition = Extract<MetricResource['definition'], { kind: 'http' }>;

/** A metric evaluation before redaction, with the secret values its evidence may contain. */
type MetricRun = { evaluation: StoredMetricEvaluation; secrets: readonly string[] };

const httpMetricResultSchema = z.object({
  score: z.number(),
  pass: z.boolean(),
  rationale: z.string().optional(),
  details: z.json().optional(),
});

/** Runs one runtime metric definition and returns its single evaluation. */
const evaluateOne = async (
  definition: MetricDefinition,
  context: MetricContext,
  options: Parameters<typeof evaluateMetrics>[2],
): Promise<StoredMetricEvaluation> => {
  const [evaluation] = await evaluateMetrics([definition], context, options);

  if (evaluation === undefined) {
    throw new LocalError(
      'metric_infrastructure_failed',
      'The metric engine returned no evaluation.',
    );
  }

  return evaluation;
};

const unsafeMetricDirectory = (path: string, cause?: unknown): LocalError =>
  new LocalError('project_invalid', 'Metric cwd is not a safe project directory.', {
    path,
    hint: 'Use a real project-contained directory without a symlink escape.',
    cause,
  });

/**
 * Opens an exec metric cwd after the per-segment symlink check worker directories use, keeping a
 * descriptor so its identity can be rechecked at spawn. The schema accepts `.`, `./x` and
 * trailing slashes, so the path is normalized lexically first; it already forbids `..`.
 */
const openMetricDirectory = async (
  projectRoot: string,
  cwd: string | undefined,
): Promise<AnchoredEntry> => {
  const projectPath = relative(projectRoot, resolve(projectRoot, cwd ?? '.'));
  const root = await realpath(projectRoot);

  const path =
    projectPath === ''
      ? root
      : await resolveContainedPath(projectRoot, projectPath, {
          expect: 'directory',
          problem: () => unsafeMetricDirectory(projectPath),
        });

  try {
    return await openAnchored(path, { kind: 'directory', root });
  } catch (error: unknown) {
    throw unsafeMetricDirectory(cwd ?? '.', error);
  }
};

/**
 * Secret resolution awaits between opening the cwd and spawning, so a swapped pathname could
 * redirect the spawn. Rechecks the pathname against the retained descriptor just before spawn.
 */
const assertMetricDirectoryIdentity = async (
  directory: AnchoredEntry,
  cwd: string | undefined,
): Promise<void> => {
  let current: BigIntStats;

  try {
    current = await lstat(directory.path, { bigint: true });
  } catch (error: unknown) {
    throw unsafeMetricDirectory(cwd ?? '.', error);
  }

  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== directory.identity.dev ||
    current.ino !== directory.identity.ino
  ) {
    throw unsafeMetricDirectory(cwd ?? '.');
  }
};

/** Resolves an exec metric's secret environment, reporting a missing secret as a metric failure. */
const resolveMetricEnvironment = async (
  definition: ExecMetricDefinition,
  projectRoot: string,
): Promise<Awaited<ReturnType<typeof resolveProcessEnvironment>>> => {
  try {
    return await resolveProcessEnvironment(definition.env, projectRoot);
  } catch (error: unknown) {
    throw new LocalError(
      'metric_infrastructure_failed',
      'A referenced metric secret is unavailable.',
      { hint: 'Set the referenced secret and retry.', cause: error },
    );
  }
};

type EvaluateMetricResourceOptions = {
  context: MetricContext;
  definition: Extract<MetricResource['definition'], { kind: 'assertion' | 'exec' }>;
  id: string;
  projectRoot: string;
  signal?: AbortSignal;
};

/**
 * Runs one assertion or exec metric for both `attest metric test` and eval, so the definition
 * mapping, exec cwd containment, the identity recheck and the secret environment follow one rule.
 * The caller redacts the returned evidence.
 */
const evaluateMetricResource = async ({
  context,
  definition,
  id,
  projectRoot,
  signal,
}: EvaluateMetricResourceOptions): Promise<MetricRun> => {
  if (definition.kind === 'assertion') {
    const evaluation = await evaluateOne(
      { name: id, type: 'assertion', assert: definition.assertions },
      context,
      { signal },
    );

    return { evaluation, secrets: [] };
  }

  const directory = await openMetricDirectory(projectRoot, definition.cwd);

  try {
    const { env, secrets } = await resolveMetricEnvironment(definition, projectRoot);
    await assertMetricDirectoryIdentity(directory, definition.cwd);

    const evaluation = await evaluateOne(
      { name: id, type: 'exec', command: definition.argv },
      context,
      { exec: { cwd: directory.path, env, timeoutMs: definition.timeout_ms }, signal },
    );

    return { evaluation, secrets };
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
};

/**
 * Converts a HTTP metric response mapping into the existing metric result evidence shape.
 * Runtime's StoredMetricEvaluation has no HTTP kind, so an HTTP metric reports like an exec
 * metric: both return a score and pass result from outside the process.
 */
const extractHttpMetricResult = (
  metricId: string,
  definition: HttpMetricDefinition,
  output: JsonValue | undefined,
  durationMs: number,
): StoredMetricEvaluation => {
  const read = (pointer: string | undefined) =>
    pointer === undefined ? undefined : readJsonPointer(output, pointer);

  const result = httpMetricResultSchema.safeParse({
    score: read(definition.extraction.score_pointer),
    pass: read(definition.extraction.pass_pointer),
    rationale: read(definition.extraction.rationale_pointer),
    details: read(definition.extraction.details_pointer),
  });

  if (!result.success) {
    return {
      metricName: metricId,
      kind: 'exec',
      status: 'error',
      error: {
        kind: 'exec_malformed_output',
        message: 'HTTP metric extraction did not produce a finite score and boolean pass result.',
      },
      durationMs,
    };
  }

  return { metricName: metricId, kind: 'exec', status: 'evaluated', durationMs, ...result.data };
};

type EvaluateHttpMetricOptions = {
  context: MetricContext;
  metric: Pick<MetricResource, 'id' | 'name'> & { definition: HttpMetricDefinition };
  projectRoot: string;
  request: AgentRequest;
  signal: AbortSignal;
};

/** Executes one mapped HTTP metric through the hardened existing HTTP agent adapter. */
const evaluateHttpMetric = async ({
  context,
  metric,
  projectRoot,
  request,
  signal,
}: EvaluateHttpMetricOptions): Promise<MetricRun> => {
  const { definition } = metric;

  if (context.execution.outcome !== 'completed') {
    // Runtime exports no skipped-metric builder, so a URL exec definition borrows its skip rule.
    const evaluation = await evaluateOne(
      { name: metric.id, type: 'exec', url: definition.request.url },
      context,
      {},
    );

    return { evaluation, secrets: [] };
  }

  // Trace extensions are intentionally open, so validate their JSON shape at the HTTP boundary.
  const metricRequest = z.json().parse({
    protocol: METRIC_PROTOCOL,
    case: context.caseDefinition,
    output: context.execution.output,
    trace: context.execution.trace,
  });

  const agent: HttpAgentResource = {
    schema: AGENT_RESOURCE_SCHEMA_ID,
    id: metric.id,
    name: metric.name,
    retry: definition.retry,
    timeouts:
      definition.timeout_ms === undefined ? undefined : { attempt_ms: definition.timeout_ms },
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
  };

  const { headers, query, secrets } = await resolveHttpSecrets(definition.request, projectRoot);
  const startedAt = performance.now();

  const invocation = await invokeMappedHttpAgent(
    agent,
    { ...request, input: metricRequest },
    { headers, query, secrets, signal },
  );

  const durationMs = performance.now() - startedAt;

  if (invocation.status === 'invocation_error') {
    const evaluation: StoredMetricEvaluation = {
      metricName: metric.id,
      kind: 'exec',
      status: 'error',
      error: {
        kind: invocation.error.code === 'timeout' ? 'exec_timeout' : 'http_request_failed',
        message: invocation.error.message,
      },
      durationMs,
    };

    return { evaluation, secrets };
  }

  const response = invocation.report?.ok === true ? invocation.report.value : undefined;

  const evaluation = extractHttpMetricResult(
    metric.id,
    definition,
    response !== undefined && 'output' in response ? response.output : undefined,
    durationMs,
  );

  return { evaluation, secrets };
};

const applyAttachedThreshold = (
  evaluation: StoredMetricEvaluation,
  threshold: number | undefined,
): StoredMetricEvaluation =>
  threshold === undefined || evaluation.status === 'error'
    ? evaluation
    : {
        ...evaluation,
        pass: evaluation.score >= threshold,
      };

type EvaluateCaseMetricsOptions = {
  /** The unredacted case execution. It is scored and never returned. */
  original: CaseExecution;
  payload: ResolvedEvalCaseInput;
  runId: string;
  /**
   * Values the case evidence must not show: agent secrets plus values hidden by field-name
   * redaction. Metric evidence and judge cache entries are redacted with them and each metric's
   * own secrets.
   */
  secrets: readonly string[];
  signal: AbortSignal;
};

/** Creates the per-run metric bridge from resources to existing assertion/exec/judge engines. */
const createEvalMetricEvaluator = (projectRoot: string, cacheStore: CacheStore) => {
  let judgeClient: ReturnType<typeof createTanstackJudgeClient> | undefined;
  const judgeCaches = new Map<string, JudgeCache>();

  /**
   * Runtime coalesces concurrent identical judge calls per cache object, so every case with the
   * same redaction scope shares one adapter for the whole run.
   */
  const judgeCacheFor = (secrets: readonly string[]): JudgeCache => {
    const scope = JSON.stringify([...new Set(secrets)].sort());
    const existing = judgeCaches.get(scope);

    if (existing !== undefined) return existing;
    const created = createJudgeCache(cacheStore, secrets);
    judgeCaches.set(scope, created);

    return created;
  };

  /**
   * Evaluates attached metrics in authored order while retaining each metric's own runtime policy.
   * Metrics see the original output, so the returned evidence is redacted after scoring.
   */
  const evaluate = async ({
    original,
    payload,
    runId,
    secrets: agentSecrets,
    signal,
  }: EvaluateCaseMetricsOptions): Promise<StoredMetricEvaluation[]> => {
    const context = caseExecutionToMetricContext(payload.case, original);

    const request: AgentRequest = {
      protocol: AGENT_PROTOCOL,
      run_id: runId,
      case_id: payload.case_id,
      input: payload.case.input,
    };

    if (payload.case.params !== undefined) {
      request.params = payload.case.params;
    }

    const evaluations: StoredMetricEvaluation[] = [];

    for (const resolvedMetric of payload.metrics) {
      const { metric, threshold } = resolvedMetric;
      const { definition } = metric;
      let run: MetricRun;

      if (definition.kind === 'http') {
        run = await evaluateHttpMetric({
          context,
          metric: { ...metric, definition },
          projectRoot,
          request,
          signal,
        });
      } else if (definition.kind === 'judge') {
        judgeClient ??= createTanstackJudgeClient();

        const evaluation = await evaluateOne(
          {
            name: metric.id,
            type: 'judge',
            model: definition.model,
            rubric: definition.rubric,
            threshold: threshold ?? definition.threshold,
          },
          context,
          { cache: judgeCacheFor(agentSecrets), judgeClient, signal },
        );

        run = { evaluation, secrets: [] };
      } else {
        run = await evaluateMetricResource({
          context,
          definition,
          id: metric.id,
          projectRoot,
          signal,
        });
      }

      evaluations.push(
        redactMetricEvaluation(applyAttachedThreshold(run.evaluation, threshold), [
          ...agentSecrets,
          ...run.secrets,
        ]),
      );
    }

    return evaluations;
  };

  return { evaluate };
};

export { createEvalMetricEvaluator, evaluateMetricResource };
