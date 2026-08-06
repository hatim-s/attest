import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { MetricContext } from './metric-evaluation.js';
import { executeExecutableMetric } from './exec-metric.js';
import { buildMetricRequest } from './internal/metric-request.js';

/** Resolves source fixtures from the repository root so conformance assets remain shared across tracks. */
const fromRepositoryRoot = (relativePath: string): string =>
  fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url));

/** Builds a completed execution context so every transport test shares exact request evidence. */
const metricContext = (): MetricContext => ({
  caseDefinition: {
    id: 'greeting',
    input: { locale: 'en' },
    expected: { greeting: 'hello' },
    params: { formal: false },
  },
  execution: { outcome: 'completed', output: 'hello', trace: null },
});

/** Resolves a fixture command through the active Node executable to avoid shell-specific behavior. */
const fixtureCommand = (fixtureName: string, ...arguments_: string[]) => [
  process.execPath,
  fromRepositoryRoot(`packages/core/src/metrics/exec-metric.fixtures/${fixtureName}`),
  ...arguments_,
];

/** Uses the canonical hostile-agent behaviors wherever their transport shape already exercises the metric edge. */
const conformanceAgentCommand = (behavior: string) => [
  process.execPath,
  fromRepositoryRoot('conformance/fake-agents/cli-agent.cjs'),
  `--behavior=${behavior}`,
];

/** Starts an in-process loopback endpoint and returns its base URL plus deterministic teardown. */
const startMetricServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; url: string }> =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected a TCP listener address.');
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });

/** Closes a fixture server so refusal tests exercise a real, previously valid loopback endpoint. */
const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );

describe('buildMetricRequest', () => {
  it('creates the §2 envelope and represents an absent trace as null', () => {
    expect(buildMetricRequest(metricContext())).toEqual({
      protocol: 'attest.metric/v1alpha1',
      case: {
        id: 'greeting',
        input: { locale: 'en' },
        expected: { greeting: 'hello' },
        params: { formal: false },
      },
      output: 'hello',
      trace: null,
    });
  });
});

describe('executeExecutableMetric command metrics', () => {
  it('normalizes a valid fixture result', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'fixture', type: 'exec', command: fixtureCommand('result.mjs') },
      metricContext(),
    );

    expect(evaluation).toMatchObject({
      metricName: 'fixture',
      kind: 'exec',
      status: 'evaluated',
      result: { score: 1, pass: true },
    });
  });

  it('records non-zero exits with bounded stderr diagnostics', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'fixture', type: 'exec', command: conformanceAgentCommand('nonzero-exit') },
      metricContext(),
    );

    expect(evaluation).toMatchObject({
      status: 'error',
      error: { code: 'exec_nonzero_exit' },
    });
  });

  it.each([
    { behavior: 'malformed-json', message: 'Metric output was not valid JSON' },
    { behavior: 'huge-output', message: 'Metric stdout exceeded' },
  ])('records canonical $behavior output as malformed', async ({ behavior, message }) => {
    const evaluation = await executeExecutableMetric(
      { name: 'fixture', type: 'exec', command: conformanceAgentCommand(behavior) },
      metricContext(),
    );

    expect(evaluation.status).toBe('error');
    if (evaluation.status === 'error') {
      expect(evaluation.error.code).toBe('exec_malformed_output');
      expect(evaluation.error.message).toContain(message);
    }
  });

  it('records contract issue paths for a JSON result with missing fields', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'fixture', type: 'exec', command: fixtureCommand('invalid-result.mjs') },
      metricContext(),
    );

    expect(evaluation.status).toBe('error');
    if (evaluation.status === 'error') {
      expect(evaluation.error.code).toBe('exec_malformed_output');
      expect(evaluation.error.details).toMatchObject({ issues: [{ path: 'pass' }] });
    }
  });

  it('records a missing command without rejecting the evaluation', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'missing', type: 'exec', command: ['attest-missing-metric-command'] },
      metricContext(),
    );

    expect(evaluation).toMatchObject({ status: 'error', error: { code: 'exec_spawn_failed' } });
  });

  it('terminates the entire process group after a timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-metric-'));
    const markerPath = join(directory, 'orphan-marker');
    const evaluation = await executeExecutableMetric(
      {
        name: 'sleeping',
        type: 'exec',
        command: fixtureCommand('sleep-with-child.mjs', markerPath),
      },
      metricContext(),
      { timeoutMs: 100 },
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(access(markerPath)).rejects.toThrow();
    expect(evaluation).toMatchObject({ status: 'error', error: { code: 'exec_timeout' } });
  });

  it('skips metrics after an incomplete case without spawning the command', async () => {
    const context: MetricContext = {
      ...metricContext(),
      execution: { outcome: 'timeout', trace: null },
    };
    const evaluation = await executeExecutableMetric(
      { name: 'skipped', type: 'exec', command: ['attest-missing-metric-command'] },
      context,
    );

    expect(evaluation).toMatchObject({ status: 'error', error: { code: 'skipped_no_output' } });
  });

  it('reports caller cancellation as a timeout without a synthetic score', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const evaluation = await executeExecutableMetric(
      {
        name: 'cancelled',
        type: 'exec',
        command: fixtureCommand('sleep-with-child.mjs', '/tmp/unused'),
      },
      metricContext(),
      { signal: controller.signal },
    );

    expect(evaluation).toMatchObject({
      status: 'error',
      error: { code: 'exec_timeout', message: 'Metric execution was cancelled.' },
    });
  });
});

describe('executeExecutableMetric HTTP metrics', () => {
  it('posts the request envelope and normalizes a 200 result', async () => {
    let requestBody = '';
    const { server, url } = await startMetricServer((request, response) => {
      request.on('data', (chunk: Buffer) => {
        requestBody += chunk.toString();
      });
      request.on('end', () => response.end(JSON.stringify({ score: 0.5, pass: true })));
    });

    try {
      const evaluation = await executeExecutableMetric(
        { name: 'http', type: 'exec', url },
        metricContext(),
      );
      expect(JSON.parse(requestBody)).toEqual(buildMetricRequest(metricContext()));
      expect(evaluation).toMatchObject({ status: 'evaluated', result: { score: 0.5, pass: true } });
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    [503, JSON.stringify({ score: 1, pass: true }), 'http_bad_status'],
    [200, 'not JSON', 'exec_malformed_output'],
  ])('maps HTTP status and body failures', async (statusCode, body, errorCode) => {
    const { server, url } = await startMetricServer((_request, response) => {
      response.statusCode = statusCode;
      response.end(body);
    });

    try {
      const evaluation = await executeExecutableMetric(
        { name: 'http', type: 'exec', url },
        metricContext(),
      );
      expect(evaluation).toMatchObject({ status: 'error', error: { code: errorCode } });
    } finally {
      await closeServer(server);
    }
  });

  it('maps a refusal after a loopback server is closed', async () => {
    const { server, url } = await startMetricServer((_request, response) => response.end());
    await closeServer(server);

    const evaluation = await executeExecutableMetric(
      { name: 'refused', type: 'exec', url },
      metricContext(),
    );
    expect(evaluation).toMatchObject({ status: 'error', error: { code: 'http_request_failed' } });
  });
});
