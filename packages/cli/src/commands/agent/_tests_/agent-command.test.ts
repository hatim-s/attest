import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_PROTOCOL, cliHelpSchema, type AgentResource } from '@attest/contracts';
import { loadProject } from '@attest/local/project';
import { openStore } from '@attest/local/store';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createEmptyProject,
  createFixtureProject,
  runCommand,
  runJson,
  snapshotTree,
} from '../../../_tests_/support/cli-test-support.js';
import type { CliInteraction } from '../../shared/cli-interaction.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/native-agent.cjs', import.meta.url));
const WEBSOCKET_SERVER = new URL(
  '../../../../../executor/src/adapters/websocket/_tests_/support/test-websocket-server.ts',
  import.meta.url,
).href;
const originalWebSocketToken = process.env.ATTEST_WS_TOKEN;

type WebSocketFixtureServer = {
  close: () => Promise<void>;
  url: string;
};

/** A TTY terminal whose prompt answers come from `answer`. */
const tty = (answer: (question: string) => string): Partial<CliInteraction> => ({
  inputIsTTY: true,
  outputIsTTY: true,
  prompt: (question) => Promise.resolve(answer(question)),
});

const echoArgv = JSON.stringify([process.execPath, FIXTURE, 'echo']);

/** The WebSocket transport every authoring route must produce for the same inputs. */
const canonicalTransport = (): Extract<AgentResource['transport'], { kind: 'websocket' }> => ({
  kind: 'websocket',
  lifecycle: 'per_run',
  connection_mode: 'multiplexed',
  framing: 'text_json',
  url: 'wss://agent.example/socket',
  headers: { Authorization: { from_env: 'ATTEST_WS_TOKEN' } },
  subprotocol: 'attest',
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

const canonicalWebSocketAgent = (id: string): AgentResource => ({
  schema: 'attest.agent',
  id,
  name: id,
  transport: canonicalTransport(),
  redaction: { headers: ['Authorization'] },
  capabilities: { trace: true },
});

afterEach(() => {
  if (originalWebSocketToken === undefined) delete process.env.ATTEST_WS_TOKEN;
  else process.env.ATTEST_WS_TOKEN = originalWebSocketToken;
});

describe('agent commands', () => {
  it('routes guided, --from-json, and import requests to canonical resources', async () => {
    const root = await createEmptyProject();
    const questions: string[] = [];
    const guided = await runCommand(root, ['agent', 'add'], {
      interaction: tty((question) => {
        questions.push(question);
        if (question.includes('Apply these changes?')) return 'yes';
        if (question.startsWith('Agent id')) return 'guided';
        if (question.startsWith('Transport')) return 'cli';
        return 'node agent.mjs';
      }),
    });
    expect(guided.exitCode).toBe(0);
    expect(questions.slice(0, 3)).toEqual([
      'Agent id: ',
      'Transport [cli/http/background/jsonl/stream/websocket]: ',
      'Native command: ',
    ]);
    expect(questions[3]).toContain('Apply these changes? [y/N]');

    const agent = (id: string): AgentResource => ({
      schema: 'attest.agent',
      id,
      name: id,
      transport: { kind: 'native_cli', lifecycle: 'per_case', argv: ['node', 'agent.mjs'] },
    });
    const request = JSON.stringify({
      schema: 'attest.command-request',
      command: 'agent.add',
      agent: agent('requested'),
    });
    const fromJson = await runJson(root, ['agent', 'add', '--from-json', '-'], { stdin: request });
    expect(fromJson.exitCode).toBe(0);

    await writeFile(join(root, 'import.json'), JSON.stringify(agent('source-id')));
    const imported = await runJson(root, [
      'agent',
      'import',
      'import.json',
      '--type',
      'json',
      '--as',
      'imported',
    ]);
    expect(imported.exitCode).toBe(0);

    const loaded = await loadProject({ project: root });
    expect(loaded.agents.map(({ id }) => id)).toEqual(['guided', 'imported', 'requested']);
    expect(loaded.agents.find(({ id }) => id === 'guided')?.transport).toEqual(
      agent('guided').transport,
    );
  });

  it('reports missing non-TTY input and a request that shares stdin with its source', async () => {
    const root = await createEmptyProject();
    const missing = await runJson(root, ['agent', 'add']);
    expect(missing.exitCode).toBe(2);
    expect(missing.document).toMatchObject({
      ok: false,
      command: 'agent.add',
      error: { code: 'cli_missing_input' },
    });

    const request = JSON.stringify({
      schema: 'attest.command-request',
      command: 'agent.import',
      source: '-',
      source_type: 'json',
      as: 'stdin-agent',
    });
    const conflict = await runJson(root, ['agent', 'import', '--from-json', '-'], {
      stdin: request,
    });
    expect(conflict.exitCode).toBe(2);
    expect(conflict.document).toMatchObject({
      error: {
        code: 'cli_usage',
        message: 'The command request and its source cannot share stdin.',
      },
    });
  });

  it('passes --argv-json elements literally without shell semantics', async () => {
    const root = await createEmptyProject();
    const marker = join(root, 'must-not-exist');
    const hostileArgument = `;touch ${marker}`;
    const argv = JSON.stringify([process.execPath, FIXTURE, 'echo', hostileArgument, '$(false)']);
    expect((await runJson(root, ['agent', 'add', 'safe', '--argv-json', argv])).exitCode).toBe(0);

    const tested = await runJson(root, ['agent', 'test', 'safe', '--input', '{"ping":true}']);
    expect(tested.exitCode).toBe(0);
    expect(tested.document).toMatchObject({
      result: {
        response: {
          output: {
            argv: [hostileArgument, '$(false)'],
            handshake: { case_id: 'connection-test', protocol: AGENT_PROTOCOL },
            input: { ping: true },
          },
        },
      },
    });
    await expect(access(marker)).rejects.toBeDefined();
  });

  it('maps --sandbox-json onto native CLI agents and rejects it elsewhere', async () => {
    const root = await createEmptyProject();
    const sandbox = {
      kind: 'vercel',
      image: 'node:22',
      files: [{ source: 'src/agent.mjs', destination: 'workspace/agent.mjs', mode: 0o755 }],
      artifacts: [{ source: 'workspace/output.json', destination: 'artifacts/output.json' }],
      artifact_directory: '.attest/artifacts',
    };
    const added = await runJson(root, [
      'agent',
      'add',
      'sandboxed',
      '--native-command',
      'node workspace/agent.mjs',
      '--sandbox-json',
      JSON.stringify(sandbox),
    ]);
    expect(added.exitCode).toBe(0);
    expect((await loadProject({ project: root })).agents[0]?.transport).toMatchObject({
      kind: 'native_cli',
      sandbox,
    });

    const traversal = JSON.stringify({
      kind: 'vercel',
      files: [{ source: '../agent.mjs', destination: 'agent.mjs' }],
    });
    for (const [selector, value, invalidSandbox] of [
      ['--argv-json', '["node","agent.mjs"]', '{'],
      ['--argv-json', '["node","agent.mjs"]', traversal],
      [
        '--native-http',
        'https://example.com/invoke',
        JSON.stringify({ kind: 'vercel', files: [] }),
      ],
    ] as const) {
      const rejected = await runJson(root, [
        'agent',
        'add',
        'invalid-sandbox',
        selector,
        value,
        '--sandbox-json',
        invalidSandbox,
      ]);
      expect(rejected.exitCode).toBe(2);
      expect(rejected.document).toMatchObject({
        error: { code: 'cli_usage', path: '--sandbox-json' },
      });
    }
  });

  it('keeps dry runs deterministic and write-free and reports a stale --if-project-hash', async () => {
    const root = await createEmptyProject();
    const before = await snapshotTree(root);
    const command = ['agent', 'add', 'preview', '--argv-json', echoArgv, '--dry-run'];
    const first = await runJson(root, command);
    const second = await runJson(root, command);
    expect(second.output).toEqual(first.output);
    expect(first.document).toMatchObject({
      ok: true,
      result: { committed: false, dry_run: true, operations: [{ op: 'add' }] },
    });
    expect(await snapshotTree(root)).toEqual(before);

    const staleHash = 'a'.repeat(64);
    const conflict = await runJson(root, [
      'agent',
      'add',
      'conflict',
      '--argv-json',
      echoArgv,
      '--if-project-hash',
      staleHash,
    ]);
    expect(conflict.exitCode).toBe(3);
    expect(conflict.document).toMatchObject({
      error: { code: 'project_changed', details: { expected_hash: staleHash } },
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('renames references and removes a referenced agent only with --detach and --yes', async () => {
    const root = await createFixtureProject();
    const renamed = await runJson(root, ['agent', 'rename', 'support', 'support-renamed']);
    expect(renamed.exitCode).toBe(0);
    await expect(loadProject({ project: root })).resolves.toMatchObject({
      tests: [{ agent_id: 'support-renamed' }],
    });

    const blocked = await runJson(root, ['agent', 'remove', 'support-renamed']);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.document).toMatchObject({ error: { code: 'project_invalid' } });

    const humanPreview = await runCommand(root, [
      'agent',
      'remove',
      'support-renamed',
      '--detach',
      '--dry-run',
    ]);
    expect(humanPreview.exitCode).toBe(0);
    expect(humanPreview.output.join('\n')).toContain('Warning: Removed dependent tests: refund');

    const before = await snapshotTree(root);
    const unconfirmed = await runJson(root, ['agent', 'remove', 'support-renamed', '--detach']);
    expect(unconfirmed.exitCode).toBe(2);
    expect(unconfirmed.document).toMatchObject({ error: { code: 'cli_usage', path: '--yes' } });
    expect(await snapshotTree(root)).toEqual(before);

    const removed = await runJson(root, [
      'agent',
      'remove',
      'support-renamed',
      '--detach',
      '--yes',
    ]);
    expect(removed.exitCode).toBe(0);
    expect(removed.document).toMatchObject({
      result: { warnings: ['Removed dependent tests: refund'] },
    });
    await expect(loadProject({ project: root })).resolves.toMatchObject({ agents: [], tests: [] });
  });

  it('accepts common options before the namespace and rejects a repeated --output', async () => {
    const root = await createEmptyProject();
    const prefix = ['--output', 'json', '--non-interactive'];
    await writeFile(
      join(root, 'prefix-import.json'),
      JSON.stringify({
        schema: 'attest.agent',
        id: 'source',
        name: 'Prefix import',
        transport: {
          kind: 'native_cli',
          lifecycle: 'per_case',
          argv: [process.execPath, FIXTURE, 'echo'],
        },
      }),
    );
    for (const [command, argv] of [
      ['agent.add', ['agent', 'add', 'global-position', '--argv-json', echoArgv]],
      ['agent.import', ['agent', 'import', 'prefix-import.json', '--as', 'prefix-import']],
      ['agent.rename', ['agent', 'rename', 'global-position', 'renamed-global']],
      ['agent.test', ['agent', 'test', 'renamed-global']],
      ['agent.remove', ['agent', 'remove', 'prefix-import']],
    ] as const) {
      const result = await runCommand(root, [...prefix, ...argv]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output[0] ?? '')).toMatchObject({ command, ok: true });
    }

    const duplicate = await runCommand(root, [
      '--output',
      'json',
      'agent',
      'test',
      'renamed-global',
      '--output',
      'json',
    ]);
    expect(duplicate.exitCode).toBe(2);
    expect(JSON.parse(duplicate.output[0] ?? '')).toMatchObject({
      command: 'agent.test',
      error: { code: 'cli_usage', path: '--output' },
    });
  });

  it('shows the guided semantic preview and treats an empty confirmation as no', async () => {
    const root = await createEmptyProject();
    const before = await snapshotTree(root);
    const questions: string[] = [];
    const declined = await runCommand(root, ['agent', 'add'], {
      interaction: tty((question) => {
        questions.push(question);
        if (question.startsWith('Agent id')) return 'declined';
        if (question.startsWith('Transport')) return 'cli';
        if (question.startsWith('Native command')) return 'node agent.mjs';
        return '';
      }),
    });
    expect(declined.exitCode).toBe(130);
    expect(questions.at(-1)).toContain('- add agent declined');
    expect(questions.at(-1)).toContain('Apply these changes? [y/N]');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('shows the redacted guided cURL preview before decline and re-asks one bad body mapping', async () => {
    const root = await createEmptyProject();
    const secret = 'never-preview-this';
    await writeFile(
      join(root, 'guided.curl'),
      `curl https://agent.example -H 'Authorization: Bearer ${secret}' -H 'Content-Type: application/json' --data '{"prompt":"old"}'`,
    );
    const before = await snapshotTree(root);
    const questions: string[] = [];
    const responses = [
      'ATTEST_GUIDED_TOKEN',
      '/missing=/question',
      '',
      '',
      '',
      'direct',
      '/answer',
    ];
    const declined = await runCommand(
      root,
      ['agent', 'import', 'guided.curl', '--type', 'curl', '--as', 'guided'],
      {
        interaction: tty((question) => {
          questions.push(question);
          if (question.startsWith('Body mapping was invalid')) return '/prompt=/question';
          if (question.includes('Apply these changes?')) return 'no';
          return responses.shift() ?? '';
        }),
      },
    );
    expect(declined.exitCode).toBe(130);
    const confirmation = questions.find((question) => question.includes('Apply these changes?'));
    expect(confirmation).toContain('Redacted definition preview:');
    expect(confirmation).toContain('[from_env:ATTEST_GUIDED_TOKEN]');
    expect(confirmation).toContain('{{input/question}}');
    expect(confirmation).not.toContain(secret);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('removes its signal handlers after SIGINT cancels a guided test prompt', async () => {
    const root = await createEmptyProject();
    const before = await snapshotTree(root);
    const sigintBefore = process.listeners('SIGINT');
    const sigtermBefore = process.listeners('SIGTERM');
    let markPromptStarted = (): void => undefined;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    const pending = runCommand(root, ['agent', 'test', '--project', root], {
      interaction: {
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: (_question, options) =>
          new Promise<string>((_resolve, reject) => {
            markPromptStarted();
            options?.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('Prompt aborted.'), { name: 'AbortError' })),
              { once: true },
            );
          }),
      },
    });
    await promptStarted;
    const commandListeners = process
      .listeners('SIGINT')
      .filter((listener) => !sigintBefore.includes(listener));
    expect(commandListeners).toHaveLength(1);
    commandListeners[0]?.('SIGINT');

    const cancelled = await pending;
    expect(cancelled.exitCode).toBe(130);
    expect(cancelled.errors.join('\n')).toContain('cancelled: Command cancelled.');
    expect(process.listeners('SIGINT')).toEqual(sigintBefore);
    expect(process.listeners('SIGTERM')).toEqual(sigtermBefore);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('keeps --watch human-only and records a probe run only with --record', async () => {
    const root = await createEmptyProject();
    expect((await runJson(root, ['agent', 'add', 'probe', '--argv-json', echoArgv])).exitCode).toBe(
      0,
    );
    const store = join(root, '.attest', 'runs.db');

    const jsonWatch = await runJson(root, ['agent', 'test', 'probe', '--watch']);
    expect(jsonWatch.exitCode).toBe(2);
    expect(jsonWatch.document).toMatchObject({ error: { code: 'cli_usage' } });

    const watched = await runCommand(root, ['agent', 'test', 'probe', '--watch'], {
      interaction: { inputIsTTY: true, outputIsTTY: true },
    });
    expect(watched.exitCode).toBe(0);
    expect(watched.errors).toEqual(['Testing agent probe...', 'Agent probe completed.']);
    await expect(access(store)).rejects.toBeDefined();

    const recorded = await runJson(root, ['agent', 'test', 'probe', '--record']);
    expect(recorded.exitCode).toBe(0);
    const probe = recorded.document.ok ? recorded.document.result : undefined;
    if (typeof probe !== 'object' || probe === null || Array.isArray(probe)) {
      throw new Error('Expected a recorded probe result.');
    }
    const runId = probe.recorded_run_id;
    if (typeof runId !== 'string') throw new Error('Expected a recorded run id.');
    const runs = await openStore(store);
    try {
      await expect(runs.runs.getRun(runId)).resolves.toMatchObject({
        status: 'completed',
        labels: { agent_id: 'probe', kind: 'agent-probe' },
      });
    } finally {
      await runs.close();
    }
  });

  it('reports the exact duration option in a structured failure', async () => {
    const root = await createEmptyProject();
    await writeFile(join(root, 'duration.curl'), 'curl https://agent.example');
    const polling = [
      '--poll-job-id-pointer',
      '/job',
      '--poll-status-url-pointer',
      '/url',
      '--poll-status-pointer',
      '/status',
      '--poll-success',
      '"done"',
      '--poll-failure',
      '"failed"',
      '--poll-maximum-interval',
      '1s',
    ];
    for (const [option, extra] of [
      ['--connect-timeout', []],
      ['--poll-minimum-interval', polling],
    ] as const) {
      const result = await runJson(root, [
        'agent',
        'import',
        'duration.curl',
        '--type',
        'curl',
        '--as',
        'bad-duration',
        '--response-pointer',
        '',
        ...extra,
        option,
        'nope',
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.document).toMatchObject({ error: { path: option } });
    }
  });

  it('rejects flags the selected transport would discard and publishes the matrix in help', async () => {
    const root = await createEmptyProject();
    for (const flags of [
      ['--stream-url', 'http://127.0.0.1:1234/stream', '--env', 'TOKEN=STREAM_TOKEN'],
      ['--jsonl-command', 'node bridge.mjs', '--header-env', 'Authorization=BRIDGE_TOKEN'],
      ['--stream-url', 'http://127.0.0.1:1234/stream', '--incremental-output-mode', 'text'],
    ]) {
      const result = await runJson(root, ['agent', 'add', 'rejected', ...flags]);
      expect(result.exitCode).toBe(2);
      expect(result.document).toMatchObject({ error: { code: 'cli_usage' } });
    }

    const stream = await runJson(root, [
      'agent',
      'add',
      'stream-auth',
      '--stream-url',
      'http://127.0.0.1:1234/stream',
      '--header-env',
      'Authorization=STREAM_TOKEN',
      '--terminal-pointer',
      '/state',
      '--terminal-value',
      '"done"',
    ]);
    expect(stream.exitCode).toBe(0);
    const bridge = await runJson(root, [
      'agent',
      'add',
      'bridge-env',
      '--jsonl-command',
      'node bridge.mjs',
      '--env',
      'TOKEN=BRIDGE_TOKEN',
    ]);
    expect(bridge.exitCode).toBe(0);
    const loaded = await loadProject({ project: root });
    expect(loaded.agents.find(({ id }) => id === 'stream-auth')?.transport).toMatchObject({
      request: { headers: { Authorization: { from_env: 'STREAM_TOKEN' } } },
      terminal_pointer: '/state',
      terminal_values: ['done'],
    });
    expect(loaded.agents.find(({ id }) => id === 'bridge-env')?.transport).toMatchObject({
      env: { TOKEN: { from_env: 'BRIDGE_TOKEN' } },
    });

    const helpOptions = async (command: string) => {
      const help = await runJson(root, ['help', 'agent', command]);
      if (!help.document.ok) throw new Error(`Expected agent ${command} help.`);
      const { options } = cliHelpSchema.parse(help.document.result).command;
      return new Map(options.map((option) => [option.name, option]));
    };
    const add = await helpOptions('add');
    expect(add.get('env')?.conflicts).toContain('stream-url');
    expect(add.get('header-env')?.conflicts).toContain('jsonl-command');
    expect(add.get('incremental-output-mode')?.implies).toContain('incremental-output-pointer');
    expect(add.get('sandbox-json')?.conflicts).toEqual([
      'from-json',
      'native-http',
      'background-command',
      'jsonl-command',
      'stream-url',
      'websocket-url',
    ]);
    expect(add.get('native-http')?.conflicts).toContain('sandbox-json');
    expect(add.get('websocket-url')?.conflicts).toEqual(
      expect.arrayContaining([
        'argv-json',
        'native-command',
        'native-http',
        'background-command',
        'jsonl-command',
        'stream-url',
      ]),
    );
    expect(add.get('connection-mode')?.choices).toEqual(['serial', 'multiplexed']);
    expect(add.get('connection-mode')?.implies).toContain('websocket-url');
    expect(add.get('acknowledgement-value')?.repeatable).toBe(true);
    expect(add.get('attempt-timeout')?.implies).toContain('websocket-url');

    const importOptions = await helpOptions('import');
    for (const name of ['header-env', 'query-env', 'map-body', 'poll-success', 'poll-failure']) {
      expect(importOptions.get(name)?.repeatable).toBe(true);
    }
  });
});

describe('WebSocket agent commands', () => {
  it('builds one resource shape from flags, --from-json, JSON import, and the wizard', async () => {
    const root = await createEmptyProject();
    process.env.ATTEST_WS_TOKEN = 'websocket-super-secret';
    const flags = await runJson(root, [
      'agent',
      'add',
      'flags',
      '--websocket-url',
      'wss://agent.example/socket',
      '--header-env',
      'Authorization=ATTEST_WS_TOKEN',
      '--subprotocol',
      'attest',
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
    ]);
    expect(flags.exitCode).toBe(0);
    expect(flags.output.join('')).not.toContain('websocket-super-secret');

    const request = JSON.stringify({
      schema: 'attest.command-request',
      command: 'agent.add',
      agent: canonicalWebSocketAgent('json'),
    });
    const fromJson = await runJson(root, ['agent', 'add', '--from-json', '-'], { stdin: request });
    expect(fromJson.exitCode).toBe(0);

    await writeFile(
      join(root, 'websocket-agent.json'),
      JSON.stringify(canonicalWebSocketAgent('source')),
    );
    const imported = await runJson(root, [
      'agent',
      'import',
      'websocket-agent.json',
      '--type',
      'json',
      '--as',
      'imported',
    ]);
    expect(imported.exitCode).toBe(0);

    const answers = new Map<string, string>([
      ['Agent id: ', 'wizard'],
      ['Transport [cli/http/background/jsonl/stream/websocket]: ', 'websocket'],
      ['WebSocket URL: ', 'wss://agent.example/socket'],
      [
        'Header environment references HEADER=ENV, comma-separated [none]: ',
        'Authorization=ATTEST_WS_TOKEN',
      ],
      ['WebSocket subprotocol [none]: ', 'attest'],
      ['Trace JSON Pointer [none]: ', '/trace'],
      ['Open timeout [10s]: ', '1s'],
      ['Message idle timeout [30s]: ', '4s'],
      ['Attempt timeout [60s]: ', '10s'],
      ['Ping interval [15s]: ', '2s'],
      ['Close timeout [5s]: ', '500ms'],
    ]);
    const wizard = await runCommand(root, ['agent', 'add', '--trace'], {
      interaction: tty((question) =>
        question.includes('Apply these changes?') ? 'yes' : (answers.get(question) ?? ''),
      ),
    });
    expect(wizard.exitCode).toBe(0);

    const loaded = await loadProject({ project: root });
    expect(loaded.agents.map(({ id }) => id)).toEqual(['flags', 'imported', 'json', 'wizard']);
    for (const agent of loaded.agents) {
      expect(agent.transport).toEqual(canonicalTransport());
      expect(agent.redaction).toEqual({ headers: ['Authorization'] });
      expect(agent.capabilities).toEqual({ trace: true });
    }
  }, 10_000);

  it('derives a serial connection for per-case flags when the mode is omitted', async () => {
    const root = await createEmptyProject();
    const added = await runJson(root, [
      'agent',
      'add',
      'per-case-default',
      '--websocket-url',
      'wss://agent.example/socket',
      '--websocket-lifecycle',
      'per_case',
    ]);
    expect(added.exitCode).toBe(0);
    expect((await loadProject({ project: root })).agents[0]?.transport).toMatchObject({
      kind: 'websocket',
      lifecycle: 'per_case',
      connection_mode: 'serial',
    });
  });

  it('aggregates inapplicable and conflicting flags before any project write', async () => {
    const root = await createEmptyProject();
    const before = await snapshotTree(root);
    const inapplicable = await runJson(root, [
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
    ]);
    expect(inapplicable.exitCode).toBe(2);
    expect(inapplicable.document).toMatchObject({
      error: {
        code: 'cli_usage',
        details: { incompatible_options: ['--cwd', '--env', '--stream-framing', '--timeout'] },
      },
    });

    const conflicting = await runJson(root, [
      'agent',
      'add',
      'conflicting',
      '--websocket-url',
      'wss://agent.example/socket',
      '--stream-url',
      'https://agent.example/events',
    ]);
    expect(conflicting.exitCode).toBe(2);
    expect(conflicting.document).toMatchObject({
      error: { code: 'cli_usage', details: { selected_transports: ['stream', 'websocket'] } },
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('routes agent.test flag and --from-json requests to the WebSocket runtime', async () => {
    const root = await createEmptyProject();
    const { startTestWebSocketServer } = (await import(WEBSOCKET_SERVER)) as {
      startTestWebSocketServer: (options: {
        subprotocol: string;
        onConnection: (_peer: unknown, request: { headers: { authorization?: string } }) => void;
        onMessage: (peer: { sendJson: (value: unknown) => void }, value: unknown) => void;
      }) => Promise<WebSocketFixtureServer>;
    };
    const authorizations: (string | undefined)[] = [];
    const server = await startTestWebSocketServer({
      subprotocol: 'attest',
      onConnection: (_peer, request) => authorizations.push(request.headers.authorization),
      onMessage: (peer, value) => {
        const { request_id } = value as { request_id: string };
        peer.sendJson({ request_id, type: 'acknowledgement' });
        peer.sendJson({ request_id, result: { echoed_request_id: request_id } });
      },
    });
    try {
      process.env.ATTEST_WS_TOKEN = 'websocket-probe-secret';
      const addRequest = JSON.stringify({
        schema: 'attest.command-request',
        command: 'agent.add',
        agent: {
          ...canonicalWebSocketAgent('probe'),
          transport: { ...canonicalTransport(), url: server.url, result_pointer: '/result' },
        },
      });
      expect(
        (await runJson(root, ['agent', 'add', '--from-json', '-'], { stdin: addRequest })).exitCode,
      ).toBe(0);

      const testRequest = JSON.stringify({
        schema: 'attest.command-request',
        command: 'agent.test',
        agent_id: 'probe',
        input: { question: 'ping' },
      });
      for (const probe of [
        await runJson(root, ['agent', 'test', 'probe', '--input', '{"question":"ping"}']),
        await runJson(root, ['agent', 'test', '--from-json', '-'], { stdin: testRequest }),
      ]) {
        expect(probe.exitCode).toBe(0);
        expect(probe.document).toMatchObject({
          command: 'agent.test',
          result: { transport: 'websocket' },
        });
        expect(probe.output[0]).toMatch(/"echoed_request_id":"ws-/u);
        expect(probe.output.join('')).not.toContain('websocket-probe-secret');
      }
      expect(authorizations).toEqual(['websocket-probe-secret', 'websocket-probe-secret']);
    } finally {
      await server.close();
    }
  });
});
