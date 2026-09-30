import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_RESOURCE_SCHEMA_ID,
  CLI_RESULT_SCHEMA_ID,
  COMMAND_REQUEST_SCHEMA_ID,
  EVAL_RUN_SCHEMA_ID,
  METRIC_RESOURCE_SCHEMA_ID,
  TEST_RESOURCE_SCHEMA_ID,
  evalFinalResultDataSchema,
  evalRunRequestSchema,
  evalRunSchema,
  type EvalEvent,
  type EvalFinalResultData,
  type MetricResource,
  type TestCase,
  type TestResource,
} from '@attest/contracts';
import { diffRuns } from '@attest/core';
import { afterEach, describe, expect, it } from 'vitest';

import { candidateFromLoadedProject } from '../../commands/project/load-command-project.js';
import { runProjectInitCommand } from '../../commands/project/project-init-command.js';
import { REDACTED } from '../../internal/redaction.js';
import { loadProject } from '../../project/project-loader/index.js';
import { applyProjectMutation } from '../../project/transaction/transactional-writer.js';
import { openStore } from '../../store/index.js';
import { cancelConfiguration, runConfiguration } from '../run-configuration.js';

type EvalProjectOptions = {
  /** Replaces the default agent, which echoes its input. */
  agentSource?: string;
  metrics?: MetricResource[];
  tests?: TestResource[];
};

type EvalOutcome = {
  events: EvalEvent[];
  final: EvalFinalResultData;
  runId: string;
};

const ECHO_AGENT = [
  "let source = '';",
  "process.stdin.setEncoding('utf8');",
  'for await (const chunk of process.stdin) source += chunk;',
  'const request = JSON.parse(source);',
  "process.stdout.write(JSON.stringify({ protocol: 'attest.agent-invocation', output: request.input }));",
].join('\n');

const temporaryDirectories: string[] = [];
const originalMetricSecret = process.env.ATTEST_EVAL_METRIC_SECRET;

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

/** An agent that records that it ran, so pre-flight failures can prove it never started. */
const markerAgent = (markerPath: string): string =>
  [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(markerPath)}, 'invoked');`,
    "process.stdout.write(JSON.stringify({ protocol: 'attest.agent-invocation', output: 'Paris' }));",
  ].join('\n');

const testResource = (id: string, metricId: string, cases: TestCase[]): TestResource => ({
  schema: TEST_RESOURCE_SCHEMA_ID,
  id,
  name: id,
  agent_id: 'support',
  cases,
  datasets: [],
  metrics: [{ metric_id: metricId }],
});

/** Builds the failure envelope the CLI would build, from contract schemas only. */
const terminalFailure = (code: 'cancelled' | 'run_failed', message: string): EvalFinalResultData =>
  evalFinalResultDataSchema.parse({
    exit_code: code === 'cancelled' ? 130 : 4,
    result: {
      schema: CLI_RESULT_SCHEMA_ID,
      ok: false,
      command: 'eval.run',
      error: { code, message, retryable: true },
    },
  });

/**
 * Creates a project with a `support` agent, an `exact` metric expecting "Paris", and a `smoke`
 * test with one `capital` case, plus any extra metrics and tests.
 */
const createEvalProject = async (options: EvalProjectOptions = {}): Promise<string> => {
  const root = await temporaryDirectory('attest-run-configuration-');
  await runProjectInitCommand({
    directory: '.',
    interactive: false,
    name: 'Eval integration',
    readStdin: () => Promise.resolve(''),
    workingDirectory: root,
  });
  await writeFile(join(root, 'agent.mjs'), options.agentSource ?? ECHO_AGENT);
  const candidate = candidateFromLoadedProject(await loadProject({ project: root }));
  candidate.agents.push({
    schema: AGENT_RESOURCE_SCHEMA_ID,
    id: 'support',
    name: 'support',
    transport: {
      kind: 'native_cli',
      lifecycle: 'per_case',
      argv: [process.execPath, './agent.mjs'],
    },
  });
  candidate.metrics.push(
    {
      schema: METRIC_RESOURCE_SCHEMA_ID,
      id: 'exact',
      name: 'exact',
      definition: {
        kind: 'assertion',
        assertions: [{ equals: { path: '$.output', value: 'Paris' } }],
      },
    },
    ...(options.metrics ?? []),
  );
  candidate.tests.push(
    testResource('smoke', 'exact', [{ id: 'capital', input: 'Paris' }]),
    ...(options.tests ?? []),
  );
  await applyProjectMutation({ candidate, projectRoot: root });
  return root;
};

const startEval = async (
  root: string,
  selection: Record<string, unknown>,
): Promise<AsyncIterable<EvalEvent>> =>
  runConfiguration(
    evalRunRequestSchema.parse({
      schema: COMMAND_REQUEST_SCHEMA_ID,
      command: 'eval.run',
      output: 'json',
      ...selection,
    }),
    {
      argv: ['eval', 'run'],
      signal: new AbortController().signal,
      terminalFailure,
      workingDirectory: root,
    },
  );

/** Drains an eval stream and returns its run id and final result. */
const collectEval = async (source: AsyncIterable<EvalEvent>): Promise<EvalOutcome> => {
  const events: EvalEvent[] = [];
  for await (const event of source) events.push(event);
  const started = events[0];
  const final = events.at(-1);
  if (started?.event !== 'run_started') throw new Error('Expected run_started first.');
  if (final?.event !== 'result') throw new Error('Expected a final result event.');
  return { events, final: final.data, runId: started.data.run_id };
};

const runEval = async (root: string, selection: Record<string, unknown>): Promise<EvalOutcome> =>
  collectEval(await startEval(root, selection));

afterEach(async () => {
  if (originalMetricSecret === undefined) delete process.env.ATTEST_EVAL_METRIC_SECRET;
  else process.env.ATTEST_EVAL_METRIC_SECRET = originalMetricSecret;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('runConfiguration', () => {
  it('treats unselected tests as coverage differences when every case in the selected test runs', async () => {
    const root = await createEvalProject({
      tests: [testResource('other', 'exact', [{ id: 'other-case', input: 'Paris' }])],
    });
    const all = await runEval(root, { all: true });
    const smoke = await runEval(root, { test_ids: ['smoke'] });

    const store = await openStore(join(root, '.attest', 'runs.db'));
    try {
      const diff = await diffRuns(store.runs, all.runId, smoke.runId);
      expect(diff.summary.coverage).toEqual({
        sharedCases: 1,
        baseOnlyCases: 1,
        candidateOnlyCases: 0,
      });
      expect(diff.summary.counts.removed).toBe(0);
      expect(diff.transitions).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('executes and persists only sampled folder/tag matches and compares their shared baseline cases', async () => {
    const sampled = Array.from({ length: 100 }, (_, index): TestCase => ({
      id: `sample-${index}`,
      input: 'Paris',
      params: { index },
      tags: [index % 2 === 0 ? 'smoke' : 'slow'],
      folder: 'billing/refunds',
    }));
    const root = await createEvalProject();
    const loaded = await loadProject({ project: root });
    const candidate = candidateFromLoadedProject(loaded);
    candidate.tests[0]!.cases.push(...sampled);
    await applyProjectMutation({ candidate, projectRoot: root });

    const baseline = await runEval(root, { test_ids: ['smoke'] });
    const selected = await runEval(root, {
      test_ids: ['smoke'],
      folders: ['billing'],
      tags: ['smoke'],
      sample: { count: 25, seed: 'integration' },
      baseline_run_id: baseline.runId,
    });
    const started = selected.events[0];
    if (started?.event !== 'run_started') throw new Error('Expected sampled run start.');
    expect(started.data.selection).toMatchObject({
      total_cases: 101,
      matched_cases: 50,
      selected_cases: 25,
    });
    expect(selected.events.filter((event) => event.event === 'case_started')).toHaveLength(25);
    expect(selected.final).toMatchObject({
      result: { result: { selection: started.data.selection, summary: { total_cases: 25 } } },
    });

    const store = await openStore(join(root, '.attest', 'runs.db'));
    try {
      const stored = await store.runs.getRunWithCases(selected.runId);
      const snapshot = evalRunSchema.parse(JSON.parse(stored.run.configJson)).snapshot;
      expect(stored.cases).toHaveLength(25);
      expect(snapshot.selected_cases.map(({ case_id }) => case_id).sort()).toEqual(
        stored.cases.map(({ caseId }) => caseId).sort(),
      );
      expect(
        stored.cases.every(({ caseId }) => Number(caseId.replace('sample-', '')) % 2 === 0),
      ).toBe(true);
      const diff = await diffRuns(store.runs, baseline.runId, selected.runId);
      expect(diff.summary.coverage).toEqual({
        sharedCases: 25,
        baseOnlyCases: 76,
        candidateOnlyCases: 0,
      });
      expect(diff.summary.counts.removed).toBe(0);
      expect(diff.transitions).toHaveLength(25);
    } finally {
      await store.close();
    }
  }, 30_000);

  it('runs through resolver, engine, runner, store, baseline, and JUnit', async () => {
    const root = await createEvalProject();
    const junitPath = join(root, 'artifacts', 'first.xml');
    const first = await runEval(root, { test_ids: ['smoke'], junit_path: junitPath });
    expect(first.final).toMatchObject({
      exit_code: 0,
      result: {
        ok: true,
        result: {
          status: 'completed',
          summary: {
            total_cases: 1,
            passed_cases: 1,
            failed_cases: 0,
            error_cases: 0,
            metric_error_count: 0,
          },
          verdict: 'pass',
        },
      },
    });
    const junit = await readFile(junitPath, 'utf8');
    expect(junit).toContain('<testsuite name="smoke" tests="1"');
    expect(junit).not.toMatch(/\n\n$/u);

    const second = await runEval(root, { test_ids: ['smoke'], baseline_run_id: first.runId });
    expect(second.final.exit_code).toBe(0);

    const store = await openStore(join(root, '.attest', 'runs.db'));
    try {
      const firstRun = await store.runs.getRun(first.runId);
      const persistedEval = evalRunSchema.parse(JSON.parse(firstRun.configJson));
      expect(firstRun).toMatchObject({
        status: 'completed',
        schemaId: EVAL_RUN_SCHEMA_ID,
        configHash: persistedEval.snapshot_hash,
        labels: { kind: 'eval', snapshot_hash: persistedEval.snapshot_hash },
      });
      expect(persistedEval).toMatchObject({
        run_id: firstRun.id,
        created_at: firstRun.createdAt,
        effective_command: { request: { command: 'eval.run', test_ids: ['smoke'] } },
      });
      expect((await store.runs.getRun(second.runId)).status).toBe('completed');
      expect(await store.runs.getCaseResults(firstRun.id)).toMatchObject([
        {
          suiteName: 'smoke',
          caseId: 'capital',
          outcome: 'completed',
          metrics: [{ metricName: 'exact', status: 'evaluated', pass: true, score: 1 }],
        },
      ]);
    } finally {
      await store.close();
    }
    expect(await readdir(join(root, '.attest', 'eval-runs'))).toEqual([]);
  }, 15_000);

  it('rejects a missing baseline before agent, run-store, or registry side effects', async () => {
    const root = await temporaryDirectory('attest-run-configuration-marker-');
    const markerPath = join(root, 'agent-invoked');
    const project = await createEvalProject({ agentSource: markerAgent(markerPath) });

    await expect(
      startEval(project, { test_ids: ['smoke'], baseline_run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAA' }),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(project, '.attest', 'runs.db'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(join(project, '.attest', 'eval-runs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a symlinked eval storage boundary before agent or outside-project writes', async () => {
    const outside = await temporaryDirectory('attest-eval-storage-outside-');
    const markerPath = join(outside, 'agent-invoked');
    const root = await createEvalProject({ agentSource: markerAgent(markerPath) });
    await rm(join(root, '.attest'), { force: true, recursive: true });
    await symlink(outside, join(root, '.attest'));

    await expect(startEval(root, { test_ids: ['smoke'] })).rejects.toMatchObject({
      code: 'run_failed',
      path: '.attest/runs.db',
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('redacts executable metric secrets from results and persisted evidence', async () => {
    const secret = 'eval-metric-secret-must-never-persist';
    process.env.ATTEST_EVAL_METRIC_SECRET = secret;
    const secretMetric = (mode: 'pass' | 'error'): MetricResource => ({
      schema: METRIC_RESOURCE_SCHEMA_ID,
      id: `secret-${mode}`,
      name: `secret-${mode}`,
      definition: {
        kind: 'exec',
        argv: [process.execPath, './metric.mjs', mode],
        env: { METRIC_SECRET: { from_env: 'ATTEST_EVAL_METRIC_SECRET' } },
      },
    });
    const root = await createEvalProject({
      metrics: [secretMetric('pass'), secretMetric('error')],
      tests: (['pass', 'error'] as const).map((mode) =>
        testResource(`secret-${mode}`, `secret-${mode}`, [
          { id: `secret-${mode}`, input: 'Paris' },
        ]),
      ),
    });
    await writeFile(
      join(root, 'metric.mjs'),
      [
        "let source = '';",
        "process.stdin.setEncoding('utf8');",
        'for await (const chunk of process.stdin) source += chunk;',
        'JSON.parse(source);',
        "if (process.argv[2] === 'error') {",
        '  process.stderr.write(`useful stderr: ${process.env.METRIC_SECRET}: retry context`);',
        '  process.exitCode = 7;',
        '} else {',
        '  process.stdout.write(JSON.stringify({',
        '    score: 1,',
        '    pass: true,',
        '    rationale: `useful rationale: ${process.env.METRIC_SECRET}` ,',
        "    details: { context: 'retained', nested: `prefix ${process.env.METRIC_SECRET} suffix` },",
        '  }));',
        '}',
      ].join('\n'),
    );

    const passed = await runEval(root, { test_ids: ['secret-pass'] });
    const failed = await runEval(root, { test_ids: ['secret-error'] });
    expect(passed.final.exit_code).toBe(0);
    expect(failed.final).toMatchObject({
      exit_code: 4,
      result: { error: { code: 'run_failed', retryable: true } },
    });
    expect(JSON.stringify([passed.events, failed.events])).not.toContain(secret);

    const store = await openStore(join(root, '.attest', 'runs.db'));
    try {
      const passedEvidence = JSON.stringify(await store.runs.getCaseResults(passed.runId));
      const failedEvidence = JSON.stringify(await store.runs.getCaseResults(failed.runId));
      expect(passedEvidence).toContain('retained');
      for (const evidence of [passedEvidence, failedEvidence]) {
        expect(evidence).not.toContain(secret);
        expect(evidence).toContain(REDACTED);
      }
    } finally {
      await store.close();
    }
  }, 20_000);

  it('cancels only the addressed run when two evals share one process', async () => {
    const root = await temporaryDirectory('attest-run-configuration-release-');
    const releasePath = join(root, 'release-agent');
    const project = await createEvalProject({
      agentSource: [
        "import { existsSync } from 'node:fs';",
        "let source = '';",
        "process.stdin.setEncoding('utf8');",
        'for await (const chunk of process.stdin) source += chunk;',
        'const request = JSON.parse(source);',
        `while (!existsSync(${JSON.stringify(releasePath)})) {`,
        '  await new Promise((resolve) => setTimeout(resolve, 10));',
        '}',
        "process.stdout.write(JSON.stringify({ protocol: 'attest.agent-invocation', output: request.input }));",
      ].join('\n'),
    });
    // runConfiguration returns only after the run is registered, so it is cancellable now.
    const first = collectEval(await startEval(project, { test_ids: ['smoke'] }));
    const second = collectEval(await startEval(project, { test_ids: ['smoke'] }));
    const [firstRunId] = (await readdir(join(project, '.attest', 'eval-runs')))
      .filter((file) => file.endsWith('.json') && !file.endsWith('.cancel.json'))
      .map((file) => file.slice(0, -'.json'.length))
      .sort();
    if (firstRunId === undefined) throw new Error('Expected a registered eval run.');

    await expect(
      cancelConfiguration(
        {
          schema: COMMAND_REQUEST_SCHEMA_ID,
          command: 'eval.cancel',
          run_id: firstRunId,
          output: 'json',
        },
        { workingDirectory: project },
      ),
    ).resolves.toMatchObject({ runId: firstRunId, status: 'cancellation_requested' });

    await writeFile(releasePath, 'release');
    const outcomes = await Promise.all([first, second]);
    const cancelled = outcomes.find(({ runId }) => runId === firstRunId);
    const completed = outcomes.find(({ runId }) => runId !== firstRunId);
    expect(cancelled?.final).toMatchObject({
      exit_code: 130,
      result: { ok: false, error: { code: 'cancelled', retryable: true } },
    });
    expect(completed?.final).toMatchObject({ exit_code: 0, result: { ok: true } });
    expect(await readdir(join(project, '.attest', 'eval-runs'))).toEqual([]);
  }, 15_000);
});
