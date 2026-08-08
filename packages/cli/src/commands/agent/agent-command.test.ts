import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliResultSchema } from '@attest/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadProject } from '../../project/load-project.js';
import { runCli, type CliIo } from '../../run-cli.js';
import { runAgentAddCommand, runAgentTestCommand } from './agent-command.js';
import { REDACTED } from './native-agent-adapter.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/native-agent.cjs', import.meta.url));
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
              question.startsWith('Agent id')
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
    expect(questions).toEqual(['Agent id: ', 'Transport [cli/http]: ', 'Native command: ']);

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
        response: { output: { argv: [hostileArgument, '$(false)'], input: { ping: true } } },
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
    expect(
      (await run(root, ['agent', 'remove', 'support-v2', '--detach', '--output', 'json'])).exitCode,
    ).toBe(0);
    await expect(loadProject({ project: root })).resolves.toMatchObject({ agents: [], tests: [] });
  });

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
