import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentRunner } from '@attest/client';
import { serveAgentRunner } from '@attest/client/node';
import { createPiHandler } from '@attest/client/pi';
import {
  AGENT_RESOURCE_SCHEMA_ID,
  cliResultSchema,
  evalFinalResultDataSchema,
  type AgentResource,
  type EvalFinalResultData,
} from '@attest/contracts';
import {
  caseRecordSchema,
  caseSummaryPageSchema,
  runPageSchema,
  type CaseRecord,
  type CaseSummary,
} from '@attest/core/records';
import { describe, expect, inject, it, vi } from 'vitest';

import { REPOSITORY_ROOT, runPackedCommand, type PackedCli } from './packed-cli.js';

const MOCK_PI = join(REPOSITORY_ROOT, 'packages/client/src/_tests_/fixtures/mock-pi.cjs');

/** The project name; the dashboard derives the same project key from it. */
const PROJECT = 'callback-pi';

const TEST_ID = 'write-answer';

const CASE_ID = 'answer';

const ANSWER = 'export const answer = 42;\n';

/** Passes only when `answer.ts` is listed in `artifacts` and its file under `artifact_dir` holds the answer. */
const SCORE_METRIC = [
  "import { readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  '',
  "let source = '';",
  'for await (const chunk of process.stdin) source += chunk;',
  'const request = JSON.parse(source);',
  "const listed = request.artifacts.some((artifact) => artifact.path === 'answer.ts');",
  "const answer = listed ? readFileSync(join(request.artifact_dir, 'answer.ts'), 'utf8') : '';",
  "const pass = answer.includes('export const answer = 42');",
  'process.stdout.write(JSON.stringify({ score: pass ? 1 : 0, pass }));',
].join('\n');

type Journey = {
  /** The eval result envelope, bound to the process exit code by the contract schema. */
  evaluation: EvalFinalResultData;
  record: CaseRecord;
  summary: CaseSummary;
};

/** Runs one packed CLI command and fails with its output unless it exits 0. */
const runOk = async (packed: PackedCli, argv: readonly string[], root: string): Promise<void> => {
  const result = await runPackedCommand(packed, argv, root);

  expect(result.exitCode, `${argv.join(' ')}: ${result.stderr || result.stdout}`).toBe(0);
  expect(cliResultSchema.parse(JSON.parse(result.stdout)).ok).toBe(true);
};

/** Starts `attest view` on a free loopback port and returns its API origin and a stop function. */
const startView = async (
  packed: PackedCli,
  root: string,
): Promise<{ api: string; stop: () => Promise<void> }> => {
  const child = spawn(
    process.execPath,
    ['--no-warnings', packed.cliPath, 'view', '--no-open', '--port', '0'],
    {
      cwd: root,
      env: { ...process.env, ATTEST_HOME: packed.attestHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  const stop = async (): Promise<void> => {
    child.kill('SIGINT');
    const forceStop = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(forceStop);
  };

  let stdout = '';
  child.stdout.setEncoding('utf8');

  const origin = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('attest view did not start in 30s.')), 30_000);

    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`attest view exited with ${String(code)} before it was ready.`));
    });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /Attest view: (http:\/\/127\.0\.0\.1:\d+)\//u.exec(stdout);

      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
  });

  try {
    return { api: `${await origin}/api/projects/${PROJECT}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};

/** Fetches one dashboard API path and fails on a non-200 answer. */
const fetchOk = async (url: string): Promise<Response> => {
  const response = await fetch(url);

  expect(response.status, url).toBe(200);

  return response;
};

/**
 * Serves the `@attest/client` Pi runner over the mock Pi, authors a callback agent against it in a
 * temp project with the packed CLI, runs `attest eval run --all`, and reads the persisted case back
 * through the dashboard API. `mockPiFlags` go to the mock Pi, such as `--mock-fail`.
 */
const runCallbackJourney = async (mockPiFlags: readonly string[]): Promise<Journey> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attest-callback-pi-')));
  const attestHome = await mkdtemp(join(tmpdir(), 'attest-callback-pi-home-'));
  const packed: PackedCli = { ...inject('packedCli'), attestHome };
  const triggerToken = randomBytes(32).toString('base64url');

  const runner = createAgentRunner({
    handler: createPiHandler({ argv: [process.execPath, MOCK_PI, ...mockPiFlags] }),
    triggerToken,
  });

  const served = await serveAgentRunner(runner, { port: 0 });
  let stopView: (() => Promise<void>) | undefined;

  try {
    // The packed CLI inherits this; the agent resource names it instead of holding the token.
    vi.stubEnv('ATTEST_TRIGGER_AUTHORIZATION', `Bearer ${triggerToken}`);

    const agent: AgentResource = {
      schema: AGENT_RESOURCE_SCHEMA_ID,
      id: 'pi',
      name: 'Pi coding agent',
      transport: {
        kind: 'callback',
        lifecycle: 'external',
        trigger: {
          url: `${served.url}/`,
          method: 'POST',
          headers: { authorization: { from_env: 'ATTEST_TRIGGER_AUTHORIZATION' } },
        },
        idempotency_header: 'Idempotency-Key',
      },
      timeouts: { attempt_ms: 30_000 },
      redaction: { headers: ['authorization'] },
    };

    await writeFile(join(root, 'pi-agent.json'), JSON.stringify(agent, null, 2));
    await writeFile(join(root, 'score.mjs'), SCORE_METRIC);

    const commands = [
      ['project', 'init', '.', '--name', PROJECT, '--non-interactive'],
      ['agent', 'import', './pi-agent.json', '--as', 'pi'],
      ['metric', 'add', 'answer', '--preset', 'command', '--argv-json', '["node","score.mjs"]'],
      ['test', 'add', TEST_ID, '--agent', 'pi', '--metric', 'answer'],
      ['test', 'case', 'add', TEST_ID, '--id', CASE_ID, '--input', '"Write answer.ts"'],
    ];

    for (const argv of commands) await runOk(packed, [...argv, '--output', 'json'], root);

    const run = await runPackedCommand(packed, ['eval', 'run', '--all', '--output', 'json'], root);

    expect(run.stderr).toBe('');

    const printed: unknown = JSON.parse(run.stdout);

    const evaluation = evalFinalResultDataSchema.parse({
      exit_code: run.exitCode,
      result: printed,
    });

    const view = await startView(packed, root);

    stopView = view.stop;

    // A failed run prints no run id, so read the only run back from the store.
    const [stored, ...others] = runPageSchema.parse(
      await (await fetchOk(`${view.api}/runs`)).json(),
    ).items;

    expect(others).toEqual([]);

    if (stored === undefined) throw new Error('The eval run was not persisted.');

    const casesUrl = `${view.api}/runs/${stored.id}/cases`;
    const [summary] = caseSummaryPageSchema.parse(await (await fetchOk(casesUrl)).json()).items;

    if (summary === undefined) throw new Error('The eval run persisted no case.');

    const record = caseRecordSchema.parse(
      await (await fetchOk(`${casesUrl}/${TEST_ID}/${CASE_ID}`)).json(),
    );

    return { evaluation, record, summary };
  } finally {
    vi.unstubAllEnvs();
    await stopView?.();
    await runner.close();
    await served.close();
    await rm(root, { force: true, recursive: true });
    await rm(attestHome, { force: true, recursive: true });
  }
};

describe('callback agent through the packed CLI and the @attest/client Pi runner', () => {
  it('scores the file Pi wrote and records it with the trace', async () => {
    const { evaluation, record, summary } = await runCallbackJourney([]);

    expect(evaluation).toMatchObject({
      exit_code: 0,
      result: { ok: true, result: { verdict: 'pass', summary: { passed_cases: 1 } } },
    });
    expect(summary).toMatchObject({ caseId: CASE_ID, verdict: 'pass' });

    if (record.outcome !== 'completed') throw new Error(`Case ${record.outcome}, not completed.`);
    // The mock Pi's write tool created answer.ts in its workspace; the handler sent it inline.
    expect(record.response).toMatchObject({
      output: 'Wrote answer.ts',
      artifacts: [
        {
          kind: 'inline',
          path: 'answer.ts',
          media_type: 'text/typescript',
          encoding: 'utf8',
          content: ANSWER,
        },
      ],
    });
    expect(record.trace?.spans.find((span) => span.kind === 'tool')).toMatchObject({
      name: 'tool.write',
      attributes: { 'gen_ai.tool.name': 'write' },
    });
    expect(record.metrics).toMatchObject([
      { metricName: 'answer', status: 'evaluated', pass: true, score: 1 },
    ]);
  }, 120_000);

  it('records an agent error with no artifacts when Pi fails', async () => {
    const { evaluation, record, summary } = await runCallbackJourney(['--mock-fail']);

    // An errored case fails the run as a whole; see docs/reference/exit-codes.md.
    expect(evaluation).toMatchObject({
      exit_code: 4,
      result: { ok: false, error: { code: 'run_failed' } },
    });
    expect(summary).toMatchObject({ caseId: CASE_ID, verdict: 'error' });

    if (record.outcome !== 'completed') throw new Error(`Case ${record.outcome}, not completed.`);
    expect(record.response.error).toEqual({
      code: 'pi_agent_failed',
      message: '--mock-fail requested',
    });
    expect(record.response.artifacts).toBeUndefined();
    // The completion still carried the trace; only the score is missing.
    expect(record.trace?.spans.map((span) => span.name)).toEqual(['agent.run', 'llm.call']);
    expect(record.metrics).toMatchObject([
      { metricName: 'answer', status: 'error', error: { kind: 'skipped_no_output' } },
    ]);
  }, 120_000);
});
