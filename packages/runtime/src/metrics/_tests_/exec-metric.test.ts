import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { CompletedMetricContext } from '../metric-evaluation.js';
import { executeExecutableMetric } from '../exec-metric.js';

/** Builds a completed execution context so every transport test shares exact request evidence. */
const metricContext = (): CompletedMetricContext => ({
  caseDefinition: {
    id: 'greeting',
    input: { locale: 'en' },
    expected: { greeting: 'hello' },
    params: { formal: false },
  },
  execution: { outcome: 'completed', output: 'hello', trace: null },
});

/** Resolves a fixture command through the active Node executable to avoid shell-specific behavior. */
const buildFixtureCommand = (fixtureName: string, ...commandArguments: string[]) => [
  process.execPath,
  fileURLToPath(new URL(`./fixtures/exec-metric/${fixtureName}`, import.meta.url)),
  ...commandArguments,
];

/** Uses the canonical hostile-agent behaviors wherever their transport shape already exercises the metric edge. */
const conformanceAgentCommand = (behavior: string) => [
  process.execPath,
  fileURLToPath(
    new URL(
      '../../../../../conformance/src/_tests_/fixtures/fake-agents/cli-agent.cjs',
      import.meta.url,
    ),
  ),
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

/** Streams up to 100 chunks and records whether the client hung up before the stream finished. */
const startChunkedServer = async (status: number, chunk: string) => {
  const progress = { chunksWritten: 0, responseClosed: false };
  const { server, url } = await startMetricServer((_request, response) => {
    response.writeHead(status);
    const interval = setInterval(() => {
      progress.chunksWritten += 1;
      response.write(chunk);
      if (progress.chunksWritten === 100) {
        clearInterval(interval);
        response.end();
      }
    }, 5);
    response.on('close', () => {
      progress.responseClosed = true;
      clearInterval(interval);
    });
  });
  return { server, url, progress };
};

/** Closes a fixture server so refusal tests exercise a real, previously valid loopback endpoint. */
const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );

/** Checks a PID without mutating it; ESRCH means the direct child has been reaped. */
const isProcessAlive = (processIdentifier: number): boolean => {
  try {
    process.kill(processIdentifier, 0);
    return true;
  } catch {
    return false;
  }
};

describe('executeExecutableMetric command metrics', () => {
  it('normalizes a valid fixture result', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'fixture', type: 'exec', command: buildFixtureCommand('result.mjs') },
      metricContext(),
    );

    expect(evaluation).toMatchObject({
      metricName: 'fixture',
      kind: 'exec',
      status: 'evaluated',
      score: 1,
      pass: true,
    });
  });

  it('records non-zero exits with bounded stderr diagnostics', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'fixture', type: 'exec', command: conformanceAgentCommand('nonzero-exit') },
      metricContext(),
    );

    expect(evaluation).toMatchObject({
      status: 'error',
      error: { kind: 'exec_nonzero_exit' },
    });
  });

  it('records canonical malformed JSON output as malformed', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'fixture', type: 'exec', command: conformanceAgentCommand('malformed-json') },
      metricContext(),
    );

    expect(evaluation.status).toBe('error');
    if (evaluation.status === 'error') {
      expect(evaluation.error.kind).toBe('exec_malformed_output');
      expect(evaluation.error.message).toContain('Metric output was not valid JSON');
    }
  });

  it('uses the shared output cap option for command stdout', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'capped', type: 'exec', command: conformanceAgentCommand('huge-output') },
      metricContext(),
      { outputCapBytes: 512 },
    );

    expect(evaluation.status).toBe('error');
    if (evaluation.status === 'error') {
      expect(evaluation.error.kind).toBe('exec_malformed_output');
      expect(evaluation.error.message).toContain('512-byte');
    }
  });

  it('records contract issue paths for a JSON result with missing fields', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'fixture', type: 'exec', command: buildFixtureCommand('invalid-result.mjs') },
      metricContext(),
    );

    expect(evaluation.status).toBe('error');
    if (evaluation.status === 'error') {
      expect(evaluation.error.kind).toBe('exec_malformed_output');
      expect(evaluation.details).toMatchObject({ issues: [{ path: 'pass' }] });
    }
  });

  it('records a missing command without rejecting the evaluation', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'missing', type: 'exec', command: ['attest-missing-metric-command'] },
      metricContext(),
    );

    expect(evaluation).toMatchObject({ status: 'error', error: { kind: 'exec_spawn_failed' } });
  });

  it('kills the process tree and reaps the direct child before resolving a timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-metric-'));
    const markerPath = join(directory, 'survival-marker');
    const processIdentifierPath = join(directory, 'process-id');
    try {
      const evaluation = await executeExecutableMetric(
        {
          name: 'term-resistant',
          type: 'exec',
          command: buildFixtureCommand('term-resistant.mjs', processIdentifierPath, markerPath),
        },
        metricContext(),
        { timeoutMs: 1_000 },
      );
      const processIdentifier = Number(await readFile(processIdentifierPath, 'utf8'));

      expect(isProcessAlive(processIdentifier)).toBe(false);
      expect(evaluation).toMatchObject({ status: 'error', error: { kind: 'exec_timeout' } });
      // Wait beyond the descendant's marker delay so a surviving grandchild cannot pass silently.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await expect(access(markerPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('reports caller cancellation distinctly without a synthetic score', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attest-metric-'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    try {
      const evaluation = await executeExecutableMetric(
        {
          name: 'cancelled',
          type: 'exec',
          command: buildFixtureCommand('sleep-with-child.mjs', join(directory, 'unused')),
        },
        metricContext(),
        { signal: controller.signal },
      );

      expect(evaluation).toMatchObject({
        status: 'error',
        error: { kind: 'metric_cancelled', message: 'Metric execution was cancelled.' },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      expect(JSON.parse(requestBody)).toEqual({
        protocol: 'attest.metric-evaluation',
        case: {
          id: 'greeting',
          input: { locale: 'en' },
          expected: { greeting: 'hello' },
          params: { formal: false },
        },
        output: 'hello',
        trace: null,
      });
      expect(evaluation).toMatchObject({ status: 'evaluated', score: 0.5, pass: true });
    } finally {
      await closeServer(server);
    }
  });

  it('cancels an oversized streaming response at the shared output cap', async () => {
    const { server, url, progress } = await startChunkedServer(200, 'x'.repeat(256));

    try {
      const evaluation = await executeExecutableMetric(
        { name: 'http-capped', type: 'exec', url },
        metricContext(),
        { outputCapBytes: 512 },
      );
      await vi.waitFor(() => expect(progress.responseClosed).toBe(true));

      expect(progress.chunksWritten).toBeLessThan(100);
      expect(evaluation).toMatchObject({
        status: 'error',
        error: { kind: 'exec_malformed_output' },
      });
      expect(evaluation.status === 'error' && evaluation.error.message).toContain('512-byte');
    } finally {
      await closeServer(server);
    }
  });

  it('cancels a non-200 response without reading its complete body', async () => {
    const { server, url, progress } = await startChunkedServer(503, 'unneeded diagnostics');

    try {
      const evaluation = await executeExecutableMetric(
        { name: 'http-status', type: 'exec', url },
        metricContext(),
      );
      await vi.waitFor(() => expect(progress.responseClosed).toBe(true));

      expect(progress.chunksWritten).toBeLessThan(100);
      expect(evaluation).toMatchObject({ status: 'error', error: { kind: 'http_bad_status' } });
    } finally {
      await closeServer(server);
    }
  });

  it('maps a malformed 200 body to a protocol error', async () => {
    const { server, url } = await startMetricServer((_request, response) => {
      response.end('not JSON');
    });

    try {
      const evaluation = await executeExecutableMetric(
        { name: 'http', type: 'exec', url },
        metricContext(),
      );
      expect(evaluation).toMatchObject({
        status: 'error',
        error: { kind: 'exec_malformed_output' },
      });
    } finally {
      await closeServer(server);
    }
  });

  it('rejects non-HTTP URL schemes before invoking fetch', async () => {
    const evaluation = await executeExecutableMetric(
      { name: 'unsafe-scheme', type: 'exec', url: 'ftp://metrics.example/result' },
      metricContext(),
    );

    expect(evaluation.status).toBe('error');
    if (evaluation.status === 'error') {
      expect(evaluation.error.kind).toBe('http_request_failed');
      expect(evaluation.error.message).toContain('must use http: or https:');
    }
  });

  it('maps a refusal after a loopback server is closed', async () => {
    const { server, url } = await startMetricServer((_request, response) => response.end());
    await closeServer(server);

    const evaluation = await executeExecutableMetric(
      { name: 'refused', type: 'exec', url },
      metricContext(),
    );
    expect(evaluation).toMatchObject({ status: 'error', error: { kind: 'http_request_failed' } });
  });
});
