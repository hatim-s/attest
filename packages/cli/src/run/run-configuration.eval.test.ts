import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EVAL_RUN_SCHEMA_VERSION, evalEventStreamSchema, evalRunSchema } from '@attest/contracts';
import { openStore } from '@attest/core';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../run-cli.js';

const temporaryDirectories: string[] = [];

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

/** Authors the smallest complete v2 project through the registered public mutation surface. */
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
      "process.stdout.write(JSON.stringify({ protocol: 'attest.agent/v1alpha1', output: request.input }));",
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('v2 eval dispatcher integration', () => {
  it('bridges public commands through resolver, engine, runner, store, diff, and JUnit', async () => {
    const root = await createEvalProject();
    const first = await invokeCli(root, [
      'eval',
      'run',
      'smoke',
      '--junit',
      'artifacts/first.xml',
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

    const junit = await readFile(join(root, 'artifacts', 'first.xml'), 'utf8');
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
        configVersion: EVAL_RUN_SCHEMA_VERSION,
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

  it('cancels an active run through the registry and removes process signal listeners', async () => {
    const root = await createEvalProject();
    await writeFile(
      join(root, 'agent.mjs'),
      [
        "let source = '';",
        "process.stdin.setEncoding('utf8');",
        'for await (const chunk of process.stdin) source += chunk;',
        'const request = JSON.parse(source);',
        'await new Promise((resolve) => setTimeout(resolve, 30_000));',
        "process.stdout.write(JSON.stringify({ protocol: 'attest.agent/v1alpha1', output: request.input }));",
      ].join('\n'),
    );
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const running = invokeCli(root, ['eval', 'run', 'smoke', '--output', 'jsonl']);
    const runId = await waitForActiveRun(root);

    const cancellation = await invokeCli(root, ['eval', 'cancel', runId, '--output', 'json']);
    expect(cancellation).toMatchObject({ exitCode: 0, errors: [] });
    expect(JSON.parse(cancellation.output[0] ?? '{}')).toMatchObject({
      ok: true,
      command: 'eval.cancel',
      result: { run_id: runId, status: 'cancellation_requested' },
    });

    const completed = await running;
    expect(completed).toMatchObject({ exitCode: 130, errors: [] });
    const events = evalEventStreamSchema.parse(
      completed.output.map((line): unknown => JSON.parse(line) as unknown),
    );
    expect(events.at(-1)).toMatchObject({
      event: 'result',
      data: {
        exit_code: 130,
        result: { ok: false, command: 'eval.run', error: { code: 'eval_cancelled' } },
      },
    });
    expect(await readdir(join(root, '.attest', 'eval-runs'))).toEqual([]);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  }, 15_000);
});
