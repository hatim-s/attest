import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import {
  EnvironmentCleanupDiagnostics,
  EnvironmentCleanupError,
} from '../../../isolation/operation.js';
import { run } from '../../../_tests_/support/run-effect.js';
import { AgentInvocationError } from '../../../errors.js';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { AGENT_PROTOCOL, type AgentRequest } from '@attest/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeVercelSandboxAgent } from '../vercel-sandbox-adapter.js';
import type {
  VercelSandboxCaseOptions,
  VercelSandboxFactory,
  VercelSandboxInvocation,
  VercelSandboxSdk,
} from '../types.js';

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

/** Builds a factory spy for the narrow SDK fake without loading credentials or making live calls. */
const createSdkFactory = (sdk: VercelSandboxSdk) =>
  vi.fn<VercelSandboxFactory>(() => Promise.resolve(sdk));

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('Vercel sandbox lifecycle', () => {
  it('retains upload descriptor cleanup failure before invoking the agent', async () => {
    const projectRoot = await createTemporaryDirectory();
    const source = join(projectRoot, 'input.txt');
    await writeFile(source, 'input');
    const sample = await open(source, 'r');
    // SAFETY: This is the prototype of a real FileHandle; only its stat method is intercepted.
    const prototype = Object.getPrototypeOf(sample) as FileHandle;
    await sample.close();
    const releases: (() => Promise<void>)[] = [];
    const closeFailure = new Error('Upload descriptor close failed.');

    const reading = vi.spyOn(prototype, 'stat').mockImplementationOnce(function (
      this: FileHandle,
      options,
    ) {
      reading.mockRestore();
      const close = this.close.bind(this);
      releases.push(close);
      this.close = () => Promise.reject(closeFailure);

      return this.stat(options);
    });

    const sdk = {
      runCommand: vi.fn(() => Promise.resolve({ exitCode: 0 })),
      writeFiles: vi.fn(() => Promise.resolve()),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } satisfies VercelSandboxSdk;

    try {
      const result = await run(
        invokeVercelSandboxAgent(
          { kind: 'vercel', files: [{ source: 'input.txt', destination: 'input.txt' }] },
          INVOCATION,
          REQUEST,
          {
            projectRoot,
            credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
            sandboxFactory: createSdkFactory(sdk),
          },
        ),
      );

      expect(result).toMatchObject({
        status: 'invocation_error',
        error: { code: 'spawn_failed' },
        diagnostics: { sandboxError: 'Vercel sandbox setup failed' },
      });

      if (result.status !== 'invocation_error') throw new Error('Expected setup failure');
      const error = result.error.cause;
      expect(error).toBeInstanceOf(EnvironmentCleanupError);

      if (!(error instanceof EnvironmentCleanupError)) throw new Error('Expected cleanup evidence');
      expect(error.cleanupCause.reasons.find(Cause.isFailReason)?.error).toBe(closeFailure);
      expect(sdk.runCommand).not.toHaveBeenCalled();
      expect(sdk.writeFiles).not.toHaveBeenCalled();
      expect(sdk.stop).toHaveBeenCalledOnce();
    } finally {
      reading.mockRestore();

      for (const release of releases) await release();
    }
  });
  it.each([
    ['completed', false],
    ['completed', true],
    ['failed', false],
    ['failed', true],
  ] as const)(
    'retains artifact cleanup after an agent %s and stop failure=%s',
    async (outcome, stopFails) => {
      const projectRoot = await createTemporaryDirectory();
      const destroyFailure = new Error('Artifact stream destruction failed.');
      const stopFailure = new Error('VM stop failed.');
      const stream = Readable.from([Buffer.alloc(2048)], { autoDestroy: false });

      const destruction = vi.spyOn(stream, 'destroy').mockImplementation(() => {
        throw destroyFailure;
      });

      const sdk = {
        runCommand: vi.fn(
          (command: { cmd: string; args: string[]; stdout?: NodeJS.WritableStream }) => {
            if (command.cmd === 'test')
              return Promise.resolve({ exitCode: command.args[0] === '-L' ? 1 : 0 });

            if (command.cmd === 'mkdir') return Promise.resolve({ exitCode: 0 });

            if (command.stdout && outcome === 'completed') writeSuccess(command.stdout);

            return Promise.resolve({ exitCode: outcome === 'completed' ? 0 : 1 });
          },
        ),
        writeFiles: vi.fn(() => Promise.resolve()),
        readFile: vi.fn(() => Promise.resolve(stream)),
        stop: vi.fn(() => (stopFails ? Promise.reject(stopFailure) : Promise.resolve())),
      } satisfies VercelSandboxSdk;

      try {
        const result = await run(
          invokeVercelSandboxAgent(
            {
              kind: 'vercel',
              files: [],
              artifacts: [{ source: 'result.txt', destination: 'result.txt' }],
            },
            INVOCATION,
            REQUEST,
            {
              projectRoot,
              artifactRoot: join(projectRoot, 'out'),
              credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
              sandboxFactory: createSdkFactory(sdk),
            },
          ),
        );

        if (result.status !== 'invocation_error')
          throw new Error('Expected retained terminal failure.');
        expect(result.error.code).toBe(
          outcome === 'completed' ? 'output_cap_exceeded' : 'nonzero_exit',
        );

        const artifactError: unknown =
          outcome === 'completed'
            ? result.error
            : Object.getOwnPropertyDescriptor(result.error, 'sandboxPostRunError')?.value;

        expect(artifactError).toBeInstanceOf(AgentInvocationError);

        if (!(artifactError instanceof AgentInvocationError))
          throw new Error('Expected artifact failure.');
        expect(artifactError.code).toBe('output_cap_exceeded');
        const cause: unknown = Object.getOwnPropertyDescriptor(artifactError, 'effectCause')?.value;

        if (!Cause.isCause(cause)) throw new Error('Artifact failure lost its Cause.');

        const cleanup = Context.getOrUndefined(
          Cause.annotations(cause),
          EnvironmentCleanupDiagnostics,
        );

        expect(cleanup?.cause.reasons.find(Cause.isDieReason)?.defect).toBe(destroyFailure);

        if (stopFails) {
          const stopped: unknown = Object.getOwnPropertyDescriptor(
            result.error,
            'sandboxCleanupCause',
          )?.value;

          if (!Cause.isCause(stopped)) throw new Error('VM cleanup lost its Cause.');
          expect(stopped.reasons.find(Cause.isFailReason)?.error).toBe(stopFailure);
          expect(result.diagnostics.sandboxCleanupConfirmed).toBe(false);
        }

        expect(sdk.stop).toHaveBeenCalledOnce();
        expect(destruction).toHaveBeenCalledOnce();
        expect(JSON.stringify(result)).not.toContain(destroyFailure.message);
      } finally {
        destruction.mockRestore();
        stream.destroy();
      }
    },
  );

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
    } satisfies VercelSandboxSdk;

    const factory = createSdkFactory(sdk);

    const result = await run(
      invokeVercelSandboxAgent(
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
      ),
    );

    expect(factory).toHaveBeenCalledOnce();
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
    } satisfies VercelSandboxSdk;

    const factory = createSdkFactory(sdk);

    const result = await run(
      invokeVercelSandboxAgent(
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
      ),
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
      run(
        invokeVercelSandboxAgent(
          { kind: 'vercel', files: [], artifacts: [] },
          INVOCATION,
          REQUEST,
          {
            projectRoot,
            credentialEnv: {},
            sandboxFactory: factory,
          },
        ),
      ),
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
      } satisfies VercelSandboxSdk;

      const factory = createSdkFactory(sdk);

      const options: VercelSandboxCaseOptions = {
        projectRoot,
        credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
        sandboxFactory: factory,
      };

      if (terminal === 'cancelled') options.signal = controller.signal;

      const result = await run(
        invokeVercelSandboxAgent(
          { kind: 'vercel', files: [], artifacts: [] },
          { ...INVOCATION, attemptTimeoutMs, responseBytes, retries: 2 },
          REQUEST,
          options,
        ),
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
    } satisfies VercelSandboxSdk;

    const factory = createSdkFactory(sdk);

    const result = await run(
      invokeVercelSandboxAgent({ kind: 'vercel', files: [], artifacts: [] }, INVOCATION, REQUEST, {
        projectRoot,
        credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
        sandboxFactory: factory,
      }),
    );

    expect(result).toMatchObject({
      status: 'invocation_error',
      diagnostics: { sandboxCleanupConfirmed: false },
      attempts: [{ status: 'ok' }, { status: 'invocation_error' }],
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
    } satisfies VercelSandboxSdk;

    const factory = createSdkFactory(sdk);

    const result = await run(
      invokeVercelSandboxAgent({ kind: 'vercel', files: [], artifacts: [] }, INVOCATION, REQUEST, {
        projectRoot,
        credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
        sandboxFactory: factory,
      }),
    );

    expect(result).toMatchObject({ status: 'invocation_error', error: { code: expected } });
  });

  it('retains capped stdout hash and stderr when remote completion is unconfirmed', async () => {
    const projectRoot = await createTemporaryDirectory();
    const output = 'x'.repeat(512);

    const sdk = {
      writeFiles: vi.fn(() => Promise.resolve()),
      runCommand: vi.fn(
        (command: {
          cmd: string;
          stdout?: NodeJS.WritableStream;
          stderr?: NodeJS.WritableStream;
        }) => {
          if (command.cmd === 'mkdir') return Promise.resolve({ exitCode: 0 });
          command.stdout!.write(output);
          command.stderr!.write('remote command diagnostic');

          return Promise.reject(new Error('lost acknowledgement'));
        },
      ),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } satisfies VercelSandboxSdk;

    const result = await run(
      invokeVercelSandboxAgent(
        { kind: 'vercel', files: [], artifacts: [] },
        { ...INVOCATION, responseBytes: 256, retries: 2 },
        REQUEST,
        {
          projectRoot,
          credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
          sandboxFactory: createSdkFactory(sdk),
        },
      ),
    );

    expect(result).toMatchObject({
      status: 'invocation_error',
      error: { code: 'output_cap_exceeded' },
      diagnostics: {
        sandboxCompletionConfirmed: false,
        stderrExcerpt: 'remote command diagnostic',
      },
      rawExcerpt: {
        text: 'x'.repeat(256),
        truncated: true,
        sha256: createHash('sha256').update(output).digest('hex'),
      },
    });
    expect(result.attempts).toHaveLength(1);
    expect(sdk.runCommand).toHaveBeenCalledTimes(2);
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('gives caller cancellation precedence over a confirmed cap breach', async () => {
    const projectRoot = await createTemporaryDirectory();
    const controller = new AbortController();

    const sdk = {
      writeFiles: vi.fn(() => Promise.resolve()),
      runCommand: vi.fn((command: { cmd: string; stdout?: NodeJS.WritableStream }) => {
        if (command.cmd === 'mkdir') return Promise.resolve({ exitCode: 0 });
        command.stdout!.write('x'.repeat(512));
        controller.abort();

        return Promise.resolve({ exitCode: 0 });
      }),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } satisfies VercelSandboxSdk;

    const result = await run(
      invokeVercelSandboxAgent(
        { kind: 'vercel', files: [], artifacts: [] },
        { ...INVOCATION, responseBytes: 256, retries: 2 },
        REQUEST,
        {
          projectRoot,
          signal: controller.signal,
          credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
          sandboxFactory: createSdkFactory(sdk),
        },
      ),
    );

    expect(result).toMatchObject({ status: 'invocation_error', error: { code: 'cancelled' } });
    expect(result.attempts).toHaveLength(1);
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('preserves a native defect through the S5 edge and still joins sandbox stop', async () => {
    const projectRoot = await createTemporaryDirectory();
    const defect = new Error('request serialization invariant');
    const cleanup = new Error('sandbox stop acknowledgement lost');
    const request = { ...REQUEST };
    Object.defineProperty(request, 'input', {
      enumerable: true,
      get: () => {
        throw defect;
      },
    });

    const sdk = {
      writeFiles: vi.fn(() => Promise.resolve()),
      runCommand: vi.fn(() => Promise.resolve({ exitCode: 0 })),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.reject(cleanup)),
    } satisfies VercelSandboxSdk;

    const invocation = run(
      invokeVercelSandboxAgent(
        { kind: 'vercel', files: [], artifacts: [] },
        { ...INVOCATION, retries: 2 },
        request,
        {
          projectRoot,
          credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
          sandboxFactory: createSdkFactory(sdk),
        },
      ),
    );

    await expect(invocation).rejects.toHaveProperty('effectCause.reasons.0.defect', defect);
    const failure = await invocation.catch((error: { effectCause: Cause.Cause<Error> }) => error);

    if (!('effectCause' in failure)) throw new Error('Expected a native failure Cause');

    const release = Context.getOrUndefined(
      Cause.annotations(failure.effectCause),
      EnvironmentCleanupDiagnostics,
    );

    expect(release?.cause.reasons[0]).toMatchObject({ _tag: 'Fail', error: cleanup });
    expect(sdk.writeFiles).not.toHaveBeenCalled();
    expect(sdk.runCommand).toHaveBeenCalledOnce();
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('retains successful evidence when native listener release defects', async () => {
    const projectRoot = await createTemporaryDirectory();
    const controller = new AbortController();
    const defect = new Error('listener release failed');
    Object.defineProperty(controller.signal, 'removeEventListener', {
      value: () => {
        throw defect;
      },
    });

    const sdk = {
      writeFiles: vi.fn(() => Promise.resolve()),
      runCommand: vi.fn((command: { cmd: string; stdout?: NodeJS.WritableStream }) => {
        if (command.cmd !== 'mkdir') writeSuccess(command.stdout!);

        return Promise.resolve({ exitCode: 0 });
      }),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } satisfies VercelSandboxSdk;

    const invocation = run(
      invokeVercelSandboxAgent(
        { kind: 'vercel', files: [], artifacts: [] },
        { ...INVOCATION, retries: 2 },
        REQUEST,
        {
          projectRoot,
          signal: controller.signal,
          credentialEnv: { VERCEL_OIDC_TOKEN: 'test-token' },
          sandboxFactory: createSdkFactory(sdk),
        },
      ),
    );

    await expect(invocation).rejects.toMatchObject({
      _tag: 'SandboxAttemptCleanupError',
      attempt: { status: 'ok' },
    });
    await expect(invocation).rejects.toHaveProperty('cleanupCause.reasons.0.defect', defect);
    expect(sdk.runCommand).toHaveBeenCalledTimes(2);
    expect(sdk.stop).toHaveBeenCalledOnce();
  });
});
