import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_PROTOCOL, type AgentTarget, type Config } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigInvalidError } from './errors.js';
import { collectExecutions } from './execute.js';
import type { CaseExecution, RunProgressEvent } from './types.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const CLI_AGENT_PATH = join(REPOSITORY_ROOT, 'conformance/fake-agents/cli-agent.cjs');
const HTTP_AGENT_PATH = join(REPOSITORY_ROOT, 'conformance/fake-agents/http-agent.cjs');
const RUN_ID = '01J9ZK7Q2M5X8W4V3T2R1QPN0M';
const temporaryDirectories: string[] = [];

type CanonicalServer = { baseUrl: string; child: ChildProcess; closed: Promise<void> };
type CountingServer = {
  baseUrl: string;
  maximumInFlight: () => number;
  release: () => void;
  started: Promise<void>;
  server: Server;
};

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-execute-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

const createConfig = (
  agent: AgentTarget,
  suites: Config['suites'],
  run: Config['run'] = undefined,
): Config => ({
  config_version: 1,
  agent,
  suites,
  metrics: [
    { name: 'suite-metric', type: 'assertion', assert: [{ exists: { path: '$' } }] },
    { name: 'case-metric', type: 'assertion', assert: [{ exists: { path: '$' } }] },
  ],
  run,
});

const canonicalCliTarget = (behavior: string, retries = 0): AgentTarget => ({
  type: 'cli',
  command: [process.execPath, CLI_AGENT_PATH, `--behavior=${behavior}`],
  retries,
});

const execute = async (
  config: Config,
  baseDirectory: string,
  overrides: {
    concurrency?: number;
    onProgress?: (event: RunProgressEvent) => void;
  } = {},
): Promise<CaseExecution[]> => {
  return collectExecutions(config, {
    runId: RUN_ID,
    baseDirectory,
    ...overrides,
  });
};

const startCanonicalServer = async (): Promise<CanonicalServer> => {
  const child = spawn(process.execPath, [HTTP_AGENT_PATH], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let standardOutput = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP fixture readiness timed out')), 2_000);
    child.once('error', reject);
    child.stdout?.on('data', (chunk: Buffer) => {
      standardOutput += chunk.toString('utf8');
      const match = /LISTENING (\d+)/.exec(standardOutput);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, child, closed };
};

const stopCanonicalServer = async (server: CanonicalServer): Promise<void> => {
  const forceKill = setTimeout(() => server.child.kill('SIGKILL'), 1_000);
  server.child.kill('SIGTERM');
  await server.closed;
  clearTimeout(forceKill);
};

/** Starts a manually released HTTP agent so concurrency is asserted without wall-clock timing. */
const startCountingServer = async (): Promise<CountingServer> => {
  let inFlight = 0;
  let maximum = 0;
  let startedCount = 0;
  let releaseResponses: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    releaseResponses = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const server = createServer((_request, response) => {
    inFlight += 1;
    maximum = Math.max(maximum, inFlight);
    startedCount += 1;
    if (startedCount === 2) {
      signalStarted?.();
    }
    void released.then(() => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ protocol: AGENT_PROTOCOL, output: 'counted' }));
      inFlight -= 1;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Counting server did not bind a TCP port');
  }
  if (releaseResponses === undefined) {
    throw new Error('Counting server did not provide a release function');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    maximumInFlight: () => maximum,
    release: releaseResponses,
    started,
    server,
  };
};

const stopCountingServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.sequential('executeCases', () => {
  it('executes inline and dataset suites through the canonical traced CLI agent', async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, 'dataset.jsonl'),
      `${JSON.stringify({ id: 'dataset-case', input: { source: 'dataset' } })}\n`,
    );
    const progress: RunProgressEvent[] = [];
    const config = createConfig(canonicalCliTarget('with-trace'), [
      {
        name: 'inline',
        metrics: ['suite-metric'],
        cases: [
          { id: 'inline-default', input: { source: 'inline' }, expected: { answer: 'ok' } },
          { id: 'inline-override', input: {}, metrics: ['case-metric'] },
        ],
      },
      { name: 'dataset', metrics: ['suite-metric'], dataset: './dataset.jsonl' },
    ]);

    const executions = await execute(config, directory, {
      concurrency: 2,
      onProgress: (event) => progress.push(event),
    });

    expect(executions).toHaveLength(3);
    expect(executions.every(({ outcome }) => outcome === 'completed')).toBe(true);
    expect(
      executions.every(
        (execution) =>
          execution.outcome === 'completed' && execution.trace?.trace_id === 'fixture-trace',
      ),
    ).toBe(true);
    expect(executions.every(({ attempts }) => attempts.length === 1)).toBe(true);
    expect(executions.find(({ caseId }) => caseId === 'inline-override')?.expectedMetrics).toEqual([
      'case-metric',
    ]);
    expect(executions.find(({ caseId }) => caseId === 'dataset-case')?.expectedMetrics).toEqual([
      'suite-metric',
    ]);
    expect(executions.find(({ caseId }) => caseId === 'inline-default')?.caseDefinition).toEqual({
      id: 'inline-default',
      input: { source: 'inline' },
      expected: { answer: 'ok' },
    });
    expect(progress.map(({ completed }) => completed)).toEqual([1, 2, 3]);
    expect(progress.every(({ total }) => total === 3)).toBe(true);
  });

  it('surfaces malformed trace warnings without invalidating the response', async () => {
    const directory = await createTemporaryDirectory();
    const config = createConfig(canonicalCliTarget('malformed-trace'), [
      { name: 'warning', metrics: ['suite-metric'], cases: [{ id: 'warning-case', input: {} }] },
    ]);

    const [execution] = await execute(config, directory);

    expect(execution).toMatchObject({ outcome: 'completed', trace: undefined });
    expect(execution?.warnings).toMatchObject([{ code: 'invalid_trace' }]);
  });

  it.each([
    ['malformed-json', 'invalid_envelope', 1],
    ['nonzero-exit', 'nonzero_exit', 2],
  ] as const)(
    'classifies canonical %s and preserves attempts',
    async (behavior, code, attempts) => {
      const directory = await createTemporaryDirectory();
      const config = createConfig(canonicalCliTarget(behavior, attempts - 1), [
        { name: 'failure', metrics: ['suite-metric'], cases: [{ id: 'failure-case', input: {} }] },
      ]);

      const [execution] = await execute(config, directory);

      expect(execution).toMatchObject({
        outcome: 'invocation_error',
        invocationError: { code },
      });
      expect(execution?.attempts).toHaveLength(attempts);
    },
  );

  it('retries canonical HTTP 500 responses and records both attempts', async () => {
    const directory = await createTemporaryDirectory();
    const server = await startCanonicalServer();
    try {
      const config = createConfig(
        { type: 'http', url: `${server.baseUrl}/status-500`, retries: 1 },
        [{ name: 'http', metrics: ['suite-metric'], cases: [{ id: 'http-case', input: {} }] }],
      );

      const [execution] = await execute(config, directory);

      expect(execution).toMatchObject({
        outcome: 'invocation_error',
        diagnostics: { httpStatus: 500 },
      });
      expect(execution?.attempts).toHaveLength(2);
    } finally {
      await stopCanonicalServer(server);
    }
  });

  it('removes the fresh CLI working directory after completion', async () => {
    const directory = await createTemporaryDirectory();
    const program = `let body=''; process.stdin.on('data', chunk => body += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ protocol: '${AGENT_PROTOCOL}', output: process.cwd() })));`;
    const config = createConfig({ type: 'cli', command: [process.execPath, '-e', program] }, [
      { name: 'cleanup', metrics: ['suite-metric'], cases: [{ id: 'cleanup-case', input: {} }] },
    ]);

    const [execution] = await execute(config, directory);
    const response = execution?.outcome === 'completed' ? execution.response : undefined;
    const workingDirectory =
      response !== undefined && 'output' in response ? response.output : undefined;

    expect(typeof workingDirectory).toBe('string');
    if (typeof workingDirectory !== 'string') {
      throw new Error('Expected the fixture to return its working directory');
    }
    await expect(access(workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors the configured execution concurrency bound', async () => {
    const directory = await createTemporaryDirectory();
    const server = await startCountingServer();
    try {
      const config = createConfig({ type: 'http', url: server.baseUrl }, [
        {
          name: 'concurrency',
          metrics: ['suite-metric'],
          cases: [0, 1, 2, 3].map((id) => ({ id: `case-${id}`, input: {} })),
        },
      ]);
      const executionPromise = execute(config, directory, { concurrency: 2 });

      await server.started;
      expect(server.maximumInFlight()).toBe(2);
      server.release();
      const executions = await executionPromise;

      expect(executions).toHaveLength(4);
      expect(server.maximumInFlight()).toBe(2);
    } finally {
      await stopCountingServer(server.server);
    }
  });

  it('fails invalid datasets before invoking any inline case', async () => {
    const directory = await createTemporaryDirectory();
    const sentinel = join(directory, 'invoked');
    await writeFile(join(directory, 'invalid.jsonl'), '{"id":3}\n');
    const program = `require('node:fs').writeFileSync(process.argv[1], 'invoked')`;
    const config = createConfig(
      { type: 'cli', command: [process.execPath, '-e', program, sentinel] },
      [
        { name: 'inline', metrics: ['suite-metric'], cases: [{ id: 'inline-case', input: {} }] },
        { name: 'dataset', metrics: ['suite-metric'], dataset: 'invalid.jsonl' },
      ],
    );

    await expect(execute(config, directory)).rejects.toMatchObject({ code: 'config_invalid' });
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aggregates issues from every dataset suite before invocation', async () => {
    const directory = await createTemporaryDirectory();
    await Promise.all([
      writeFile(join(directory, 'first.jsonl'), '{"id":3}\n'),
      writeFile(join(directory, 'second.jsonl'), 'not-json\n'),
    ]);
    const config = createConfig(canonicalCliTarget('happy'), [
      { name: 'first', metrics: ['suite-metric'], dataset: 'first.jsonl' },
      { name: 'second', metrics: ['suite-metric'], dataset: 'second.jsonl' },
    ]);

    try {
      await execute(config, directory);
      throw new Error('Expected dataset validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      if (!(error instanceof ConfigInvalidError)) {
        throw error;
      }
      expect(error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'suites[0].dataset line 1' }),
          expect.objectContaining({ path: 'suites[1].dataset line 1' }),
        ]),
      );
    }
  });

  it('rejects unknown dataset case metric references before invocation', async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(
      join(directory, 'metrics.jsonl'),
      `${JSON.stringify({ id: 'dataset-case', input: {}, metrics: ['missing-metric'] })}\n`,
    );
    const config = createConfig(canonicalCliTarget('happy'), [
      { name: 'dataset', metrics: ['suite-metric'], dataset: 'metrics.jsonl' },
    ]);

    await expect(execute(config, directory)).rejects.toMatchObject({
      code: 'config_invalid',
      issues: [
        {
          path: 'suites[0].dataset line 1.metrics.0',
          message: 'metric is not defined: missing-metric',
        },
      ],
    });
  });
});
