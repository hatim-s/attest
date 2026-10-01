import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { COMMAND_REQUEST_SCHEMA_ID, type AgentResource } from '@attest/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalError } from '../../../errors/index.js';
import { loadProject } from '../../../project/index.js';
import { createAgentResource } from '../authoring/resource-builder.js';
import { createCurlImportRequest, type CurlImportFields } from '../curl-import-request.js';
import { runAgentImportCommand } from '../import.js';
import { createAgentProject, snapshotFiles } from './support/agent-project.js';

const noStdin = (): Promise<string> => Promise.reject(new Error('stdin must not be read'));

const importAgent = (
  root: string,
  request: Parameters<typeof runAgentImportCommand>[0]['request'],
): ReturnType<typeof runAgentImportCommand> =>
  runAgentImportCommand({
    interactive: false,
    project: root,
    readStdin: noStdin,
    request,
    workingDirectory: root,
  });

const importCurl = (
  root: string,
  fields: Omit<CurlImportFields, 'responsePointer'> & { responsePointer?: string },
): ReturnType<typeof runAgentImportCommand> =>
  importAgent(root, createCurlImportRequest({ responsePointer: '', ...fields }));

const importJson = (root: string, source: string, as: string) =>
  importAgent(root, {
    schema: COMMAND_REQUEST_SCHEMA_ID,
    command: 'agent.import',
    source,
    source_type: 'json',
    as,
  });

const websocketAgent = (
  transport: Partial<Extract<AgentResource['transport'], { kind: 'websocket' }>>,
): AgentResource => ({
  schema: 'attest.agent',
  id: 'source',
  name: 'WebSocket',
  transport: {
    kind: 'websocket',
    lifecycle: 'per_run',
    connection_mode: 'multiplexed',
    framing: 'text_json',
    url: 'wss://agent.example/socket',
    request_template: { request_id: '{{request_id}}', request: '{{request}}' },
    request_id_pointer: '/request_id',
    acknowledgement_pointer: '/type',
    acknowledgement_values: ['acknowledgement'],
    result_pointer: '/output',
    error_pointer: '/error',
    open_timeout_ms: 1_000,
    message_idle_timeout_ms: 4_000,
    attempt_timeout_ms: 10_000,
    ping_interval_ms: 2_000,
    close_timeout_ms: 500,
    retry_boundary: 'before_acknowledgement',
    replay_after_acknowledgement: false,
    ...transport,
  },
});

/** Awaits an expected local error so its message and details can be checked for leaked values. */
const rejection = async (pending: Promise<unknown>): Promise<LocalError> => {
  const error: unknown = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof LocalError)) throw new Error('Expected a LocalError rejection.');
  return error;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent import', () => {
  it('imports a cURL polling request with env-bound headers and a mapped body', async () => {
    const root = await createAgentProject();
    const secret = 'curl-polling-super-secret';
    await writeFile(
      join(root, 'polling.curl'),
      `curl 'https://agent.example/submit' -H 'Authorization: Bearer ${secret}' -H 'Content-Type: application/json' --data-raw '{"prompt":"replace-me"}'`,
    );
    const imported = await importCurl(root, {
      agentId: 'polling-curl',
      source: 'polling.curl',
      headerEnv: ['Authorization=ATTEST_CURL_POLLING_SECRET'],
      mapBody: ['/prompt=/question'],
      responsePointer: '/answer',
      pollJobIdPointer: '/job_id',
      pollStatusUrlPointer: '/status_url',
      pollStatusPointer: '/status',
      pollSuccess: ['"done"'],
      pollFailure: ['"failed"'],
      pollMinimumInterval: '1ms',
      pollMaximumInterval: '5ms',
    });

    expect(imported.result.import_preview).toMatchObject({
      request: { headers: { Authorization: '[from_env:ATTEST_CURL_POLLING_SECRET]' } },
    });
    expect(JSON.stringify(imported)).not.toContain(secret);
    const loaded = await loadProject({ project: root });
    expect(loaded.agents.find(({ id }) => id === 'polling-curl')?.transport).toMatchObject({
      kind: 'polling',
      submit: {
        headers: { Authorization: { from_env: 'ATTEST_CURL_POLLING_SECRET' } },
        body: { prompt: '{{input/question}}' },
      },
    });
    const written = Object.entries(await snapshotFiles(root)).filter(
      ([path]) => path !== 'polling.curl',
    );
    expect(JSON.stringify(written)).not.toContain(secret);
  });

  it('reads a project-contained cURL body file and rejects outside, symlinked, and oversized ones', async () => {
    const root = await createAgentProject();
    await writeFile(join(root, 'request.json'), '{"prompt":"hello"}');
    await writeFile(join(root, 'file.curl'), 'curl https://agent.example --data @request.json');
    await importCurl(root, { agentId: 'file-body', source: 'file.curl' });
    expect(
      (await loadProject({ project: root })).agents.find(({ id }) => id === 'file-body'),
    ).toMatchObject({
      transport: { request: { body: { prompt: 'hello' }, body_encoding: 'json' } },
    });

    await writeFile(join(root, '..', 'outside-body.json'), '{}');
    await writeFile(
      join(root, 'outside.curl'),
      'curl https://agent.example --data @../outside-body.json',
    );
    await symlink('request.json', join(root, 'linked.json'));
    await writeFile(join(root, 'linked.curl'), 'curl https://agent.example --data @linked.json');
    await writeFile(join(root, 'large.txt'), 'x'.repeat(128));
    await writeFile(join(root, 'large.curl'), 'curl https://agent.example --data @large.txt');
    const before = await snapshotFiles(root);
    for (const [source, diagnostic, requestCapBytes] of [
      ['outside.curl', 'file_body_outside_project', undefined],
      ['linked.curl', 'unsafe_file_body', undefined],
      ['large.curl', 'unsafe_file_body', '64'],
    ] as const) {
      await expect(
        importCurl(root, { agentId: 'rejected', source, requestCapBytes }),
      ).rejects.toMatchObject({ code: 'cli_usage', details: { diagnostic } });
    }
    expect(await snapshotFiles(root)).toEqual(before);
  });

  it('imports bounded remote JSON without following redirects or echoing the URL', async () => {
    const root = await createAgentProject();
    const remote: AgentResource = {
      schema: 'attest.agent',
      id: 'remote-source',
      name: 'Remote',
      transport: { kind: 'native_cli', lifecycle: 'per_case', argv: ['node', 'agent.mjs'] },
    };
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.endsWith('/redirect')
          ? new Response(null, { status: 302 })
          : new Response(JSON.stringify(remote), { status: 200 }),
      ),
    );
    await importJson(root, 'https://catalog.example/agent.json', 'remote');
    expect((await loadProject({ project: root })).agents.map(({ id }) => id)).toContain('remote');

    const redirected = await rejection(
      importJson(root, 'https://catalog.example/redirect', 'redirected'),
    );
    expect(redirected).toMatchObject({ code: 'cli_usage', details: { http_status: 302 } });
    expect(JSON.stringify([redirected.message, redirected.details])).not.toContain(
      'catalog.example',
    );
  });

  it('rejects literal credentials and unsupported policies in imported JSON before writing', async () => {
    const root = await createAgentProject();
    const http = {
      kind: 'http',
      lifecycle: 'external',
      response_mode: 'attest_envelope',
      request: { url: 'https://agent.example/invoke', method: 'POST' },
      extraction: { result_pointer: '' },
    } as const;
    const cases: readonly {
      expected: object;
      hint?: string;
      resource: AgentResource;
      secret?: string;
    }[] = [
      {
        resource: {
          ...websocketAgent({}),
          transport: {
            ...http,
            response_mode: 'mapped',
            request: {
              ...http.request,
              url: 'https://agent.example/invoke?credential=literal-value',
            },
          },
        },
        secret: 'literal-value',
        expected: {},
      },
      {
        resource: websocketAgent({ headers: { 'X-API-Key': 'literal-header-secret' } }),
        secret: 'literal-header-secret',
        expected: { message: 'Sensitive WebSocket headers must use references.' },
      },
      {
        resource: websocketAgent({
          request_template: {
            request_id: '{{request_id}}',
            nested: [{ token: 'template-secret' }],
          },
        }),
        secret: 'template-secret',
        expected: {
          message: 'WebSocket request templates cannot contain credential-like fields.',
          path: '/agent/transport/request_template/nested/0/token',
        },
        hint: '--header-env',
      },
      {
        resource: { ...websocketAgent({}), transport: http, timeouts: { connect_ms: 10 } },
        expected: { path: '/agent/timeouts/connect_ms' },
      },
    ];
    const before = await snapshotFiles(root);
    for (const { expected, hint, resource, secret } of cases) {
      await writeFile(join(root, 'unsafe.json'), JSON.stringify(resource));
      const error = await rejection(importJson(root, 'unsafe.json', 'unsafe'));
      expect(error).toMatchObject({ code: 'project_invalid', ...expected });
      if (hint !== undefined) expect(error.hint).toContain(hint);
      if (secret !== undefined) {
        expect(JSON.stringify([error.message, error.details])).not.toContain(secret);
      }
    }
    const after = await snapshotFiles(root);
    delete after['unsafe.json'];
    expect(after).toEqual(before);
  });
});

describe('agent add authoring', () => {
  it('rejects credential-like WebSocket request-template fields from flags', () => {
    const error: unknown = (() => {
      try {
        return createAgentResource({
          agentId: 'unsafe-flags',
          webSocketUrl: 'wss://agent.example/socket',
          requestTemplate: JSON.stringify({
            request_id: '{{request_id}}',
            nested: { api_key: 'flag-template-secret' },
          }),
        });
      } catch (thrown: unknown) {
        return thrown;
      }
    })();
    if (!(error instanceof LocalError)) throw new Error('Expected a LocalError.');
    expect(error).toMatchObject({
      code: 'project_invalid',
      message: 'WebSocket request templates cannot contain credential-like fields.',
      path: '/agent/transport/request_template/nested/api_key',
    });
    expect(error.hint).toContain('--header-env');
  });
});
