import assert from 'node:assert/strict';
import * as Effect from 'effect/Effect';
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

  const invoke = ({ resolvedCase, environment }) =>
    Effect.gen(function* () {
      assert.equal(yield* environment.readFile('input'), resolvedCase.case_id);
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
    });

  const evaluate = ({ resolvedCase, environment }) =>
    Effect.gen(function* () {
      assert.equal(yield* environment.readFile('ready'), 'yes\n');
      stages.get(resolvedCase.case_id).push('evaluate');

      return [];
    });

  // The smallest runner that awaits the stage hooks between agent and evaluation work.
  const runner = {
    executeCase: (_runId, resolvedCase, _signal, context) =>
      Effect.gen(function* () {
        const stage = { resolvedCase, environment: context.environment };
        const execution = yield* invoke(stage);
        yield* context.afterAgent(execution);
        const metrics = yield* evaluate(stage);
        yield* context.afterEvaluation(execution, metrics);

        return { execution, metrics };
      }),
  };

  const result = await Effect.runPromise(
    executeResolvedEvalPlan(
      plan,
      runner,
      {
        createRun: () => Effect.sync(() => {}),
        recordCase: (_id, record) =>
          Effect.sync(() => {
            stored.push(record);
          }),
        finalizeRun: () => Effect.sync(() => {}),
      },
      {
        isolation: justBashIsolation(),
        hooks: [
          {
            before_case: ({ resolvedCase, environment }) =>
              Effect.gen(function* () {
                stages.set(resolvedCase.case_id, ['before']);
                yield* environment.writeFile('input', resolvedCase.case_id);
              }),
            after_agent: ({ resolvedCase, environment }) =>
              Effect.gen(function* () {
                assert.equal((yield* environment.exec('echo yes > ready')).exitCode, 0);
                stages.get(resolvedCase.case_id).push('after_agent');
              }),
            after_evaluation: ({ resolvedCase }) =>
              Effect.sync(() => {
                stages.get(resolvedCase.case_id).push('after_evaluation');
              }),
            after_case: ({ resolvedCase }) =>
              Effect.sync(() => {
                stages.get(resolvedCase.case_id).push('after');
              }),
          },
        ],
      },
    ),
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
