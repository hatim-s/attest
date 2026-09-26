import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EVAL_RUN_SCHEMA_ID, evalEventStreamSchema, evalRunSchema } from '@attest/contracts';
import { diffRuns } from '@attest/core';
import { openStore } from '@attest/local/store';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../run-cli.js';
const REDACTED = '[REDACTED]';

const temporaryDirectories: string[] = [];
const originalEvalMetricSecret = process.env.ATTEST_EVAL_METRIC_SECRET;

type CliInvocation = {
  errors: string[];
  exitCode: number;
  output: string[];
};

/** Executes one public CLI command against an isolated project and captures both output streams. */
const invokeCli = async (root: string, argv: readonly string[]): Promise<CliInvocation> => {
  const errors: string[] = [];
  const output: string[] = [];
  const exitCode = await runCli([...argv], {
    workingDirectory: root,
    io: {
      error: (message) => errors.push(message),
      output: (message) => output.push(message),
    },
  });
  return { errors, exitCode, output };
};

/** Requires a successful authoring command so setup failures retain their machine-readable output. */
const author = async (root: string, argv: readonly string[]): Promise<void> => {
  const result = await invokeCli(root, argv);
  if (result.exitCode !== 0) {
    throw new Error(
      `Authoring command failed (${argv.join(' ')}): ${result.output.join('')} ${result.errors.join('')}`,
    );
  }
};

/** Authors the smallest complete project through the registered public mutation surface. */
const createEvalProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'attest-eval-integration-'));
  temporaryDirectories.push(root);
  await author(root, [
    'project',
    'init',
    '.',
    '--name',
    'Eval integration',
    '--non-interactive',
    '--output',
    'json',
  ]);
  await writeFile(
    join(root, 'agent.mjs'),
    [
      "let source = '';",
      "process.stdin.setEncoding('utf8');",
      'for await (const chunk of process.stdin) source += chunk;',
      'const request = JSON.parse(source);',
      "process.stdout.write(JSON.stringify({ protocol: 'attest.agent-invocation', output: request.input }));",
    ].join('\n'),
  );
  await author(root, [
    'agent',
    'add',
    'support',
    '--argv-json',
    JSON.stringify([process.execPath, './agent.mjs']),
    '--non-interactive',
    '--output',
    'json',
  ]);
  await author(root, [
    'metric',
    'add',
    'exact',
    '--preset',
    'output-equals',
    '--value',
    '"Paris"',
    '--non-interactive',
    '--output',
    'json',
  ]);
  await author(root, [
    'test',
    'add',
    'smoke',
    '--agent',
    'support',
    '--metric',
    'exact',
    '--non-interactive',
    '--output',
    'json',
  ]);
  await author(root, [
    'test',
    'case',
    'add',
    'smoke',
    '--id',
    'capital',
    '--input',
    '"Paris"',
    '--non-interactive',
    '--output',
    'json',
  ]);
  return root;
};

/** Waits for the dispatcher to atomically publish one active-run registry record. */
const waitForActiveRun = async (root: string): Promise<string> => {
  const directory = join(root, '.attest', 'eval-runs');
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const files = await readdir(directory).catch(() => []);
    const record = files.find((file) => file.endsWith('.json'));
    if (record !== undefined) return record.slice(0, -'.json'.length);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the active eval registry.');
};

/** Waits until the requested number of owned registry records have been published. */
const waitForActiveRuns = async (root: string, count: number): Promise<string[]> => {
  const directory = join(root, '.attest', 'eval-runs');
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const records = (await readdir(directory).catch(() => [])).filter(
      (file) => file.endsWith('.json') && !file.endsWith('.cancel.json'),
    );
    if (records.length >= count) {
      return records.map((file) => file.slice(0, -'.json'.length)).sort();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${String(count)} active eval registries.`);
};

afterEach(async () => {
  if (originalEvalMetricSecret === undefined) delete process.env.ATTEST_EVAL_METRIC_SECRET;
  else process.env.ATTEST_EVAL_METRIC_SECRET = originalEvalMetricSecret;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('eval dispatcher integration', () => {
  it('treats unselected tests as coverage differences when every case in the selected test runs', async () => {
    const root = await createEvalProject();
    await author(root, [
      'test',
      'add',
      'other',
      '--agent',
      'support',
      '--metric',
      'exact',
      '--non-interactive',
      '--output',
      'json',
    ]);
    await author(root, [
      'test',
      'case',
      'add',
      'other',
      '--id',
      'other-case',
      '--input',
      '"Paris"',
      '--non-interactive',
      '--output',
      'json',
    ]);
    const runIds: string[] = [];
    for (const selection of [['--all'], ['smoke']]) {
      const result = await invokeCli(root, ['eval', 'run', ...selection, '--output', 'jsonl']);
      expect(result.exitCode).toBe(0);
      const started = evalEventStreamSchema.parse(
        result.output.map((line): unknown => JSON.parse(line)),
      )[0];
      if (started?.event !== 'run_started') throw new Error('Expected run start.');
      runIds.push(started.data.run_id);
    }
    const store = await openStore(join(root, '.attest', 'runs.db'));
    try {
      const diff = await diffRuns(store.runs, runIds[0]!, runIds[1]!);
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
    const root = await createEvalProject();
    const source = join(root, 'cases.jsonl');
    await writeFile(
      source,
      Array.from({ length: 100 }, (_, index) =>
        JSON.stringify({
          id: `sample-${index}`,
          input: 'Paris',
          params: { index },
          tags: [index % 2 === 0 ? 'smoke' : 'slow'],
          folder: 'billing/refunds',
        }),
      ).join('\n'),
    );
    await author(root, [
      'test',
      'case',
      'import',
      'smoke',
      source,
      '--non-interactive',
      '--output',
      'json',
    ]);
    const full = await invokeCli(root, ['eval', 'run', 'smoke', '--output', 'jsonl']);
    expect(full.exitCode).toBe(0);
    const baseline = evalEventStreamSchema.parse(
      full.output.map((line): unknown => JSON.parse(line)),
    )[0];
    if (baseline?.event !== 'run_started') throw new Error('Expected baseline run start.');
    const selected = await invokeCli(root, [
      'eval',
      'run',
      'smoke',
      '--folder',
      'billing',
      '--tag',
      'smoke',
      '--sample',
      '25',
      '--seed',
      'integration',
      '--baseline',
      baseline.data.run_id,
      '--output',
      'jsonl',
    ]);
    expect(selected.exitCode).toBe(0);
    const events = evalEventStreamSchema.parse(
      selected.output.map((line): unknown => JSON.parse(line)),
    );
    const started = events[0];
    if (started?.event !== 'run_started') throw new Error('Expected sampled run start.');
    expect(started.data.selection).toMatchObject({
      total_cases: 101,
      matched_cases: 50,
      selected_cases: 25,
    });
    expect(events.filter((event) => event.event === 'case_started')).toHaveLength(25);
    expect(events.at(-1)).toMatchObject({
      data: {
        result: { result: { selection: started.data.selection, summary: { total_cases: 25 } } },
      },
    });
    const store = await openStore(join(root, '.attest', 'runs.db'));
    try {
      const stored = await store.runs.getRunWithCases(started.data.run_id);
      const snapshot = evalRunSchema.parse(JSON.parse(stored.run.configJson)).snapshot;
      expect(stored.cases).toHaveLength(25);
      expect(snapshot.selected_cases.map(({ case_id }) => case_id).sort()).toEqual(
        stored.cases.map(({ caseId }) => caseId).sort(),
      );
      expect(
        stored.cases.every(({ caseId }) => Number(caseId.replace('sample-', '')) % 2 === 0),
      ).toBe(true);
      const diff = await diffRuns(store.runs, baseline.data.run_id, started.data.run_id);
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

  it('bridges public commands through resolver, engine, runner, store, diff, and JUnit', async () => {
    const root = await createEvalProject();
    const junitPath = join(root, 'artifacts', 'first.xml');
    const first = await invokeCli(root, [
      'eval',
      'run',
      'smoke',
      '--junit',
      junitPath,
      '--output',
      'json',
    ]);
    expect(first).toMatchObject({ exitCode: 0, errors: [] });
    expect(first.output).toHaveLength(1);
    const firstResult = JSON.parse(first.output[0] ?? '{}') as {
      result: { run_id: string; snapshot_hash: string };
    };
    expect(firstResult).toMatchObject({
      ok: true,
      command: 'eval.run',
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
    });

    const junit = await readFile(junitPath, 'utf8');
    expect(junit).toContain('<testsuite name="smoke" tests="1"');
    expect(junit).not.toMatch(/\n\n$/u);

    const second = await invokeCli(root, [
      'eval',
      'run',
      'smoke',
      '--baseline',
      firstResult.result.run_id,
      '--output',
      'jsonl',
    ]);
    expect(second).toMatchObject({ exitCode: 0, errors: [] });
    const events = evalEventStreamSchema.parse(
      second.output.map((line): unknown => JSON.parse(line) as unknown),
    );
    expect(events.map(({ event }) => event)).toEqual([
      'run_started',
      'case_started',
      'case_completed',
      'run_completed',
      'result',
    ]);
    expect(events.at(-1)).toMatchObject({
      data: { exit_code: 0, result: { ok: true, command: 'eval.run' } },
    });
    const started = events.find((event) => event.event === 'run_started');
    if (started?.event !== 'run_started') throw new Error('Expected a run_started event.');
    const secondRunId = started.data.run_id;

    const store = await openStore(join(root, '.attest', 'runs.db'));
    try {
      const firstRun = await store.runs.getRun(firstResult.result.run_id);
      const secondRun = await store.runs.getRun(secondRunId);
      const persistedEval = evalRunSchema.parse(JSON.parse(firstRun.configJson));
      expect(firstRun).toMatchObject({
        id: firstResult.result.run_id,
        status: 'completed',
        schemaId: EVAL_RUN_SCHEMA_ID,
        configHash: firstResult.result.snapshot_hash,
        labels: { kind: 'eval', snapshot_hash: firstResult.result.snapshot_hash },
      });
      expect(persistedEval).toMatchObject({
        run_id: firstRun.id,
        created_at: firstRun.createdAt,
        effective_command: { request: { command: 'eval.run', test_ids: ['smoke'] } },
      });
      expect(secondRun.status).toBe('completed');
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
    const root = await createEvalProject();
    const markerPath = join(root, 'agent-invoked');
    await writeFile(
      join(root, 'agent.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'invoked');`,
        "process.stdout.write(JSON.stringify({ protocol: 'attest.agent-invocation', output: 'Paris' }));",
      ].join('\n'),
    );

    const result = await invokeCli(root, [
      'eval',
      'run',
      'smoke',
      '--baseline',
      '01ARZ3NDEKTSV4RRFFQ69G5FAA',
      '--output',
      'json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output[0] ?? '{}')).toMatchObject({
      ok: false,
      command: 'eval.run',
      error: { code: 'resource_not_found' },
    });
    await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(root, '.attest', 'runs.db'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(join(root, '.attest', 'eval-runs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a symlinked eval storage boundary before agent or outside-project writes', async () => {
    const root = await createEvalProject();
    const outside = await mkdtemp(join(tmpdir(), 'attest-eval-storage-outside-'));
    temporaryDirectories.push(outside);
    const markerPath = join(root, 'agent-invoked');
    await writeFile(
      join(root, 'agent.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath)}, 'invoked');`,
        "process.stdout.write(JSON.stringify({ protocol: 'attest.agent-invocation', output: 'Paris' }));",
      ].join('\n'),
    );
    await rm(join(root, '.attest'), { recursive: true });
    await symlink(outside, join(root, '.attest'));

    const result = await invokeCli(root, ['eval', 'run', 'smoke', '--output', 'json']);

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.output[0] ?? '{}')).toMatchObject({
      ok: false,
      command: 'eval.run',
      error: { code: 'run_failed', path: '.attest/runs.db', retryable: true },
    });
    await expect(access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('redacts executable metric secrets before results, persistence, reports, and errors', async () => {
    const root = await createEvalProject();
    const secret = 'eval-metric-secret-must-never-persist';
    process.env.ATTEST_EVAL_METRIC_SECRET = secret;
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
    for (const mode of ['pass', 'error'] as const) {
      await author(root, [
        'metric',
        'add',
        `secret-${mode}`,
        '--preset',
        'command',
        '--argv-json',
        JSON.stringify([process.execPath, './metric.mjs', mode]),
        '--env',
        'METRIC_SECRET=ATTEST_EVAL_METRIC_SECRET',
        '--non-interactive',
        '--output',
        'json',
      ]);
      await author(root, [
        'test',
        'add',
        `secret-${mode}`,
        '--agent',
        'support',
        '--metric',
        `secret-${mode}`,
        '--non-interactive',
        '--output',
        'json',
      ]);
      await author(root, [
        'test',
        'case',
        'add',
        `secret-${mode}`,
        '--id',
        `secret-${mode}`,
        '--input',
        '"Paris"',
        '--non-interactive',
        '--output',
        'json',
      ]);
    }

    const successful = await invokeCli(root, ['eval', 'run', 'secret-pass', '--output', 'json']);
    const successDocument = JSON.parse(successful.output[0] ?? '{}') as {
      result: { run_id: string };
    };
    expect(successful.exitCode).toBe(0);
    expect(JSON.stringify(successful)).not.toContain(secret);

    const failed = await invokeCli(root, ['eval', 'run', 'secret-error', '--output', 'jsonl']);
    const failedEvents = evalEventStreamSchema.parse(
      failed.output.map((line): unknown => JSON.parse(line) as unknown),
    );
    const failedRunId = failedEvents[0]?.event === 'run_started' ? failedEvents[0].data.run_id : '';
    expect(failed.exitCode).toBe(4);
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(failedEvents.at(-1)).toMatchObject({
      event: 'result',
      data: {
        exit_code: 4,
        result: { error: { code: 'run_failed', retryable: true } },
      },
    });

    const store = await openStore(join(root, '.attest', 'runs.db'));
    try {
      for (const runId of [successDocument.result.run_id, failedRunId]) {
        const evidence = JSON.stringify(await store.runs.getCaseResults(runId));
        expect(evidence).not.toContain(secret);
        expect(evidence).toContain(REDACTED);
        if (runId === successDocument.result.run_id) expect(evidence).toContain('retained');
      }
    } finally {
      await store.close();
    }

    for (const runId of [successDocument.result.run_id, failedRunId]) {
      const outputPath = `reports/${runId}.html`;
      expect((await invokeCli(root, ['report', runId, '--output', outputPath])).exitCode).toBe(0);
      const report = await readFile(join(root, outputPath), 'utf8');
      expect(report).not.toContain(secret);
      expect(report).toContain(REDACTED);
    }
    const humanFailure = await invokeCli(root, ['eval', 'run', 'secret-error']);
    expect(humanFailure.exitCode).toBe(4);
    expect(JSON.stringify(humanFailure)).not.toContain(secret);
    expect(humanFailure.errors.join('\n')).toContain('run_failed');
  }, 20_000);

  it('cancels only the addressed run when two evals share one embedding process', async () => {
    const root = await createEvalProject();
    const releasePath = join(root, 'release-agent');
    await writeFile(
      join(root, 'agent.mjs'),
      [
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
    );
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const firstRun = invokeCli(root, ['eval', 'run', 'smoke', '--output', 'jsonl']);
    const runId = await waitForActiveRun(root);
    const secondRun = invokeCli(root, ['eval', 'run', 'smoke', '--output', 'jsonl']);
    const activeRunIds = await waitForActiveRuns(root, 2);
    const secondRunId = activeRunIds.find((activeRunId) => activeRunId !== runId);
    if (secondRunId === undefined) throw new Error('Expected a distinct second eval run.');

    const cancellation = await invokeCli(root, ['eval', 'cancel', runId, '--output', 'json']);
    expect(cancellation).toMatchObject({ exitCode: 0, errors: [] });
    expect(JSON.parse(cancellation.output[0] ?? '{}')).toMatchObject({
      ok: true,
      command: 'eval.cancel',
      result: { run_id: runId, status: 'cancellation_requested' },
    });

    await writeFile(releasePath, 'release');
    const [cancelled, completed] = await Promise.all([firstRun, secondRun]);
    expect(cancelled).toMatchObject({ exitCode: 130, errors: [] });
    expect(completed).toMatchObject({ exitCode: 0, errors: [] });
    const events = evalEventStreamSchema.parse(
      cancelled.output.map((line): unknown => JSON.parse(line) as unknown),
    );
    expect(events.at(-1)).toMatchObject({
      event: 'result',
      data: {
        exit_code: 130,
        result: {
          ok: false,
          command: 'eval.run',
          error: { code: 'cancelled', retryable: true },
        },
      },
    });
    const completedEvents = evalEventStreamSchema.parse(
      completed.output.map((line): unknown => JSON.parse(line) as unknown),
    );
    expect(completedEvents[0]).toMatchObject({
      event: 'run_started',
      data: { run_id: secondRunId },
    });
    expect(completedEvents.at(-1)).toMatchObject({
      event: 'result',
      data: { exit_code: 0, result: { ok: true } },
    });
    expect(await readdir(join(root, '.attest', 'eval-runs'))).toEqual([]);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  }, 15_000);
});
