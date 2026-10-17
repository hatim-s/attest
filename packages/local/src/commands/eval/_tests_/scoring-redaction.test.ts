import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_RESOURCE_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  evalRunSchema,
} from '@attest/contracts';
import { type CacheStore } from '@attest/core';
import { type ResolvedEvalCase } from '@attest/runtime';
import { afterEach, expect, test } from 'vitest';

import { REDACTED } from '../../../internal/redaction.js';
import { openStore } from '../../../store/index.js';
import { createEvalCaseRunner } from '../eval-agent-runner.js';
import { createEvalPersistenceAdapter } from '../eval-persistence.js';
import type { ResolvedEvalCaseInput } from '../eval-resolver.js';

const directories: string[] = [];

const cache: CacheStore = { get: () => Promise.resolve(undefined), put: () => Promise.resolve() };

const TOKEN_AGENT = [
  "process.stdin.resume().on('end', () => {",
  "  process.stdout.write(JSON.stringify({ protocol: 'attest.agent-invocation', output: { token: 'ok' } }));",
  '});',
].join('\n');

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('metrics score the original output while the stored case keeps the redacted copy', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attest-scoring-redaction-')));
  directories.push(root);
  await writeFile(join(root, 'agent.mjs'), TOKEN_AGENT);

  const fixture = await readFile(new URL('./fixtures/eval-run.json', import.meta.url), 'utf8');
  const run = evalRunSchema.parse(JSON.parse(fixture));
  delete run.effective_command.resolved.execution;

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
    metrics: [
      {
        metric: {
          schema: METRIC_RESOURCE_SCHEMA_ID,
          id: 'token-equals',
          name: 'Token equals',
          definition: {
            kind: 'assertion',
            assertions: [{ equals: { path: '$.output.token', value: 'ok' } }],
          },
        },
      },
    ],
    source: { kind: 'direct' },
    test: {
      schema: TEST_RESOURCE_SCHEMA_ID,
      id: 'token-test',
      name: 'Token test',
      agent_id: 'token-agent',
      cases: [testCase],
      datasets: [],
      metrics: [{ metric_id: 'token-equals' }],
    },
    test_id: 'token-test',
  };

  const resolvedCase: ResolvedEvalCase<ResolvedEvalCaseInput> = {
    configured_index: 0,
    test_id: payload.test_id,
    case_id: payload.case_id,
    source: payload.source,
    payload,
  };

  const runner = createEvalCaseRunner(root, cache, run);

  const result = await runner.executeCase(run.run_id, resolvedCase, new AbortController().signal, {
    workerIndex: 0,
  });

  await runner.cleanup?.(run.run_id);
  expect(result.metrics).toMatchObject([{ metricName: 'token-equals', pass: true, score: 1 }]);

  const store = await openStore(join(root, 'runs.db'));

  try {
    const persistence = createEvalPersistenceAdapter(store);
    await persistence.createRun(run);
    await persistence.recordCase(run.run_id, {
      kind: 'executed',
      resolved_case: resolvedCase,
      execution: result.execution,
      metrics: result.metrics,
      normalized: {
        test_id: payload.test_id,
        case_id: payload.case_id,
        configured_index: 0,
        completion_index: 0,
        outcome: result.execution.outcome,
        verdict: 'pass',
        started_at: result.execution.startedAt,
        duration_ms: result.execution.durationMs,
        metric_results: result.metrics,
      },
    });

    expect(await store.runs.getCaseResults(run.run_id)).toMatchObject([
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
