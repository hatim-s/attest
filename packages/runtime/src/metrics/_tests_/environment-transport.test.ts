import * as Effect from 'effect/Effect';
import { METRIC_PROTOCOL, type MetricRequest } from '@attest/contracts';
import type { CaseEnvironment } from '@attest/executor';
import { describe, expect, it } from 'vitest';

import { createEnvironmentMetricTransport } from '../environment-transport.js';
import { TestFailure, toTestFailure } from '../../_tests_/support/test-failure.js';

type ExecResult = Effect.Success<ReturnType<CaseEnvironment['exec']>>;

/**
 * Records every write and script, answers `pwd` with a fixed workspace and returns the canned
 * result for the metric command.
 */
const fakeEnvironment = (command: (script: string) => Promise<ExecResult>) => {
  const writes = new Map<string, string>();
  const scripts: { script: string; env?: Record<string, string> }[] = [];

  const environment: CaseEnvironment = {
    exec: (script, options) => {
      scripts.push({ script, env: options?.env });

      return script.endsWith('pwd')
        ? Effect.succeed({ stdout: '/vercel/sandbox/workspace\n', stderr: '', exitCode: 0 })
        : Effect.tryPromise({
            try: () => command(script),
            catch: toTestFailure,
          });
    },
    readFile: () => Effect.fail(new TestFailure({ message: 'not used' })),
    writeFile: (path, contents) => {
      writes.set(path, contents);

      return Effect.void;
    },
    beginFinalization: () => Effect.void,
    dispose: () => Effect.void,
  };

  return { environment, writes, scripts };
};

const request: MetricRequest = {
  protocol: METRIC_PROTOCOL,
  case: { id: 'c1', input: 'hi' },
  output: 'done',
  trace: null,
  artifacts: [
    {
      kind: 'inline',
      path: 'src/answer.ts',
      media_type: 'text/typescript',
      encoding: 'utf8',
      content: 'export {};\n',
    },
    {
      kind: 'inline',
      path: 'logo.png',
      media_type: 'image/png',
      encoding: 'base64',
      content: 'iVBORw0K',
    },
  ],
  artifact_dir: null,
};

const definition = { name: 'score', type: 'exec' as const, command: ['bun', "it's.ts"] };

const options = { outputCapBytes: 64, timeoutMs: 5_000, env: { API_KEY: 'k' } };

describe('createEnvironmentMetricTransport', () => {
  it('writes the request and artifacts into the workspace and runs argv with stdin from the request', async () => {
    const fake = fakeEnvironment(() =>
      Promise.resolve({ stdout: '{"score":1,"pass":true}', stderr: '', exitCode: 0 }),
    );

    const outcome = await Effect.runPromise(
      createEnvironmentMetricTransport(fake.environment)(definition, request, options),
    );

    expect(outcome).toEqual({ ok: true, text: '{"score":1,"pass":true}' });
    expect(fake.writes.get('attest/artifacts/src/answer.ts')).toBe('export {};\n');
    expect(fake.writes.get('attest/staging/1')).toBe('iVBORw0K');
    expect(JSON.parse(fake.writes.get('attest/metric-request.json') ?? '')).toMatchObject({
      output: 'done',
      artifact_dir: '/vercel/sandbox/workspace/attest/artifacts',
    });

    const [prepare, run] = fake.scripts;

    expect(prepare?.script).toContain("'attest/artifacts/src'");
    expect(run?.script.split('\n')).toEqual([
      'set -e',
      "base64 -d < 'attest/staging/1' > 'attest/artifacts/logo.png'",
      `'bun' 'it'\\''s.ts' < 'attest/metric-request.json'`,
    ]);
    expect(run?.env).toEqual({ API_KEY: 'k' });
  });

  it('maps a non-zero exit, oversized stdout and an abort onto metric error codes', async () => {
    const failing = fakeEnvironment(() =>
      Promise.resolve({ stdout: '', stderr: 'boom', exitCode: 3 }),
    );

    expect(
      await Effect.runPromise(
        createEnvironmentMetricTransport(failing.environment)(definition, request, options),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: 'exec_nonzero_exit',
        message: 'Metric command exited with code 3.',
        details: { stderr: 'boom' },
      },
    });

    const noisy = fakeEnvironment(() =>
      Promise.resolve({ stdout: 'x'.repeat(65), stderr: '', exitCode: 0 }),
    );

    expect(
      await Effect.runPromise(
        createEnvironmentMetricTransport(noisy.environment)(definition, request, options),
      ),
    ).toMatchObject({ ok: false, error: { code: 'exec_malformed_output' } });

    const controller = new AbortController();

    const hanging = fakeEnvironment(
      () =>
        new Promise((_resolve, reject) => {
          controller.abort();
          reject(new Error('aborted by sandbox'));
        }),
    );

    expect(
      await Effect.runPromise(
        createEnvironmentMetricTransport(hanging.environment)(definition, request, {
          ...options,
          signal: controller.signal,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'metric_cancelled' } });
  });
});
