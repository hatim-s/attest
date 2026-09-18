import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeVercelSandboxAgent } from '../vercel-sandbox-adapter.js';
import type { VercelSandboxFactory, VercelSandboxInvocation, VercelSandboxSdk } from '../types.js';

const REQUEST: AgentRequest = {
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: 'case-zero',
  input: 'hello',
};
const INVOCATION: VercelSandboxInvocation = {
  argv: ['node', 'agent.mjs'],
  env: { LC_ALL: 'C' },
  attemptTimeoutMs: 1_000,
  retries: 0,
  responseBytes: 1024,
  sandboxTimeoutMs: 10_000,
};
const temporaryDirectories: string[] = [];

/** Creates one isolated host root and schedules its removal. */
const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'attest-vercel-sandbox-'));
  temporaryDirectories.push(directory);
  return directory;
};

/** Writes one complete agent envelope through the SDK-provided stdout sink. */
const writeSuccess = (stdout: NodeJS.WritableStream, output = 'ok'): void => {
  stdout.write(JSON.stringify({ protocol: AGENT_PROTOCOL, output }));
};

/** Builds the narrow SDK fake and a factory spy without loading credentials or making live calls. */
const createSdkFactory = (
  sdk: VercelSandboxSdk,
): { factory: VercelSandboxFactory; factorySpy: ReturnType<typeof vi.fn> } => {
  const factorySpy = vi.fn(() => Promise.resolve(sdk));
  return { factory: factorySpy, factorySpy };
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('Vercel sandbox lifecycle', () => {
  it('reuses one sandbox across retries, exports terminal artifacts, then stops it', async () => {
    const projectRoot = await createTemporaryDirectory();
    const artifactRoot = join(projectRoot, 'artifacts');
    const events: string[] = [];
    let invocationCount = 0;
    const sdk = {
      writeFiles: vi.fn(() => Promise.resolve()),
      runCommand: vi.fn(
        (command: { cmd: string; args: string[]; stdout?: NodeJS.WritableStream }) => {
          if (command.cmd === 'mkdir') return Promise.resolve({ exitCode: 0 });
          if (command.args[0] === '-L') return Promise.resolve({ exitCode: 1 });
          if (command.args[0] === '-f') return Promise.resolve({ exitCode: 0 });
          invocationCount += 1;
          events.push(`invoke:${String(invocationCount)}`);
          if (invocationCount === 1) return Promise.resolve({ exitCode: 1 });
          writeSuccess(command.stdout!, 'retried');
          return Promise.resolve({ exitCode: 0 });
        },
      ),
      readFile: vi.fn(() => {
        events.push('artifact');
        return Promise.resolve(Readable.from(['artifact-body']));
      }),
      stop: vi.fn(() => {
        events.push('stop');
        return Promise.resolve();
      }),
    } as unknown as VercelSandboxSdk;
    const { factory, factorySpy } = createSdkFactory(sdk);

    const result = await invokeVercelSandboxAgent(
      {
        kind: 'vercel',
        files: [],
        artifacts: [{ source: 'result.txt', destination: 'case/result.txt' }],
      },
      { ...INVOCATION, retries: 1 },
      REQUEST,
      {
        projectRoot,
        artifactRoot,
        credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
        sandboxFactory: factory,
      },
    );

    expect(factorySpy).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'ok',
      attempts: [{ status: 'invocation_error' }, { status: 'ok' }],
    });
    expect(events).toEqual(['invoke:1', 'invoke:2', 'artifact', 'stop']);
    expect(sdk.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: 'sh',
        args: [
          '-c',
          'exec "$@" < "$0"',
          '/vercel/sandbox/.attest/request.json',
          'node',
          'agent.mjs',
        ],
      }),
    );
    await expect(readFile(join(artifactRoot, 'case/result.txt'), 'utf8')).resolves.toBe(
      'artifact-body',
    );
  });

  it('stops a created sandbox when setup fails', async () => {
    const projectRoot = await createTemporaryDirectory();
    await writeFile(join(projectRoot, 'agent.mjs'), 'export {};');
    const sdk = {
      writeFiles: vi.fn(() => Promise.reject(new Error('upload failed'))),
      runCommand: vi.fn(() => Promise.resolve({ exitCode: 0 })),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } as unknown as VercelSandboxSdk;
    const { factory } = createSdkFactory(sdk);

    const result = await invokeVercelSandboxAgent(
      {
        kind: 'vercel',
        files: [{ source: 'agent.mjs', destination: 'agent.mjs' }],
        artifacts: [],
      },
      INVOCATION,
      REQUEST,
      {
        projectRoot,
        credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
        sandboxFactory: factory,
      },
    );

    expect(result).toMatchObject({ status: 'invocation_error', error: { code: 'spawn_failed' } });
    expect(sdk.runCommand).toHaveBeenCalledOnce();
    expect(sdk.runCommand).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'mkdir' }));
    expect(sdk.writeFiles).toHaveBeenCalledOnce();
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('rejects missing credentials before creating a sandbox', async () => {
    const projectRoot = await createTemporaryDirectory();
    const factory = vi.fn<VercelSandboxFactory>();

    await expect(
      invokeVercelSandboxAgent({ kind: 'vercel', files: [], artifacts: [] }, INVOCATION, REQUEST, {
        projectRoot,
        credentialEnv: {},
        sandboxFactory: factory,
      }),
    ).rejects.toMatchObject({ code: 'spawn_failed' });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    {
      attemptTimeoutMs: 1_000,
      name: 'cancellation',
      terminal: 'cancelled' as const,
      responseBytes: 1024,
    },
    { attemptTimeoutMs: 25, name: 'timeout', terminal: 'timeout' as const, responseBytes: 1024 },
    {
      attemptTimeoutMs: 1_000,
      name: 'output cap',
      terminal: 'output_cap_exceeded' as const,
      responseBytes: 256,
    },
  ])(
    'settles $name before allowing retries or another remote command',
    async ({ attemptTimeoutMs, terminal, responseBytes }) => {
      const projectRoot = await createTemporaryDirectory();
      const controller = new AbortController();
      let activeCommands = 0;
      let maximumActiveCommands = 0;
      const sdk = {
        writeFiles: vi.fn(() => Promise.resolve()),
        runCommand: vi.fn(
          (command: { cmd: string; signal: AbortSignal; stdout?: NodeJS.WritableStream }) =>
            new Promise<{ exitCode: number }>((_resolve, reject) => {
              if (command.cmd === 'mkdir') {
                _resolve({ exitCode: 0 });
                return;
              }
              activeCommands += 1;
              maximumActiveCommands = Math.max(maximumActiveCommands, activeCommands);
              command.signal.addEventListener(
                'abort',
                () => {
                  activeCommands -= 1;
                  reject(
                    command.signal.reason instanceof Error
                      ? command.signal.reason
                      : new Error('aborted'),
                  );
                },
                { once: true },
              );
              if (terminal === 'output_cap_exceeded') {
                command.stdout!.write('x'.repeat(512));
                activeCommands -= 1;
                _resolve({ exitCode: 0 });
              }
              if (terminal === 'cancelled') controller.abort(new Error('cancelled'));
            }),
        ),
        readFile: vi.fn(),
        stop: vi.fn(() => Promise.resolve()),
      } as unknown as VercelSandboxSdk;
      const { factory } = createSdkFactory(sdk);

      const result = await invokeVercelSandboxAgent(
        { kind: 'vercel', files: [], artifacts: [] },
        { ...INVOCATION, attemptTimeoutMs, responseBytes, retries: 2 },
        REQUEST,
        {
          projectRoot,
          ...(terminal === 'cancelled' ? { signal: controller.signal } : {}),
          credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
          sandboxFactory: factory,
        },
      );

      expect(result).toMatchObject({ status: 'invocation_error', error: { code: terminal } });
      const expectedAttempts = terminal === 'output_cap_exceeded' ? 3 : 1;
      expect(sdk.runCommand).toHaveBeenCalledTimes(1 + expectedAttempts);
      expect(maximumActiveCommands).toBe(1);
      expect(activeCommands).toBe(0);
    },
  );

  it('surfaces stop failure and marks sandbox cleanup as unconfirmed', async () => {
    const projectRoot = await createTemporaryDirectory();
    const sdk = {
      writeFiles: vi.fn(() => Promise.resolve()),
      runCommand: vi.fn((command: { cmd: string; stdout?: NodeJS.WritableStream }) => {
        if (command.cmd === 'mkdir') return Promise.resolve({ exitCode: 0 });
        writeSuccess(command.stdout!);
        return Promise.resolve({ exitCode: 0 });
      }),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.reject(new Error('stop failed'))),
    } as unknown as VercelSandboxSdk;
    const { factory } = createSdkFactory(sdk);

    const result = await invokeVercelSandboxAgent(
      { kind: 'vercel', files: [], artifacts: [] },
      INVOCATION,
      REQUEST,
      {
        projectRoot,
        credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
        sandboxFactory: factory,
      },
    );

    expect(result).toMatchObject({
      status: 'invocation_error',
      diagnostics: { sandboxCleanupConfirmed: false },
    });
  });

  it.each([
    { durationMs: 1_000, expected: 'timeout' },
    { durationMs: 999, expected: 'nonzero_exit' },
  ])('classifies exit 137 from its SDK duration ($expected)', async ({ durationMs, expected }) => {
    const projectRoot = await createTemporaryDirectory();
    const sdk = {
      writeFiles: vi.fn(() => Promise.resolve()),
      runCommand: vi.fn((command: { cmd: string }) =>
        Promise.resolve(command.cmd === 'mkdir' ? { exitCode: 0 } : { exitCode: 137, durationMs }),
      ),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } as unknown as VercelSandboxSdk;
    const { factory } = createSdkFactory(sdk);

    const result = await invokeVercelSandboxAgent(
      { kind: 'vercel', files: [], artifacts: [] },
      INVOCATION,
      REQUEST,
      {
        projectRoot,
        credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
        sandboxFactory: factory,
      },
    );

    expect(result).toMatchObject({ status: 'invocation_error', error: { code: expected } });
  });
});
