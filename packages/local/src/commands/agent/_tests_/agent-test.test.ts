import { COMMAND_REQUEST_SCHEMA_ID, type AgentResource } from '@attest/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAgentTestCommand } from '../test.js';
import { addAgent, createAgentProject, snapshotFiles } from './support/agent-project.js';

const REDACTED = '[REDACTED]';
const originalSecret = process.env.ATTEST_SOURCE_SECRET;

const nativeAgent = (
  id: string,
  script: string,
  extra: Partial<AgentResource> = {},
): AgentResource => ({
  schema: 'attest.agent',
  id,
  name: id,
  transport: {
    kind: 'native_cli',
    lifecycle: 'per_case',
    argv: [process.execPath, '-e', script],
    // The script text must not name a credential, so the secret arrives as ATTEST_ECHO_VALUE.
    env: { ATTEST_ECHO_VALUE: { from_env: 'ATTEST_SOURCE_SECRET' } },
  },
  ...extra,
});

const probe = (root: string, agentId: string, signal?: AbortSignal) =>
  runAgentTestCommand({
    project: root,
    request: {
      schema: COMMAND_REQUEST_SCHEMA_ID,
      command: 'agent.test',
      agent_id: agentId,
      input: {},
    },
    signal,
    workingDirectory: root,
  });

const HANG = 'process.stdin.resume(); setInterval(() => undefined, 1000);';

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalSecret === undefined) delete process.env.ATTEST_SOURCE_SECRET;
  else process.env.ATTEST_SOURCE_SECRET = originalSecret;
});

describe('agent test command', () => {
  it('classifies an attempt timeout and a caller cancellation without writing project bytes', async () => {
    const root = await createAgentProject();
    process.env.ATTEST_SOURCE_SECRET = 'unused';
    await addAgent(root, nativeAgent('slow', HANG, { timeouts: { attempt_ms: 20 } }));
    await addAgent(root, nativeAgent('stuck', HANG));
    const before = await snapshotFiles(root);

    await expect(probe(root, 'slow')).rejects.toMatchObject({
      code: 'invocation_failed',
      details: { invocation_code: 'timeout' },
    });
    const controller = new AbortController();
    const pending = probe(root, 'stuck', controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(await snapshotFiles(root)).toEqual(before);
  }, 15_000);

  it('redacts env-bound secrets and declared argv positions from success and failure evidence', async () => {
    const root = await createAgentProject();
    process.env.ATTEST_SOURCE_SECRET = 'literal-super-secret';
    const argvSecret = 's3cr3t-value';
    const echo = `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ protocol: 'attest.agent-invocation', output: { value: process.env.ATTEST_ECHO_VALUE, argv: process.argv.slice(1) } })));`;
    const success = nativeAgent('success', echo, { redaction: { argv_positions: [3] } });
    if (success.transport.kind !== 'native_cli') throw new Error('Expected a native agent.');
    success.transport.argv.push(argvSecret);
    await addAgent(root, success);
    await addAgent(
      root,
      nativeAgent(
        'hostile',
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('invalid:' + process.env.ATTEST_ECHO_VALUE));",
      ),
    );

    const probed = await probe(root, 'success');
    expect(probed.result.response).toMatchObject({ output: { value: REDACTED, argv: [REDACTED] } });
    expect(JSON.stringify(probed)).not.toContain('literal-super-secret');
    expect(JSON.stringify(probed)).not.toContain(argvSecret);

    const failed: unknown = await probe(root, 'hostile').catch((error: unknown) => error);
    expect(failed).toMatchObject({
      code: 'invocation_failed',
      details: { invocation_code: 'invalid_envelope' },
    });
    expect(JSON.stringify(failed)).not.toContain('literal-super-secret');
  });

  it('sends resolved HTTP header references and redacts them, declared headers, and retries from evidence', async () => {
    const root = await createAgentProject();
    const secret = 'http"\\super-secret';
    process.env.ATTEST_SOURCE_SECRET = secret;
    const seen: (string | null)[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push(headers.get('authorization'));
      if (seen.length === 1) return Promise.resolve(new Response('temporary', { status: 503 }));
      const output = {
        authorization: headers.get('authorization'),
        opaque: headers.get('x-opaque'),
      };
      return Promise.resolve(
        new Response(JSON.stringify({ protocol: 'attest.agent-invocation', output }), {
          status: 200,
        }),
      );
    });
    await addAgent(root, {
      schema: 'attest.agent',
      id: 'http-agent',
      name: 'HTTP',
      transport: {
        kind: 'http',
        lifecycle: 'external',
        response_mode: 'attest_envelope',
        request: {
          url: 'https://agent.example/invoke',
          method: 'POST',
          headers: {
            Authorization: { from_env: 'ATTEST_SOURCE_SECRET' },
            'X-Opaque': 'opaque-header-value',
          },
        },
        extraction: { result_pointer: '' },
      },
      redaction: { headers: ['Authorization', 'x-opaque'] },
      retry: { retries: 1, backoff: { kind: 'none' } },
    });

    const probed = await probe(root, 'http-agent');
    expect(seen).toEqual([secret, secret]);
    expect(probed.result).toMatchObject({
      attempt_count: 2,
      attempts: [
        { attempt: 1, invocation_code: 'http_status', status: 'invocation_error' },
        { attempt: 2, status: 'ok' },
      ],
      response: { output: { authorization: REDACTED, opaque: REDACTED } },
    });
    const evidence = JSON.stringify(probed);
    expect(evidence).not.toContain('super-secret');
    expect(evidence).not.toContain('opaque-header-value');
  });

  it('reports a managed runtime that cannot start as an invocation failure', async () => {
    const root = await createAgentProject();
    await addAgent(root, {
      schema: 'attest.agent',
      id: 'missing-startup',
      name: 'Missing startup',
      transport: {
        kind: 'background_cli',
        lifecycle: 'per_run',
        start_argv: ['/definitely/missing/attest-agent'],
        readiness: { kind: 'stderr', pattern: 'READY' },
        invoke: { method: 'POST', url: 'http://127.0.0.1:41989/invoke' },
        extraction: { result_pointer: '/output' },
        stop_timeout_ms: 50,
      },
      timeouts: { connect_ms: 1_000, attempt_ms: 1_000 },
    });
    await expect(probe(root, 'missing-startup')).rejects.toMatchObject({
      code: 'invocation_failed',
      details: { invocation_code: 'spawn_failed' },
    });
  });
});
