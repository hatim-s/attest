import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { justBashIsolation } from '@attest/executor';
import { executeResolvedEvalPlan } from '../../../dist/index.js';

async function createPlan() {
  const run = JSON.parse(
    await readFile(new URL('./fixtures/eval-run.json', import.meta.url), 'utf8'),
  );
  run.effective_command.resolved = {
    concurrency: 2,
    timeout_ms: 5000,
    output: 'jsonl',
    watch: false,
  };
  return {
    run,
    cases: run.snapshot.selected_cases.map((entry) => ({ ...entry, payload: entry.case_id })),
  };
}

test('runs isolated agent, hook, evaluation, and persistence stages on the host runtime', async () => {
  const stages = new Map();
  const stored = [];
  const plan = await createPlan();
  const invoke = async ({ resolvedCase, environment }) => {
    assert.equal(await environment.readFile('input'), resolvedCase.case_id);
    stages.get(resolvedCase.case_id).push('agent');
    return {
      caseId: resolvedCase.case_id,
      suiteName: resolvedCase.test_id,
      request: {
        protocol: 'attest.agent-invocation',
        run_id: plan.run.run_id,
        case_id: resolvedCase.case_id,
        input: 'test',
      },
      caseDefinition: { id: resolvedCase.case_id, input: 'test' },
      expectedMetrics: [],
      attempts: [],
      diagnostics: {},
      warnings: [],
      startedAt: new Date().toISOString(),
      durationMs: 0,
      outcome: 'completed',
      response: { protocol: 'attest.agent-invocation', output: 'ok' },
    };
  };
  const evaluate = async ({ resolvedCase, environment }) => {
    assert.equal(await environment.readFile('ready'), 'yes\n');
    stages.get(resolvedCase.case_id).push('evaluate');
    return [];
  };
  // The smallest runner that awaits the stage hooks between agent and evaluation work.
  const runner = {
    executeCase: async (_runId, resolvedCase, _signal, context) => {
      const stage = { resolvedCase, environment: context.environment };
      const execution = await invoke(stage);
      await context.afterAgent(execution);
      const metrics = await evaluate(stage);
      await context.afterEvaluation(execution, metrics);
      return { execution, metrics };
    },
  };
  const result = await executeResolvedEvalPlan(
    plan,
    runner,
    {
      createRun: async () => {},
      recordCase: async (_id, record) => {
        stored.push(record);
      },
      finalizeRun: async () => {},
    },
    {
      isolation: justBashIsolation(),
      hooks: [
        {
          before_case: async ({ resolvedCase, environment }) => {
            stages.set(resolvedCase.case_id, ['before']);
            await environment.writeFile('input', resolvedCase.case_id);
          },
          after_agent: async ({ resolvedCase, environment }) => {
            assert.equal((await environment.exec('echo yes > ready')).exitCode, 0);
            stages.get(resolvedCase.case_id).push('after_agent');
          },
          after_evaluation: ({ resolvedCase }) => {
            stages.get(resolvedCase.case_id).push('after_evaluation');
          },
          after_case: ({ resolvedCase }) => {
            stages.get(resolvedCase.case_id).push('after');
          },
        },
      ],
    },
  );
  assert.equal(result.status, 'completed');
  assert.equal(stored.length, 2);
  for (const order of stages.values())
    assert.deepEqual(order, [
      'before',
      'agent',
      'after_agent',
      'evaluate',
      'after_evaluation',
      'after',
    ]);
});
