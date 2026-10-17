import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_PROTOCOL,
  AGENT_RESOURCE_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  evalRunSchema,
  type MetricResource,
} from '@attest/contracts';
import { type CacheStore } from '@attest/core';
import { type CaseExecution, type ResolvedEvalCase } from '@attest/runtime';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';

import { REDACTED } from '../../../internal/redaction.js';
import { openStore } from '../../../store/index.js';
import { createEvalCaseRunner } from '../eval-agent-runner.js';
import { createEvalMetricEvaluator } from '../eval-metric-runner.js';
import { createEvalPersistenceAdapter } from '../eval-persistence.js';
import type { ResolvedEvalCaseInput } from '../eval-resolver.js';

const directories: string[] = [];

const emptyCache: CacheStore = {
  get: () => Promise.resolve(undefined),
  put: () => Promise.resolve(),
};

/** Writes `{ token }` as the agent output once stdin closes. */
const tokenAgent = (token: string): string =>
  [
    "process.stdin.resume().on('end', () => {",
    `  process.stdout.write(JSON.stringify({ protocol: 'attest.agent-invocation', output: { token: ${JSON.stringify(token)} } }));`,
    '});',
  ].join('\n');

/** Echoes the whole metric request to stderr and fails, so stderr evidence quotes the output. */
const ECHO_METRIC = [
  "let source = '';",
  "process.stdin.on('data', (chunk) => { source += chunk; }).on('end', () => {",
  '  process.stderr.write(source);',
  '  process.exitCode = 7;',
  '});',
].join('\n');

const metric = (id: string, definition: MetricResource['definition']) => ({
  metric: { schema: METRIC_RESOURCE_SCHEMA_ID, id, name: id, definition },
});

const JUDGE_METRIC = metric('judge', {
  kind: 'judge',
  model: 'openai/gpt-5',
  rubric: 'Score the answer.',
  threshold: 0.5,
});

/**
 * Streams OpenAI Responses API events on loopback so judge metrics run without the network. The
 * verdict's rationale quotes the whole request, so provider response text carries the prompt.
 */
const startJudgeProvider = async (): Promise<{ requests: string[] }> => {
  const requests: string[] = [];

  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      requests.push(body);
      const text = JSON.stringify({ score: 1, rationale: `Judged request: ${body}` });

      const events = [
        { type: 'response.output_text.delta', delta: text, sequence_number: 1 },
        {
          type: 'response.completed',
          sequence_number: 2,
          response: {
            model: 'gpt-5',
            status: 'completed',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];

      // The delay keeps the first call in flight while a concurrent identical call arrives.
      setTimeout(() => {
        response.setHeader('content-type', 'text/event-stream');
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      }, 100);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  vi.stubEnv('OPENAI_API_KEY', 'judge-test-key');
  vi.stubEnv('OPENAI_BASE_URL', `http://127.0.0.1:${port}/v1`);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    server.close();
  });

  return { requests };
};

/** Creates a project root holding the token agent and the echo metric. */
const createRoot = async (token: string): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attest-scoring-redaction-')));
  directories.push(root);
  await writeFile(join(root, 'agent.mjs'), tokenAgent(token));
  await writeFile(join(root, 'metric.mjs'), ECHO_METRIC);

  return root;
};

const readRun = async () => {
  const fixture = await readFile(new URL('./fixtures/eval-run.json', import.meta.url), 'utf8');
  const run = evalRunSchema.parse(JSON.parse(fixture));
  delete run.effective_command.resolved.execution;

  return run;
};

/** Builds one case of the token agent with the given metrics attached. */
const tokenCase = (
  metrics: ResolvedEvalCaseInput['metrics'],
): ResolvedEvalCase<ResolvedEvalCaseInput> => {
  const testCase = { id: 'token-case', input: 'hello' };

  const payload: ResolvedEvalCaseInput = {
    agent: {
      schema: AGENT_RESOURCE_SCHEMA_ID,
      id: 'token-agent',
      name: 'Token agent',
      transport: {
        kind: 'native_cli',
        lifecycle: 'per_case',
        argv: [process.execPath, './agent.mjs'],
      },
    },
    attempt_timeout_ms: 5000,
    case: testCase,
    case_id: testCase.id,
    concurrency: 1,
    configured_index: 0,
    execution_id: `token-test:${testCase.id}`,
    metrics,
    source: { kind: 'direct' },
    test: {
      schema: TEST_RESOURCE_SCHEMA_ID,
      id: 'token-test',
      name: 'Token test',
      agent_id: 'token-agent',
      cases: [testCase],
      datasets: [],
      metrics: metrics.map(({ metric: { id } }) => ({ metric_id: id })),
    },
    test_id: 'token-test',
  };

  return {
    configured_index: 0,
    test_id: payload.test_id,
    case_id: payload.case_id,
    source: payload.source,
    payload,
  };
};

/** Runs one case through the eval runner and records it through the persistence adapter. */
const runAndRecord = async (
  root: string,
  store: Awaited<ReturnType<typeof openStore>>,
  resolvedCase: ResolvedEvalCase<ResolvedEvalCaseInput>,
) => {
  const run = await readRun();
  const runner = createEvalCaseRunner(root, store.cache, run);

  const result = await runner.executeCase(run.run_id, resolvedCase, new AbortController().signal, {
    workerIndex: 0,
  });

  await runner.cleanup?.(run.run_id);

  const persistence = createEvalPersistenceAdapter(store);
  await persistence.createRun(run);
  await persistence.recordCase(run.run_id, {
    kind: 'executed',
    resolved_case: resolvedCase,
    execution: result.execution,
    metrics: result.metrics,
    normalized: {
      test_id: resolvedCase.test_id,
      case_id: resolvedCase.case_id,
      configured_index: 0,
      completion_index: 0,
      outcome: result.execution.outcome,
      verdict: 'pass',
      started_at: result.execution.startedAt,
      duration_ms: result.execution.durationMs,
      metric_results: result.metrics,
    },
  });

  return { result, stored: await store.runs.getCaseResults(run.run_id) };
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('metrics score the original output while the stored case keeps the redacted copy', async () => {
  const root = await createRoot('ok');
  const store = await openStore(join(root, 'runs.db'));

  try {
    const { result, stored } = await runAndRecord(
      root,
      store,
      tokenCase([
        metric('token-equals', {
          kind: 'assertion',
          assertions: [{ equals: { path: '$.output.token', value: 'ok' } }],
        }),
      ]),
    );

    expect(result.metrics).toMatchObject([{ metricName: 'token-equals', pass: true, score: 1 }]);
    expect(stored).toMatchObject([
      {
        caseId: 'token-case',
        response: { output: { token: REDACTED } },
        metrics: [{ metricName: 'token-equals', pass: true }],
      },
    ]);
  } finally {
    await store.close();
  }
});

test('a field-redacted output value never reaches stored metric text or the judge cache', async () => {
  const hidden = 'field-only-private-7f';
  const provider = await startJudgeProvider();
  const root = await createRoot(hidden);
  const store = await openStore(join(root, 'runs.db'));

  try {
    const { result, stored } = await runAndRecord(
      root,
      store,
      tokenCase([
        metric('echo', { kind: 'exec', argv: [process.execPath, './metric.mjs'] }),
        JUDGE_METRIC,
      ]),
    );

    // The provider saw the original value, and both metrics quote the output in text evidence.
    expect(provider.requests.join('')).toContain(hidden);
    expect(stored).toMatchObject([{ response: { output: { token: REDACTED } } }]);

    const [echo, judge] = stored[0]?.metrics ?? [];
    const { stderr } = z.object({ stderr: z.string() }).parse(echo?.details);
    expect(stderr).toContain(`"token":"${REDACTED}"`);
    expect(judge?.rationale).toContain(REDACTED);

    const { key } = z.object({ key: z.string() }).parse(judge?.judgeIo);
    const cached = await store.cache.get('judge', key);
    expect(cached).toBeDefined();

    expect(JSON.stringify({ stored, metrics: result.metrics, cached })).not.toContain(hidden);
  } finally {
    await store.close();
  }
});

test('concurrent identical judge cases share one provider call', async () => {
  const provider = await startJudgeProvider();
  const root = await createRoot('ok');
  const evaluator = createEvalMetricEvaluator(root, emptyCache);
  const { payload } = tokenCase([JUDGE_METRIC]);
  const run = await readRun();
  const signal = new AbortController().signal;

  const original: CaseExecution = {
    attempts: [],
    caseDefinition: payload.case,
    caseId: payload.case_id,
    diagnostics: {},
    durationMs: 1,
    expectedMetrics: ['judge'],
    outcome: 'completed',
    request: {
      protocol: AGENT_PROTOCOL,
      run_id: run.run_id,
      case_id: payload.case_id,
      input: 'hello',
    },
    response: { protocol: AGENT_PROTOCOL, output: { token: 'ok' } },
    startedAt: run.created_at,
    suiteName: payload.test_id,
    warnings: [],
  };

  const options = { original, payload, runId: run.run_id, secrets: [], signal };

  const [first, second] = await Promise.all([
    evaluator.evaluate(options),
    evaluator.evaluate(options),
  ]);

  expect(provider.requests).toHaveLength(1);
  expect([first?.[0]?.judgeIo, second?.[0]?.judgeIo]).toMatchObject([
    { cache: 'miss' },
    { cache: 'coalesced' },
  ]);
});
