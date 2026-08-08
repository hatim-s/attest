import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { cliResultSchema, type AgentResource } from '@attest/contracts';
import { openStore } from '@attest/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttestCliError } from '../../errors.js';
import { loadProject } from '../../project/load-project.js';
import { runCli, type CliIo } from '../../run-cli.js';
import { runAgentAddCommand, runAgentRemoveCommand, runAgentTestCommand } from './agent-command.js';
import { readSecretReference, REDACTED } from './native-agent-adapter.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/native-agent.cjs', import.meta.url));
const PTY_FIXTURE = fileURLToPath(new URL('./fixtures/pty-agent-command.py', import.meta.url));
const CLI_PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI_BUILT = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const originalSecret = process.env.ATTEST_SOURCE_SECRET;

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

/** Narrows parsed JSON and structured error details without trusting their runtime shape. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Verifies the stable repair-bearing conflict contract returned after prompt-time drift. */
const expectProjectConflict = (error: unknown): void => {
  expect(error).toBeInstanceOf(AttestCliError);
  if (!(error instanceof AttestCliError)) throw new Error('Expected an Attest CLI error.');
  expect(error.code).toBe('project_changed');
  expect(error.hint).toBe('Read the current project hash, rebuild the candidate, and retry.');
  expect(isRecord(error.details)).toBe(true);
  if (!isRecord(error.details)) throw new Error('Expected project conflict hash details.');
  expect(typeof error.details.current_hash).toBe('string');
  expect(typeof error.details.expected_hash).toBe('string');
  expect(error.details.current_hash).not.toBe(error.details.expected_hash);
};

/** Creates an isolated empty v2 project through the public command path. */
const createProject = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), 'attest-agent-command-'));
  temporaryDirectories.push(parent);
  const io = collectIo();
  expect(
    await runCli(['project', 'init', 'demo', '--name', 'Demo', '--output', 'json'], {
      interaction: nonInteractive,
      io: io.io,
      workingDirectory: parent,
    }),
  ).toBe(0);
  return join(parent, 'demo');
};

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

/** Captures every project byte recursively for zero-write and rollback assertions. */
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

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalSecret === undefined) delete process.env.ATTEST_SOURCE_SECRET;
  else process.env.ATTEST_SOURCE_SECRET = originalSecret;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('CLI2.6 agent authoring', () => {
  it('keeps guided, flag, stdin, and from-json add/import paths on canonical resources', async () => {
    const root = await createProject();
    const questions: string[] = [];
    const guided = collectIo();
    expect(
      await runCli(['agent', 'add'], {
        workingDirectory: root,
        io: guided.io,
        interaction: {
          ci: false,
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: (question) => {
            questions.push(question);
            return Promise.resolve(
              question.includes('Apply these changes?')
                ? 'yes'
                : question.startsWith('Agent id')
                  ? 'guided'
                  : question.startsWith('Transport')
                    ? 'cli'
                    : `${process.execPath} ${FIXTURE} echo`,
            );
          },
          readStdin: () => Promise.resolve(''),
        },
      }),
    ).toBe(0);
    expect(questions.slice(0, 3)).toEqual([
      'Agent id: ',
      'Transport [cli/http]: ',
      'Native command: ',
    ]);
    expect(questions[3]).toContain('Apply these changes? [y/N]');

    const request = JSON.stringify({
      schema: 'attest.command-request/v2',
      command: 'agent.add',
      agent: {
        schema: 'attest.agent/v2',
        id: 'requested',
        name: 'Requested',
        transport: {
          kind: 'native_cli',
          lifecycle: 'per_case',
          argv: [process.execPath, FIXTURE, 'echo'],
        },
      },
    });
    expect(
      (
        await run(root, ['agent', 'add', '--from-json', '-', '--output', 'json'], () =>
          Promise.resolve(request),
        )
      ).exitCode,
    ).toBe(0);

    await writeFile(
      join(root, 'import.json'),
      JSON.stringify({
        schema: 'attest.agent/v2',
        id: 'source-id',
        name: 'Imported',
        transport: {
          kind: 'native_cli',
          lifecycle: 'per_case',
          argv: [process.execPath, FIXTURE, 'echo'],
        },
      }),
    );
    expect(
      (
        await run(root, [
          'agent',
          'import',
          'import.json',
          '--type',
          'json',
          '--as',
          'imported',
          '--output',
          'json',
        ])
      ).exitCode,
    ).toBe(0);
    const loaded = await loadProject({ project: root });
    expect(loaded.agents.map(({ id }) => id)).toEqual(['guided', 'imported', 'requested']);
  });

  it('returns non-TTY missing-input and stdin/request conflicts as one structured failure', async () => {
    const root = await createProject();
    const missing = await run(root, ['agent', 'add', '--output', 'json']);
    expect(missing.exitCode).toBe(2);
    expect(missing.errors).toEqual([]);
    expect(JSON.parse(missing.output[0] ?? '{}')).toMatchObject({
      ok: false,
      command: 'agent.add',
      error: { code: 'cli_missing_input' },
    });

    const request = JSON.stringify({
      schema: 'attest.command-request/v2',
      command: 'agent.import',
      source: '-',
      source_type: 'json',
      as: 'stdin-agent',
    });
    const conflict = await run(
      root,
      ['agent', 'import', '--from-json', '-', '--output', 'json'],
      () => Promise.resolve(request),
    );
    expect(conflict.exitCode).toBe(2);
    expect(conflict.output[0]).toContain('share stdin');
    expect(JSON.parse(conflict.output[0] ?? '{}')).toMatchObject({
      error: { code: 'cli_usage' },
    });
  });

  it('uses argv arrays literally and never gives shell metacharacters execution semantics', async () => {
    const root = await createProject();
    const marker = join(root, 'must-not-exist');
    const hostileArgument = `;touch ${marker}`;
    const argv = JSON.stringify([process.execPath, FIXTURE, 'echo', hostileArgument, '$(false)']);
    expect(
      (await run(root, ['agent', 'add', 'safe', '--argv-json', argv, '--output', 'json'])).exitCode,
    ).toBe(0);
    const tested = await run(root, [
      'agent',
      'test',
      'safe',
      '--input',
      '{"ping":true}',
      '--output',
      'json',
    ]);
    expect(tested.exitCode).toBe(0);
    expect(JSON.parse(tested.output[0] ?? '{}')).toMatchObject({
      result: {
        response: {
          output: {
            argv: [hostileArgument, '$(false)'],
            handshake: {
              case_id: 'connection-test',
              protocol: 'attest.agent/v1alpha1',
              run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
            },
            input: { ping: true },
          },
        },
      },
    });
    await expect(access(marker)).rejects.toBeDefined();
  });

  it('redacts CLI secrets from successful and hostile process evidence', async () => {
    const root = await createProject();
    process.env.ATTEST_SOURCE_SECRET = 'literal-super-secret';
    for (const [id, behavior] of [
      ['success', 'trace'],
      ['hostile', 'invalid'],
    ] as const) {
      const argv = JSON.stringify([process.execPath, FIXTURE, behavior]);
      expect(
        (
          await run(root, [
            'agent',
            'add',
            id,
            '--argv-json',
            argv,
            '--env',
            'ATTEST_TEST_SECRET=ATTEST_SOURCE_SECRET',
            '--trace',
            '--output',
            'json',
          ])
        ).exitCode,
      ).toBe(0);
    }

    const success = await run(root, ['agent', 'test', 'success', '--output', 'json']);
    expect(success.exitCode).toBe(0);
    expect(success.output.join('')).not.toContain('literal-super-secret');
    expect(JSON.parse(success.output[0] ?? '{}')).toMatchObject({
      result: {
        response: { output: { secret: REDACTED }, trace: { trace_id: 'connection-trace' } },
      },
    });

    const hostile = await run(root, ['agent', 'test', 'hostile', '--output', 'json']);
    expect(hostile.exitCode).toBe(4);
    expect(hostile.output.join('')).not.toContain('literal-super-secret');
    expect(hostile.output.join('')).toContain(REDACTED);
    expect(JSON.parse(hostile.output[0] ?? '{}')).toMatchObject({
      error: {
        code: 'invocation_failed',
        details: {
          invocation_code: 'invalid_envelope',
        },
      },
    });
  });

  it('passes runtime HTTP headers but redacts hostile HTTP responses and traces', async () => {
    const root = await createProject();
    process.env.ATTEST_SOURCE_SECRET = 'http-super-secret';
    let observedAuthorization: string | null = null;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      observedAuthorization = new Headers(init.headers).get('authorization');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            protocol: 'attest.agent/v1alpha1',
            output: { authorization: observedAuthorization, echoed: 'http-super-secret' },
            trace: {
              schema: 'attest.trace/v1alpha1',
              trace_id: 'http-trace',
              spans: [],
            },
          }),
          { status: 200 },
        ),
      );
    });
    expect(
      (
        await run(root, [
          'agent',
          'add',
          'http-agent',
          '--native-http',
          'https://agent.example/invoke',
          '--header-env',
          'Authorization=ATTEST_SOURCE_SECRET',
          '--output',
          'json',
        ])
      ).exitCode,
    ).toBe(0);
    const tested = await run(root, ['agent', 'test', 'http-agent', '--output', 'json']);
    expect(observedAuthorization).toBe('http-super-secret');
    expect(tested.output.join('')).not.toContain('http-super-secret');
    expect(JSON.parse(tested.output[0] ?? '{}')).toMatchObject({
      result: {
        response: {
          output: { authorization: REDACTED, echoed: REDACTED },
          trace: { trace_id: 'http-trace' },
        },
      },
    });
  });

  it('classifies timeout and cancellation without writing project bytes', async () => {
    const root = await createProject();
    const argv = JSON.stringify([process.execPath, FIXTURE, 'hang']);
    expect(
      (
        await run(root, [
          'agent',
          'add',
          'slow',
          '--argv-json',
          argv,
          '--timeout',
          '20ms',
          '--output',
          'json',
        ])
      ).exitCode,
    ).toBe(0);
    const before = await snapshotTree(root);
    const timeout = await run(root, ['agent', 'test', 'slow', '--output', 'json']);
    expect(timeout.exitCode).toBe(4);
    expect(JSON.parse(timeout.output[0] ?? '{}')).toMatchObject({
      error: { code: 'invocation_failed', details: { invocation_code: 'timeout' } },
    });

    const controller = new AbortController();
    const pending = runAgentTestCommand({
      agentId: 'slow',
      interactive: false,
      project: root,
      readStdin: () => Promise.resolve(''),
      signal: controller.signal,
      workingDirectory: root,
    });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(await snapshotTree(root)).toEqual(before);
  }, 15_000);

  it('keeps dry-run deterministic and write-free and reports stale project hashes', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    const argv = JSON.stringify([process.execPath, FIXTURE, 'echo']);
    const command = [
      'agent',
      'add',
      'preview',
      '--argv-json',
      argv,
      '--dry-run',
      '--output',
      'json',
    ];
    const first = await run(root, command);
    const second = await run(root, command);
    expect(second.output).toEqual(first.output);
    expect(JSON.parse(first.output[0] ?? '{}')).toMatchObject({
      ok: true,
      result: { committed: false, dry_run: true, operations: [{ op: 'add' }] },
    });
    expect(await snapshotTree(root)).toEqual(before);

    const conflict = await run(root, [
      'agent',
      'add',
      'conflict',
      '--argv-json',
      argv,
      '--if-project-hash',
      'a'.repeat(64),
      '--output',
      'json',
    ]);
    expect(conflict.exitCode).toBe(3);
    expect(JSON.parse(conflict.output[0] ?? '{}')).toMatchObject({
      error: { code: 'project_changed', details: { expected_hash: 'a'.repeat(64) } },
    });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('rejects prompt-time project drift without replacing concurrent authored resources', async () => {
    const root = await createProject();
    const argvJson = JSON.stringify([process.execPath, FIXTURE, 'echo']);
    let addConflict: unknown;
    try {
      await runAgentAddCommand({
        agentId: 'previewed',
        argvJson,
        interactive: true,
        project: root,
        prompt: async (question) => {
          expect(question).toContain('- add agent previewed');
          await runAgentAddCommand({
            agentId: 'racer',
            argvJson,
            interactive: false,
            project: root,
            readStdin: () => Promise.resolve(''),
            workingDirectory: root,
          });
          return 'yes';
        },
        readStdin: () => Promise.resolve(''),
        workingDirectory: root,
      });
    } catch (error: unknown) {
      addConflict = error;
    }
    expectProjectConflict(addConflict);
    await expect(loadProject({ project: root })).resolves.toMatchObject({
      agents: [{ id: 'racer' }],
    });

    const loaded = await loadProject({ project: root });
    const candidate = structuredClone({
      agents: loaded.agents,
      datasets: loaded.datasets,
      metrics: loaded.metrics,
      project: loaded.project,
      tests: loaded.tests,
    });
    candidate.tests.push({
      schema: 'attest.test/v2',
      id: 'racer-smoke',
      name: 'Racer smoke',
      agent_id: 'racer',
      cases: [],
      datasets: [],
      metrics: [],
    });
    const { applyProjectMutation } = await import('../../project/transaction/index.js');
    await applyProjectMutation({ candidate, projectRoot: root });

    let removeConflict: unknown;
    try {
      await runAgentRemoveCommand({
        agentId: 'racer',
        detach: true,
        interactive: true,
        project: root,
        prompt: async (question) => {
          expect(question).toContain('- remove test racer-smoke');
          await runAgentAddCommand({
            agentId: 'concurrent',
            argvJson,
            interactive: false,
            project: root,
            readStdin: () => Promise.resolve(''),
            workingDirectory: root,
          });
          return 'yes';
        },
        readStdin: () => Promise.resolve(''),
        workingDirectory: root,
      });
    } catch (error: unknown) {
      removeConflict = error;
    }
    expectProjectConflict(removeConflict);
    await expect(loadProject({ project: root })).resolves.toMatchObject({
      agents: [{ id: 'concurrent' }, { id: 'racer' }],
      tests: [{ agent_id: 'racer', id: 'racer-smoke' }],
    });
  });

  it('rolls back an injected publication failure and preserves the prior project', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    await expect(
      runAgentAddCommand({
        agentId: 'rollback',
        argvJson: JSON.stringify([process.execPath, FIXTURE, 'echo']),
        interactive: false,
        project: root,
        publishObserver: () => {
          throw new Error('injected publish failure');
        },
        readStdin: () => Promise.resolve(''),
        workingDirectory: root,
      }),
    ).rejects.toMatchObject({ code: 'project_transaction_failed' });
    expect(await snapshotTree(root)).toEqual(before);
  }, 15_000);

  it('renames references and requires explicit detach for dependent removal', async () => {
    const root = await createProject();
    const argv = JSON.stringify([process.execPath, FIXTURE, 'echo']);
    expect(
      (await run(root, ['agent', 'add', 'support', '--argv-json', argv, '--output', 'json']))
        .exitCode,
    ).toBe(0);
    const loaded = await loadProject({ project: root });
    const candidate = structuredClone({
      agents: loaded.agents,
      datasets: loaded.datasets,
      metrics: loaded.metrics,
      project: loaded.project,
      tests: loaded.tests,
    });
    candidate.tests.push({
      schema: 'attest.test/v2',
      id: 'smoke',
      name: 'Smoke',
      agent_id: 'support',
      cases: [],
      datasets: [],
      metrics: [],
    });
    const { applyProjectMutation } = await import('../../project/transaction/index.js');
    await applyProjectMutation({ candidate, projectRoot: root });

    expect(
      (await run(root, ['agent', 'rename', 'support', 'support-v2', '--output', 'json'])).exitCode,
    ).toBe(0);
    await expect(loadProject({ project: root })).resolves.toMatchObject({
      tests: [{ agent_id: 'support-v2' }],
    });
    const blocked = await run(root, ['agent', 'remove', 'support-v2', '--output', 'json']);
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.output[0] ?? '{}')).toMatchObject({
      error: { code: 'project_invalid' },
    });
    const humanPreview = await run(root, [
      'agent',
      'remove',
      'support-v2',
      '--detach',
      '--dry-run',
    ]);
    expect(humanPreview.exitCode).toBe(0);
    expect(humanPreview.output.join('\n')).toContain('Warning: Removed dependent tests: smoke');
    const beforeCascade = await snapshotTree(root);
    const confirmationRequired = await run(root, [
      'agent',
      'remove',
      'support-v2',
      '--detach',
      '--output',
      'json',
    ]);
    expect(confirmationRequired.exitCode).toBe(2);
    expect(JSON.parse(confirmationRequired.output[0] ?? '{}')).toMatchObject({
      error: { code: 'cli_usage', path: '--yes' },
    });
    expect(await snapshotTree(root)).toEqual(beforeCascade);
    const removed = await run(root, [
      'agent',
      'remove',
      'support-v2',
      '--detach',
      '--yes',
      '--output',
      'json',
    ]);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.output[0] ?? '{}')).toMatchObject({
      result: { warnings: ['Removed dependent tests: smoke'] },
    });
    await expect(loadProject({ project: root })).resolves.toMatchObject({ agents: [], tests: [] });
  });

  it('accepts common options before the namespace and rejects duplicate positions deterministically', async () => {
    const root = await createProject();
    const argv = JSON.stringify([process.execPath, FIXTURE, 'echo']);
    const prefixed = await run(root, [
      '--output',
      'json',
      '--non-interactive',
      'agent',
      'add',
      'global-position',
      '--argv-json',
      argv,
    ]);
    expect(prefixed.exitCode).toBe(0);
    expect(JSON.parse(prefixed.output[0] ?? '{}')).toMatchObject({
      command: 'agent.add',
      ok: true,
    });
    await writeFile(
      join(root, 'prefix-import.json'),
      JSON.stringify({
        schema: 'attest.agent/v2',
        id: 'source',
        name: 'Prefix import',
        transport: {
          kind: 'native_cli',
          lifecycle: 'per_case',
          argv: [process.execPath, FIXTURE, 'echo'],
        },
      }),
    );
    for (const command of [
      ['agent', 'import', 'prefix-import.json', '--as', 'prefix-import'],
      ['agent', 'rename', 'global-position', 'renamed-global'],
      ['agent', 'test', 'renamed-global'],
      ['agent', 'remove', 'prefix-import'],
    ]) {
      const result = await run(root, ['--output', 'json', '--non-interactive', ...command]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output[0] ?? '{}')).toMatchObject({ ok: true });
    }

    const duplicate = await run(root, [
      '--output',
      'json',
      'agent',
      'test',
      'renamed-global',
      '--output',
      'json',
    ]);
    expect(duplicate.exitCode).toBe(2);
    expect(JSON.parse(duplicate.output[0] ?? '{}')).toMatchObject({
      command: 'agent.test',
      error: { code: 'cli_usage', path: '--output' },
    });
  });

  it('shows a guided semantic preview and defaults confirmation to no', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    const questions: string[] = [];
    const collected = collectIo();
    const exitCode = await runCli(['agent', 'add'], {
      interaction: {
        ci: false,
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: (question) => {
          questions.push(question);
          if (question.startsWith('Agent id')) return Promise.resolve('declined');
          if (question.startsWith('Transport')) return Promise.resolve('cli');
          if (question.startsWith('Native command')) {
            return Promise.resolve(`${process.execPath} ${FIXTURE} echo`);
          }
          return Promise.resolve('');
        },
        readStdin: () => Promise.resolve(''),
      },
      io: collected.io,
      workingDirectory: root,
    });
    expect(exitCode).toBe(130);
    expect(questions.at(-1)).toContain('- add agent declined');
    expect(questions.at(-1)).toContain('Apply these changes? [y/N]');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('applies declared argv and header redaction policies to every attempt and response', async () => {
    const root = await createProject();
    const argvSecret = 's3cr3t-value';
    const imported: AgentResource = {
      schema: 'attest.agent/v2',
      id: 'source',
      name: 'Redacted CLI',
      transport: {
        kind: 'native_cli',
        lifecycle: 'per_case',
        argv: [process.execPath, FIXTURE, 'echo', argvSecret],
      },
      redaction: { argv_positions: [3] },
    };
    await writeFile(join(root, 'redacted-agent.json'), JSON.stringify(imported));
    expect(
      (
        await run(root, [
          'agent',
          'import',
          'redacted-agent.json',
          '--as',
          'redacted-cli',
          '--output',
          'json',
        ])
      ).exitCode,
    ).toBe(0);
    const cliProbe = await run(root, ['agent', 'test', 'redacted-cli', '--output', 'json']);
    expect(cliProbe.output.join('')).not.toContain(argvSecret);
    expect(cliProbe.output.join('')).toContain(REDACTED);

    const headerSecret = 'opaque-header-value';
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            protocol: 'attest.agent/v1alpha1',
            output: { received: new Headers(init.headers).get('x-opaque') },
          }),
          { status: 200 },
        ),
      ),
    );
    await writeFile(
      join(root, 'redacted-http.json'),
      JSON.stringify({
        schema: 'attest.agent/v2',
        id: 'source-http',
        name: 'Redacted HTTP',
        transport: {
          kind: 'http',
          lifecycle: 'external',
          request: {
            url: 'https://agent.example/invoke',
            method: 'POST',
            headers: { 'X-Opaque': headerSecret },
          },
          extraction: { result_pointer: '' },
        },
        redaction: { headers: ['x-opaque'] },
      }),
    );
    expect(
      (
        await run(root, [
          'agent',
          'import',
          'redacted-http.json',
          '--as',
          'redacted-http',
          '--output',
          'json',
        ])
      ).exitCode,
    ).toBe(0);
    const httpProbe = await run(root, ['agent', 'test', 'redacted-http', '--output', 'json']);
    expect(httpProbe.output.join('')).not.toContain(headerSecret);
    expect(httpProbe.output.join('')).toContain(REDACTED);
  });

  it('imports bounded remote JSON while rejecting redirects and authored URL query values', async () => {
    const root = await createProject();
    const resource = {
      schema: 'attest.agent/v2',
      id: 'remote-source',
      name: 'Remote',
      transport: {
        kind: 'native_cli',
        lifecycle: 'per_case',
        argv: [process.execPath, FIXTURE, 'echo'],
      },
    };
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.endsWith('/redirect')
          ? new Response(null, { status: 302 })
          : new Response(JSON.stringify(resource), { status: 200 }),
      ),
    );
    expect(
      (
        await run(root, [
          'agent',
          'import',
          'https://catalog.example/agent.json',
          '--as',
          'remote',
          '--output',
          'json',
        ])
      ).exitCode,
    ).toBe(0);
    const redirected = await run(root, [
      'agent',
      'import',
      'https://catalog.example/redirect',
      '--as',
      'redirected',
      '--output',
      'json',
    ]);
    expect(redirected.exitCode).toBe(2);
    expect(redirected.output.join('')).not.toContain('catalog.example');

    await writeFile(
      join(root, 'query.json'),
      JSON.stringify({
        ...resource,
        transport: {
          kind: 'http',
          lifecycle: 'external',
          request: {
            url: 'https://agent.example/invoke?credential=literal-value',
            method: 'POST',
          },
          extraction: { result_pointer: '' },
        },
      }),
    );
    const query = await run(root, [
      'agent',
      'import',
      'query.json',
      '--as',
      'query-agent',
      '--output',
      'json',
    ]);
    expect(query.exitCode).toBe(1);
    expect(query.output.join('')).not.toContain('literal-value');
  });

  it('rejects unsupported native policies and emits ordered redacted retry evidence', async () => {
    const root = await createProject();
    await writeFile(
      join(root, 'policy.json'),
      JSON.stringify({
        schema: 'attest.agent/v2',
        id: 'source-policy',
        name: 'Policy',
        transport: {
          kind: 'http',
          lifecycle: 'external',
          request: { url: 'https://agent.example/invoke', method: 'POST' },
          extraction: { result_pointer: '' },
        },
        timeouts: { connect_ms: 10 },
      }),
    );
    const unsupported = await run(root, [
      'agent',
      'import',
      'policy.json',
      '--as',
      'unsupported-policy',
      '--output',
      'json',
    ]);
    expect(unsupported.exitCode).toBe(1);
    expect(JSON.parse(unsupported.output[0] ?? '{}')).toMatchObject({
      error: { code: 'project_invalid', path: '/agent/timeouts/connect_ms' },
    });

    await writeFile(
      join(root, 'retry.json'),
      JSON.stringify({
        schema: 'attest.agent/v2',
        id: 'source-retry',
        name: 'Retry',
        transport: {
          kind: 'http',
          lifecycle: 'external',
          request: { url: 'https://agent.example/retry', method: 'POST' },
          extraction: { result_pointer: '' },
        },
        retry: { retries: 1, backoff: { kind: 'none' } },
      }),
    );
    expect(
      (
        await run(root, [
          'agent',
          'import',
          'retry.json',
          '--as',
          'retry-agent',
          '--output',
          'json',
        ])
      ).exitCode,
    ).toBe(0);
    let attempt = 0;
    vi.stubGlobal('fetch', () => {
      attempt += 1;
      return Promise.resolve(
        attempt === 1
          ? new Response('temporary', { status: 503 })
          : new Response(
              JSON.stringify({ protocol: 'attest.agent/v1alpha1', output: { ok: true } }),
              { status: 200 },
            ),
      );
    });
    const retried = await run(root, ['agent', 'test', 'retry-agent', '--output', 'json']);
    expect(JSON.parse(retried.output[0] ?? '{}')).toMatchObject({
      result: {
        attempt_count: 2,
        attempts: [
          { attempt: 1, invocation_code: 'http_status', status: 'invocation_error' },
          { attempt: 2, status: 'ok' },
        ],
      },
    });
  });

  it('cancels a pending guided test prompt and detects secret-file path replacement', async () => {
    const root = await createProject();
    const controller = new AbortController();
    const pending = runAgentTestCommand({
      interactive: true,
      project: root,
      prompt: () => new Promise<string>(() => undefined),
      readStdin: () => Promise.resolve(''),
      signal: controller.signal,
      workingDirectory: root,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });

    const secretPath = join(root, 'secret.txt');
    const originalPath = join(root, 'secret-original.txt');
    await writeFile(secretPath, 'trusted-secret');
    await chmod(secretPath, 0o600);
    const read = readSecretReference({ from_file: 'secret.txt' }, root, async () => {
      await rename(secretPath, originalPath);
      await writeFile(secretPath, 'foreign-secret');
      await chmod(secretPath, 0o600);
    });
    await expect(read).rejects.toMatchObject({ code: 'invocation_failed' });
  });

  it('removes command signal handlers after cancelling a guided test prompt', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    const sigintBefore = process.listeners('SIGINT');
    const sigtermBefore = process.listeners('SIGTERM');
    let markPromptStarted = (): void => undefined;
    const promptStarted = new Promise<void>((resolveStarted) => {
      markPromptStarted = resolveStarted;
    });
    const collected = collectIo();
    const pending = runCli(['agent', 'test', '--project', root], {
      interaction: {
        ci: false,
        inputIsTTY: true,
        outputIsTTY: true,
        prompt: (_question, options) =>
          new Promise<string>((_resolvePrompt, rejectPrompt) => {
            markPromptStarted();
            options?.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('Prompt aborted.');
                error.name = 'AbortError';
                rejectPrompt(error);
              },
              { once: true },
            );
          }),
        readStdin: () => Promise.resolve(''),
      },
      io: collected.io,
      workingDirectory: root,
    });
    await promptStarted;
    const commandSigintListeners = process
      .listeners('SIGINT')
      .filter((listener) => !sigintBefore.includes(listener));
    expect(commandSigintListeners).toHaveLength(1);
    commandSigintListeners[0]?.('SIGINT');
    await expect(pending).resolves.toBe(130);
    expect(collected.errors.join('\n')).toContain('cancelled: Command cancelled.');
    expect(process.listeners('SIGINT')).toEqual(sigintBefore);
    expect(process.listeners('SIGTERM')).toEqual(sigtermBefore);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('cancels a real built-CLI PTY and rejects its prompt-time mutation race', async () => {
    const root = await createProject();
    const before = await snapshotTree(root);
    // Compile this package so the PTY probe exercises the shipped Node entry point.
    await execFileAsync('bun', ['run', 'build'], { cwd: CLI_PACKAGE_ROOT, timeout: 30_000 });
    const { stderr, stdout } = await execFileAsync(
      'python3',
      [PTY_FIXTURE, 'interrupt', process.execPath, CLI_BUILT, 'agent', 'test', '--project', root],
      { timeout: 12_000 },
    );
    expect(stderr).toBe('');
    const ptyResult: unknown = JSON.parse(stdout);
    expect(isRecord(ptyResult)).toBe(true);
    if (!isRecord(ptyResult)) throw new Error('Expected structured PTY evidence.');
    expect(ptyResult.exit_code).toBe(130);
    expect(ptyResult.prompt_seen).toBe(true);
    expect(ptyResult.terminal_restored).toBe(true);
    expect(typeof ptyResult.output).toBe('string');
    if (typeof ptyResult.output !== 'string') throw new Error('Expected PTY output text.');
    expect(ptyResult.output).toContain('cancelled: Command cancelled.');
    expect(await snapshotTree(root)).toEqual(before);

    const argvJson = JSON.stringify([process.execPath, FIXTURE, 'echo']);
    const race = await execFileAsync(
      'python3',
      [PTY_FIXTURE, 'race', root, argvJson, process.execPath, CLI_BUILT],
      { timeout: 12_000 },
    );
    expect(race.stderr).toBe('');
    const raceResult: unknown = JSON.parse(race.stdout);
    expect(isRecord(raceResult)).toBe(true);
    if (!isRecord(raceResult)) throw new Error('Expected structured PTY race evidence.');
    expect(raceResult.concurrent_exit_code).toBe(0);
    expect(raceResult.exit_code).toBe(3);
    expect(raceResult.prompt_seen).toBe(true);
    expect(raceResult.terminal_restored).toBe(true);
    expect(typeof raceResult.output).toBe('string');
    if (typeof raceResult.output !== 'string') throw new Error('Expected PTY race output.');
    expect(raceResult.output).toContain('project_changed: The project changed after it was read.');
    await expect(loadProject({ project: root })).resolves.toMatchObject({
      agents: [{ id: 'racer' }],
    });
  }, 15_000);

  it('keeps recovery dry-runs byte-identical and makes watch and record explicitly opt in', async () => {
    const root = await createProject();
    const argv = JSON.stringify([process.execPath, FIXTURE, 'echo']);
    expect(
      (await run(root, ['agent', 'add', 'probe', '--argv-json', argv, '--output', 'json']))
        .exitCode,
    ).toBe(0);
    await writeFile(
      join(root, 'dry-import.json'),
      JSON.stringify({
        schema: 'attest.agent/v2',
        id: 'source',
        name: 'Dry import',
        transport: {
          kind: 'native_cli',
          lifecycle: 'per_case',
          argv: [process.execPath, FIXTURE, 'echo'],
        },
      }),
    );
    await mkdir(join(root, '.attest', 'transactions', 'prepared'), { recursive: true });
    await writeFile(join(root, '.attest', 'transactions', 'prepared', 'journal.json'), '{}');
    const before = await snapshotTree(root);
    const dryCommands = [
      ['agent', 'add', 'new-agent', '--argv-json', argv],
      ['agent', 'import', 'dry-import.json', '--as', 'imported-dry'],
      ['agent', 'rename', 'probe', 'probe-v2'],
      ['agent', 'remove', 'probe'],
    ];
    for (const command of dryCommands) {
      const dryRun = await run(root, [...command, '--dry-run', '--output', 'json']);
      expect(dryRun.exitCode).toBe(3);
      expect(JSON.parse(dryRun.output[0] ?? '{}')).toMatchObject({
        error: { code: 'project_recovery_required' },
      });
      expect(await snapshotTree(root)).toEqual(before);
    }
    await rm(join(root, '.attest', 'transactions'), { recursive: true });
    await expect(access(join(root, '.attest', 'runs.db'))).rejects.toBeDefined();

    const jsonWatch = await run(root, ['agent', 'test', 'probe', '--watch', '--output', 'json']);
    expect(jsonWatch.exitCode).toBe(2);
    expect(JSON.parse(jsonWatch.output[0] ?? '{}')).toMatchObject({
      error: { code: 'cli_usage' },
    });

    const watched = collectIo();
    expect(
      await runCli(['agent', 'test', 'probe', '--watch'], {
        interaction: {
          ci: false,
          inputIsTTY: true,
          outputIsTTY: true,
          prompt: () => Promise.reject(new Error('prompt must not be called')),
          readStdin: () => Promise.resolve(''),
        },
        io: watched.io,
        workingDirectory: root,
      }),
    ).toBe(0);
    expect(watched.errors).toEqual(['Testing agent probe...', 'Agent probe completed.']);
    await expect(access(join(root, '.attest', 'runs.db'))).rejects.toBeDefined();

    const recorded = await run(root, ['agent', 'test', 'probe', '--record', '--output', 'json']);
    expect(recorded.exitCode).toBe(0);
    const recordedDocument = JSON.parse(recorded.output[0] ?? '{}') as {
      result: { recorded_run_id: string };
    };
    const store = await openStore(join(root, '.attest', 'runs.db'));
    await expect(store.runs.getRun(recordedDocument.result.recorded_run_id)).resolves.toMatchObject(
      {
        status: 'completed',
        labels: { agent_id: 'probe', kind: 'agent-probe' },
      },
    );
    await expect(
      store.runs.getCaseResults(recordedDocument.result.recorded_run_id),
    ).resolves.toMatchObject([
      {
        caseId: 'connection-test',
        outcome: 'completed',
        request: { run_id: recordedDocument.result.recorded_run_id },
        suiteName: 'agent:probe',
      },
    ]);
    await store.close();
  }, 15_000);

  it('publishes deterministic JSON help and versioned results for every agent command', async () => {
    const root = await createProject();
    for (const command of ['add', 'import', 'test', 'rename', 'remove']) {
      const first = await run(root, ['help', 'agent', command, '--output', 'json']);
      const second = await run(root, ['help', 'agent', command, '--output', 'json']);
      expect(second.output).toEqual(first.output);
      const result = cliResultSchema.parse(JSON.parse(first.output[0] ?? '{}') as unknown);
      expect(result).toMatchObject({
        schema: 'attest.cli-result/v1',
        ok: true,
        result: { command: { request_schema: 'attest.command-request/v2' } },
      });
    }
  });
});
