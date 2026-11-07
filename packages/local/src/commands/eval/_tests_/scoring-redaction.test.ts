import { createHash } from 'node:crypto';
import * as Scope from 'effect/Scope';
import * as Exit from 'effect/Exit';
import { onTestFinished as finishNative } from 'vitest';
import { valueFromExit } from '../../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import { stripStruct } from '@attest/contracts';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseWithSchemaSync,
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
import * as Schema from 'effect/Schema';

import { REDACTED } from '../../../internal/redaction.js';
import { openTestStore as openStore, run as executeB2 } from '../../../store/_tests_/b1-fixture.js';
import { createEvalCaseRunner } from '../eval-agent-runner.js';
import { createEvalMetricEvaluator } from '../eval-metric-runner.js';
import { createEvalArtifactWriter, createEvalPersistenceAdapter } from '../eval-persistence.js';
import type { ResolvedEvalCaseInput } from '../eval-resolver.js';

const directories: string[] = [];

const emptyCache: CacheStore = {
  get: () => Effect.succeed(undefined),
  put: () => Effect.void,
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
  const { port } = parseWithSchemaSync(stripStruct({ port: Schema.Finite }), server.address());
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
  let run = parseWithSchemaSync(evalRunSchema, JSON.parse(fixture));
  run = {
    ...run,
    effective_command: {
      ...run.effective_command,
      resolved: { ...run.effective_command.resolved, execution: undefined },
    },
  };

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
  const inputRun = await readRun();

  const run = {
    ...inputRun,
    snapshot: {
      ...inputRun.snapshot,
      selected_test_ids: [resolvedCase.test_id],
      selected_cases: [
        {
          configured_index: resolvedCase.configured_index,
          test_id: resolvedCase.test_id,
          case_id: resolvedCase.case_id,
          source: resolvedCase.source,
        },
      ],
    },
  };

  const runner = await acquireNative(createEvalCaseRunner(root, store.cache, run));

  const result = await runNative(
    runner.executeCase(run.run_id, resolvedCase, new AbortController().signal, {
      workerIndex: 0,
    }),
  );

  await runNative(runner.cleanup?.(run.run_id) ?? Effect.void);

  const persistence = createEvalPersistenceAdapter(store);
  await runNative(persistence.createRun(run));
  await runNative(
    persistence.recordCase(run.run_id, {
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
    }),
  );

  return { result, stored: (await executeB2(store.runs.getRunWithCases(run.run_id))).cases };
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
    const { stderr } = parseWithSchemaSync(stripStruct({ stderr: Schema.String }), echo?.details);
    expect(stderr).toContain(`"token":"${REDACTED}"`);
    expect(judge?.rationale).toContain(REDACTED);

    const { key } = parseWithSchemaSync(stripStruct({ key: Schema.String }), judge?.judgeIo);
    const cached = await executeB2(store.cache.get('judge', key));
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
    Effect.runPromiseExit(evaluator.evaluate(options)).then(valueFromExit),
    Effect.runPromiseExit(evaluator.evaluate(options)).then(valueFromExit),
  ]);

  expect(provider.requests).toHaveLength(1);
  expect([first?.[0]?.judgeIo, second?.[0]?.judgeIo]).toMatchObject([
    { cache: 'miss' },
    { cache: 'coalesced' },
  ]);
});

/** Executes native test operations without converting production owners back to Promises. */
const runNative = async <A, E extends Error>(operation: Effect.Effect<A, E>) =>
  valueFromExit(await Effect.runPromiseExit(operation));

/** Retains acquisition scope through each test's accepted work and explicit cleanup. */
const acquireNative = async <A, E extends Error>(operation: Effect.Effect<A, E, Scope.Scope>) => {
  const scope = await runNative(Scope.make());
  finishNative(() => runNative(Scope.close(scope, Exit.void)));

  return runNative(Scope.provide(operation, scope));
};

test('publishes only verified JUnit bytes and leaves no stage after rejection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attest-junit-native-')));
  directories.push(root);
  const writer = createEvalArtifactWriter(root);
  const contents = '<testsuites/>\n';

  const payload = {
    contents,
    byte_length: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex'),
  };

  await runNative(writer.writeJUnitAtomically('result.xml', payload));
  expect(await readFile(join(root, 'result.xml'), 'utf8')).toBe(contents);
  await expect(
    runNative(writer.writeJUnitAtomically('result.xml', { ...payload, byte_length: 1 })),
  ).rejects.toThrow('integrity');
  expect(await readFile(join(root, 'result.xml'), 'utf8')).toBe(contents);
  expect(await readdir(root)).toEqual(['result.xml']);
});
