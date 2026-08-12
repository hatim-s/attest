import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { type AgentResource } from '@attest/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { loadProject } from '../../project/load-project.js';
import { runCli, type CliIo } from '../../run-cli.js';

const PTY_FIXTURE = fileURLToPath(new URL('./fixtures/pty-agent-command.py', import.meta.url));
const CLI_PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI_BUILT = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const webSocketFixtures: Array<{ close: () => Promise<void> }> = [];
const originalSecret = process.env.ATTEST_WS_TOKEN;

type WebSocketProbeDocument = {
  command: string;
  result: {
    response: { output: { echoed_request_id: string } };
    transport: string;
  };
};

const nonInteractive = {
  ci: false,
  inputIsTTY: false,
  outputIsTTY: false,
  prompt: (): Promise<string> => Promise.reject(new Error('prompt must not be called')),
  readStdin: (): Promise<string> => Promise.resolve(''),
};

const collectIo = (): { errors: string[]; io: CliIo; output: string[] } => {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    errors,
    output,
    io: {
      error: (message) => errors.push(message),
      output: (message) => output.push(message),
    },
  };
};

/** Creates an isolated v2 project through the same public CLI used by the assertions. */
const createProject = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), 'attest-websocket-cli-'));
  temporaryDirectories.push(parent);
  const collected = collectIo();
  expect(
    await runCli(['project', 'init', 'demo', '--name', 'Demo', '--output', 'json'], {
      interaction: nonInteractive,
      io: collected.io,
      workingDirectory: parent,
    }),
  ).toBe(0);
  return join(parent, 'demo');
};

/** Runs one non-interactive command and captures its stable stdout/stderr surfaces. */
const run = async (
  root: string,
  argv: string[],
  readStdin: () => Promise<string> = () => Promise.resolve(''),
) => {
  const collected = collectIo();
  const exitCode = await runCli(argv, {
    interaction: { ...nonInteractive, readStdin },
    io: collected.io,
    workingDirectory: root,
  });
  return { ...collected, exitCode };
};

/** Starts the core hostile fixture without making test support part of the public package API. */
const startLocalWebSocketFixture = async (): Promise<{
  close: () => Promise<void>;
  events: () => readonly {
    headers?: Readonly<Record<string, string>>;
    type: string;
  }[];
  url: string;
}> => {
  const fixtureModuleUrl = new URL(
    '../../../../core/src/runner/_tests/fixtures/websocket-fake-server.ts',
    import.meta.url,
  ).href;
  const fixtureModule = (await import(fixtureModuleUrl)) as {
    startWebSocketFixtureServer: (scenario: 'serial_correlation') => Promise<{
      close: () => Promise<void>;
      events: () => readonly {
        headers?: Readonly<Record<string, string>>;
        type: string;
      }[];
      url: string;
    }>;
  };
  const fixture = await fixtureModule.startWebSocketFixtureServer('serial_correlation');
  webSocketFixtures.push(fixture);
  return fixture;
};

/** Captures every authored project byte for cancellation and validation no-write assertions. */
const snapshotTree = async (root: string, prefix = ''): Promise<Record<string, string>> => {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const snapshot: Record<string, string> = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, await snapshotTree(root, relativePath));
    else snapshot[relativePath] = await readFile(join(root, relativePath), 'utf8');
  }
  return snapshot;
};

/** Returns the canonical transport expected from flags, JSON, import, and wizard routes. */
const canonicalTransport = (): Extract<AgentResource['transport'], { kind: 'websocket' }> => ({
  kind: 'websocket',
  lifecycle: 'per_run',
  connection_mode: 'multiplexed',
  framing: 'text_json',
  url: 'wss://agent.example/socket',
  headers: { Authorization: { from_env: 'ATTEST_WS_TOKEN' } },
  subprotocol: 'attest.v1',
  request_template: { request_id: '{{request_id}}', request: '{{request}}' },
  request_id_pointer: '/request_id',
  acknowledgement_pointer: '/type',
  acknowledgement_values: ['acknowledgement'],
  result_pointer: '/output',
  error_pointer: '/error',
  trace_pointer: '/trace',
  open_timeout_ms: 1_000,
  message_idle_timeout_ms: 4_000,
  attempt_timeout_ms: 10_000,
  ping_interval_ms: 2_000,
  close_timeout_ms: 500,
  retry_boundary: 'before_acknowledgement',
  replay_after_acknowledgement: false,
});

const canonicalAgent = (id: string): AgentResource => ({
  schema: 'attest.agent/v2',
  id,
  name: id,
  transport: canonicalTransport(),
  redaction: { headers: ['Authorization'] },
  capabilities: { trace: true },
});

afterEach(async () => {
  if (originalSecret === undefined) delete process.env.ATTEST_WS_TOKEN;
  else process.env.ATTEST_WS_TOKEN = originalSecret;
  await Promise.all(webSocketFixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('CLI2.12 WebSocket agent UX', () => {
  it('normalizes flags, command JSON, imported JSON, and the wizard to one resource shape', async () => {
    const root = await createProject();
    process.env.ATTEST_WS_TOKEN = 'websocket-super-secret';
    const flagResult = await run(root, [
      'agent',
      'add',
      'flags',
      '--websocket-url',
      'wss://agent.example/socket',
      '--header-env',
      'Authorization=ATTEST_WS_TOKEN',
      '--subprotocol',
      'attest.v1',
      '--websocket-lifecycle',
      'per_run',
      '--connection-mode',
      'multiplexed',
      '--request-template',
      '{"request_id":"{{request_id}}","request":"{{request}}"}',
      '--request-id-pointer',
      '/request_id',
      '--acknowledgement-pointer',
      '/type',
      '--acknowledgement-value',
      '"acknowledgement"',
      '--response-pointer',
      '/output',
      '--error-pointer',
      '/error',
      '--trace-pointer',
      '/trace',
      '--open-timeout',
      '1s',
      '--idle-timeout',
      '4s',
      '--attempt-timeout',
      '10s',
      '--ping-interval',
      '2s',
      '--close-timeout',
      '500ms',
      '--trace',
      '--output',
      'json',
    ]);
    expect(flagResult.exitCode).toBe(0);
    expect(flagResult.output.join('')).not.toContain('websocket-super-secret');
    expect(JSON.parse(flagResult.output[0] ?? '{}')).toMatchObject({
      ok: true,
      result: {
        import_preview: {
          transport: {
            headers: { Authorization: { from_env: 'ATTEST_WS_TOKEN' } },
            url: 'wss://agent.example/socket',
          },
        },
      },
    });

    const commandRequest = {
      schema: 'attest.command-request/v2',
      command: 'agent.add',
      agent: canonicalAgent('json'),
    };
    const jsonResult = await run(
      root,
      ['agent', 'add', '--from-json', '-', '--output', 'json'],
      () => Promise.resolve(JSON.stringify(commandRequest)),
    );
    expect(jsonResult.exitCode).toBe(0);

    await writeFile(join(root, 'websocket-agent.json'), JSON.stringify(canonicalAgent('source')));
    const importResult = await run(root, [
      'agent',
      'import',
      'websocket-agent.json',
      '--type',
      'json',
      '--as',
      'imported',
      '--output',
      'json',
    ]);
    expect(importResult.exitCode).toBe(0);
    expect(importResult.output.join('')).not.toContain('websocket-super-secret');
    expect(JSON.parse(importResult.output[0] ?? '{}')).toMatchObject({
      result: { import_preview: { transport: { kind: 'websocket' } } },
    });

    const wizardIo = collectIo();
    const answers = new Map<string, string>([
      ['Agent id: ', 'wizard'],
      ['Transport [cli/http/background/jsonl/stream/websocket]: ', 'websocket'],
      ['WebSocket URL: ', 'wss://agent.example/socket'],
      ['WebSocket lifecycle [per_run]: ', 'per_run'],
      ['Connection mode [multiplexed]: ', 'multiplexed'],
      [
        'Header environment references HEADER=ENV, comma-separated [none]: ',
        'Authorization=ATTEST_WS_TOKEN',
      ],
      ['WebSocket subprotocol [none]: ', 'attest.v1'],
      ['Request template JSON [{"request_id":"{{request_id}}","request":"{{request}}"}]: ', ''],
      ['Request id JSON Pointer [/request_id]: ', ''],
      ['Acknowledgement JSON Pointer [/type]: ', ''],
      ['Acknowledgement JSON value ["acknowledgement"]: ', ''],
      ['Result JSON Pointer [/output]: ', ''],
      ['Error JSON Pointer [/error]: ', ''],
      ['Trace JSON Pointer [none]: ', '/trace'],
      ['Open timeout [10s]: ', '1s'],
      ['Message idle timeout [30s]: ', '4s'],
      ['Attempt timeout [60s]: ', '10s'],
      ['Ping interval [15s]: ', '2s'],
      ['Close timeout [5s]: ', '500ms'],
    ]);
    expect(
      await runCli(['agent', 'add', '--trace'], {
        workingDirectory: root,
        io: wizardIo.io,
        interaction: {
          ci: false,
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: (question) =>
            Promise.resolve(
              question.includes('Apply these changes?') ? 'yes' : (answers.get(question) ?? ''),
            ),
          readStdin: () => Promise.resolve(''),
        },
      }),
    ).toBe(0);

    const loaded = await loadProject({ project: root });
    expect(loaded.agents.map(({ id }) => id)).toEqual(['flags', 'imported', 'json', 'wizard']);
    for (const agent of loaded.agents) {
      expect(agent.transport).toEqual(canonicalTransport());
      expect(agent.redaction).toEqual({ headers: ['Authorization'] });
      expect(agent.capabilities).toEqual({ trace: true });
    }
  });

  it('derives a serial connection for per-case flags when the mode is omitted', async () => {
    const root = await createProject();
    const result = await run(root, [
      'agent',
      'add',
      'per-case-default',
      '--websocket-url',
      'wss://agent.example/socket',
      '--websocket-lifecycle',
      'per_case',
      '--output',
      'json',
    ]);
    expect(result.exitCode, result.output.join('')).toBe(0);
    const loaded = await loadProject({ project: root });
    expect(loaded.agents[0]?.transport).toMatchObject({
      kind: 'websocket',
      lifecycle: 'per_case',
      connection_mode: 'serial',
    });
  });

  it('aggregates inapplicable and conflicting flags before any project write', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    const inapplicable = await run(root, [
      'agent',
      'add',
      'invalid',
      '--websocket-url',
      'wss://agent.example/socket',
      '--cwd',
      './agent',
      '--env',
      'TOKEN=TOKEN_ENV',
      '--stream-framing',
      'sse',
      '--timeout',
      '1s',
      '--output',
      'json',
    ]);
    expect(inapplicable.exitCode).toBe(2);
    expect(JSON.parse(inapplicable.output[0] ?? '{}')).toMatchObject({
      error: {
        code: 'cli_usage',
        details: {
          incompatible_options: ['--cwd', '--env', '--stream-framing', '--timeout'],
        },
      },
    });

    const conflicting = await run(root, [
      'agent',
      'add',
      'conflicting',
      '--websocket-url',
      'wss://agent.example/socket',
      '--stream-url',
      'https://agent.example/events',
      '--output',
      'json',
    ]);
    expect(conflicting.exitCode).toBe(2);
    expect(JSON.parse(conflicting.output[0] ?? '{}')).toMatchObject({
      error: {
        code: 'cli_usage',
        details: { selected_transports: ['stream', 'websocket'] },
      },
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('returns explicit unsupported-mode and unsafe-secret diagnostics without writing', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    const unsupported = await run(root, [
      'agent',
      'add',
      'unsupported',
      '--websocket-url',
      'wss://agent.example/socket.io/?EIO=4',
      '--subprotocol',
      'graphql-transport-ws',
      '--output',
      'json',
    ]);
    expect(unsupported.exitCode).toBe(2);
    const unsupportedOutput = unsupported.output.join('');
    expect(unsupportedOutput).toContain('Socket.IO endpoints are unsupported');
    expect(unsupportedOutput).toContain('GraphQL subscription subprotocols are unsupported');
    expect(await snapshotTree(root)).toEqual(before);

    await writeFile(
      join(root, 'unsafe.json'),
      JSON.stringify({
        ...canonicalAgent('unsafe'),
        transport: {
          ...canonicalTransport(),
          headers: { 'X-API-Key': 'literal-secret' },
        },
      }),
    );
    const beforeUnsafeImport = await snapshotTree(root);
    const unsafe = await run(root, [
      'agent',
      'import',
      'unsafe.json',
      '--as',
      'unsafe',
      '--output',
      'json',
    ]);
    expect(unsafe.exitCode, unsafe.output.join('')).toBe(1);
    expect(JSON.parse(unsafe.output[0] ?? '{}')).toMatchObject({
      error: {
        code: 'project_invalid',
        message: 'Sensitive WebSocket headers must use references.',
      },
    });
    expect(await snapshotTree(root)).toEqual(beforeUnsafeImport);
  });

  it('rejects and redacts recursive request-template credentials from flags and JSON import', async () => {
    const root = await createProject();
    const beforeFlags = await snapshotTree(root);
    const flagSecret = 'flag-template-secret';
    const unsafeFlags = await run(root, [
      'agent',
      'add',
      'unsafe-flags',
      '--websocket-url',
      'wss://agent.example/socket',
      '--request-template',
      JSON.stringify({
        request_id: '{{request_id}}',
        nested: { api_key: flagSecret },
      }),
      '--output',
      'json',
    ]);
    expect(unsafeFlags.exitCode).toBe(1);
    expect(unsafeFlags.output.join('')).not.toContain(flagSecret);
    const flagDocument = JSON.parse(unsafeFlags.output[0] ?? '{}') as {
      error: { hint?: string; path?: string };
    };
    expect(flagDocument).toMatchObject({
      error: {
        code: 'project_invalid',
        message: 'WebSocket request templates cannot contain credential-like fields.',
        path: '/agent/transport/request_template/nested/api_key',
      },
    });
    expect(flagDocument.error.hint).toContain('--header-env');
    expect(await snapshotTree(root)).toEqual(beforeFlags);

    const importSecret = 'json-template-secret';
    await writeFile(
      join(root, 'unsafe-template.json'),
      JSON.stringify({
        ...canonicalAgent('unsafe-template'),
        transport: {
          ...canonicalTransport(),
          request_template: {
            request_id: '{{request_id}}',
            nested: [{ token: importSecret }],
          },
        },
      }),
    );
    const beforeImport = await snapshotTree(root);
    const unsafeImport = await run(root, [
      'agent',
      'import',
      'unsafe-template.json',
      '--as',
      'unsafe-import',
      '--output',
      'json',
    ]);
    expect(unsafeImport.exitCode).toBe(1);
    expect(unsafeImport.output.join('')).not.toContain(importSecret);
    const importDocument = JSON.parse(unsafeImport.output[0] ?? '{}') as {
      error: { hint?: string; path?: string };
    };
    expect(importDocument).toMatchObject({
      error: {
        code: 'project_invalid',
        message: 'WebSocket request templates cannot contain credential-like fields.',
        path: '/agent/transport/request_template/nested/0/token',
      },
    });
    expect(importDocument.error.hint).toContain('--header-env');
    expect(await snapshotTree(root)).toEqual(beforeImport);
  });

  it('routes agent.test flag and JSON requests through the integrated runtime surface', async () => {
    const root = await createProject();
    const fixture = await startLocalWebSocketFixture();
    process.env.ATTEST_WS_TOKEN = 'websocket-probe-secret';
    const addRequest = {
      schema: 'attest.command-request/v2',
      command: 'agent.add',
      agent: {
        ...canonicalAgent('probe'),
        transport: {
          ...canonicalTransport(),
          url: fixture.url,
          result_pointer: '/result',
        },
      },
    };
    expect(
      (
        await run(root, ['agent', 'add', '--from-json', '-', '--output', 'json'], () =>
          Promise.resolve(JSON.stringify(addRequest)),
        )
      ).exitCode,
    ).toBe(0);

    const flagProbe = await run(root, [
      'agent',
      'test',
      'probe',
      '--input',
      '{"question":"ping"}',
      '--output',
      'json',
    ]);
    expect(flagProbe.exitCode).toBe(0);
    const flagResult = JSON.parse(flagProbe.output[0] ?? '{}') as WebSocketProbeDocument;
    expect(flagResult).toMatchObject({
      command: 'agent.test',
      result: {
        transport: 'websocket',
      },
    });
    expect(flagResult.result.response.output.echoed_request_id).toMatch(/^ws-/u);
    expect(flagProbe.output.join('')).not.toContain('websocket-probe-secret');

    const testRequest = {
      schema: 'attest.command-request/v2',
      command: 'agent.test',
      agent_id: 'probe',
      input: { question: 'ping' },
    };
    const jsonProbe = await run(
      root,
      ['agent', 'test', '--from-json', '-', '--output', 'json'],
      () => Promise.resolve(JSON.stringify(testRequest)),
    );
    expect(jsonProbe.exitCode).toBe(0);
    const jsonResult = JSON.parse(jsonProbe.output[0] ?? '{}') as WebSocketProbeDocument;
    expect(jsonResult).toMatchObject({
      command: 'agent.test',
      result: {
        transport: 'websocket',
      },
    });
    expect(jsonResult.result.response.output.echoed_request_id).toMatch(/^ws-/u);
    expect(jsonProbe.output.join('')).not.toContain('websocket-probe-secret');
    const upgrades = fixture.events().filter((event) => event.type === 'upgrade_requested');
    expect(upgrades).toHaveLength(2);
    expect(
      upgrades.every((event) => event.headers?.authorization === 'websocket-probe-secret'),
    ).toBe(true);
  });

  it('publishes complete JSON help dependencies for WebSocket authoring', async () => {
    const root = await createProject();
    const helpResult = await run(root, ['help', 'agent', 'add', '--output', 'json']);
    expect(helpResult.exitCode).toBe(0);
    const help = JSON.parse(helpResult.output[0] ?? '{}') as {
      result: {
        command: {
          options: Array<{
            choices: string[];
            conflicts: string[];
            implies: string[];
            name: string;
            repeatable: boolean;
          }>;
        };
      };
    };
    const options = new Map(help.result.command.options.map((option) => [option.name, option]));
    expect(options.get('websocket-url')?.conflicts).toEqual(
      expect.arrayContaining([
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ]),
    );
    expect(options.get('connection-mode')?.choices).toEqual(['serial', 'multiplexed']);
    expect(options.get('connection-mode')?.implies).toContain('websocket-url');
    expect(options.get('acknowledgement-value')?.repeatable).toBe(true);
    expect(options.get('attempt-timeout')?.implies).toContain('websocket-url');
  });

  it('drives the compiled WebSocket wizard to a redacted cancellation with zero writes', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    await execFileAsync('bun', ['run', 'build'], { cwd: CLI_PACKAGE_ROOT, timeout: 30_000 });
    const { stderr, stdout } = await execFileAsync(
      'python3',
      [PTY_FIXTURE, 'guided-websocket-decline', root, process.execPath, CLI_BUILT],
      { timeout: 20_000 },
    );
    expect(stderr).toBe('');
    const result = JSON.parse(stdout) as {
      exit_code: number;
      output: string;
      prompts_seen: boolean;
      terminal_restored: boolean;
    };
    if (!result.prompts_seen) throw new Error(result.output);
    expect(result).toMatchObject({
      exit_code: 130,
      prompts_seen: true,
      terminal_restored: true,
    });
    expect(result.output).toContain('Redacted definition preview:');
    expect(result.output).toContain('ATTEST_PTY_WS_TOKEN');
    expect(result.output).not.toContain('pty-websocket-super-secret');
    expect(await snapshotTree(root)).toEqual(before);
  }, 30_000);
});
