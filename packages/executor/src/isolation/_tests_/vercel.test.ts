import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import { EnvironmentCleanupDiagnostics } from '../operation.js';
import { run } from '../../_tests_/support/run-effect.js';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { SANDBOX_WORKSPACE } from '../../adapters/sandbox/sandbox-paths.js';
import type { VercelSandboxFactory, VercelSandboxSdk } from '../../adapters/sandbox/types.js';
import { vercelSandboxIsolation } from '../vercel.js';
import { caseContext } from './support/case-context.js';

const asFactory = (sdk: VercelSandboxSdk): VercelSandboxFactory =>
  vi.fn(() => Promise.resolve(sdk));

describe('Vercel case isolation', () => {
  it('stops late acquisition after cancellation before handing out an environment', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled during create');
    let finish: ((sdk: VercelSandboxSdk) => void) | undefined;

    const sdk = {
      runCommand: vi.fn(() => new Promise<{ exitCode: number }>(() => undefined)),
      writeFiles: vi.fn(() => Promise.resolve()),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } satisfies VercelSandboxSdk;

    const acquisition = run(
      vercelSandboxIsolation({
        credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
        sandboxFactory: () =>
          new Promise<VercelSandboxSdk>((resolve) => {
            finish = resolve;
          }),
      })(caseContext(controller.signal)),
    );

    // Let native acquisition reach the foreign factory before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(cancelled);

    if (!finish) throw new Error('SDK creation did not start');
    finish(sdk);
    await expect(acquisition).rejects.toBe(cancelled);
    expect(sdk.runCommand).not.toHaveBeenCalled();
    expect(sdk.writeFiles).not.toHaveBeenCalled();
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('keeps relative files available through finalization and stops once', async () => {
    const controller = new AbortController();

    const sdk = {
      runCommand: vi.fn((command: { cmd: string; stdout?: NodeJS.WritableStream }) => {
        if (command.cmd === 'sh') command.stdout?.write('ok');

        return Promise.resolve({ exitCode: 0 });
      }),
      writeFiles: vi.fn(() => Promise.resolve()),
      readFile: vi.fn((file: { path: string }) =>
        Promise.resolve(Readable.from([file.path.endsWith('partial.txt') ? 'partial' : 'file'])),
      ),
      stop: vi.fn(() => Promise.resolve()),
    } satisfies VercelSandboxSdk;

    const environment = await run(
      vercelSandboxIsolation({
        files: { './inputs/../seed.txt': 'seed' },
        credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
        sandboxFactory: asFactory(sdk),
      })(caseContext(controller.signal)),
    );

    expect(await run(environment.exec('echo ok'))).toMatchObject({ stdout: 'ok', exitCode: 0 });
    controller.abort(new Error('run cancelled'));
    await run(environment.beginFinalization());
    await expect(run(environment.readFile('partial.txt'))).resolves.toBe('partial');
    await run(environment.writeFile('results/../final.txt', 'done'));
    expect(sdk.writeFiles).toHaveBeenCalledWith(
      [{ path: `${SANDBOX_WORKSPACE}/final.txt`, content: 'done' }],
      expect.any(Object),
    );

    await run(environment.dispose());
    await run(environment.dispose());
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('stops a partially prepared sandbox and rejects invalid seed paths before creation', async () => {
    const sdk = {
      runCommand: vi.fn(() => Promise.resolve({ exitCode: 0 })),
      writeFiles: vi.fn(() => Promise.reject(new Error('upload failed'))),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } satisfies VercelSandboxSdk;

    const factory = asFactory(sdk);

    await expect(
      run(
        vercelSandboxIsolation({
          files: { 'seed.txt': 'seed' },
          credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
          sandboxFactory: factory,
        })(caseContext()),
      ),
    ).rejects.toThrow('upload failed');
    expect(sdk.stop).toHaveBeenCalledOnce();

    const invalidFactory = vi.fn<VercelSandboxFactory>();
    await expect(
      run(
        vercelSandboxIsolation({
          files: { '../outside.txt': 'no' },
          credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
          sandboxFactory: invalidFactory,
        })(caseContext()),
      ),
    ).rejects.toThrow(/workspace/u);
    expect(invalidFactory).not.toHaveBeenCalled();
  });

  it('rejects a cleanup bound Node timers cannot honour before creating a VM', async () => {
    const sdk = {
      runCommand: vi.fn(() => Promise.resolve({ exitCode: 0 })),
      writeFiles: vi.fn(() => Promise.resolve()),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } satisfies VercelSandboxSdk;

    const factory = vi.fn(asFactory(sdk));

    await expect(async () =>
      run(
        vercelSandboxIsolation({
          cleanupTimeoutMs: 0.5,
          credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
          sandboxFactory: factory,
        })(caseContext()),
      ),
    ).rejects.toThrow(/cleanupTimeoutMs/u);
    expect(factory).not.toHaveBeenCalled();
  });

  it('poisons and stops an uncertain command after cancellation', async () => {
    const controller = new AbortController();
    let remoteActive = false;

    const sdk = {
      runCommand: vi.fn((command: { cmd: string; signal: AbortSignal }) => {
        if (command.cmd === 'mkdir') return Promise.resolve({ exitCode: 0 });
        remoteActive = true;

        return new Promise<{ exitCode: number }>((_resolve, reject) => {
          command.signal.addEventListener(
            'abort',
            () => reject(new Error(`SDK rejected while remote active: ${String(remoteActive)}`)),
            { once: true },
          );
        });
      }),
      writeFiles: vi.fn(() => Promise.resolve()),
      readFile: vi.fn(),
      stop: vi.fn(() => {
        remoteActive = false;

        return Promise.resolve();
      }),
    } satisfies VercelSandboxSdk;

    const environment = await run(
      vercelSandboxIsolation({
        credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
        sandboxFactory: asFactory(sdk),
      })(caseContext(controller.signal)),
    );

    const execution = run(environment.exec('long command'));
    await vi.waitFor(() => expect(remoteActive).toBe(true));
    controller.abort(new Error('cancelled'));
    await expect(execution).rejects.toThrow(/remote active/u);
    await expect(run(environment.beginFinalization())).rejects.toThrow(/remote active/u);
    await expect(run(environment.readFile('partial.txt'))).rejects.toThrow();
    await expect(run(environment.writeFile('late.txt', 'no'))).rejects.toThrow();
    await expect(run(environment.exec('late'))).rejects.toThrow();
    expect(remoteActive).toBe(false);
    expect(sdk.stop).toHaveBeenCalledOnce();
    await run(environment.dispose());
  });

  it('uses one aggregate command output budget and contains an aborted command', async () => {
    const sdk = {
      runCommand: vi.fn(
        (command: {
          cmd: string;
          signal: AbortSignal;
          stdout?: NodeJS.WritableStream;
          stderr?: NodeJS.WritableStream;
        }) => {
          if (command.cmd === 'mkdir') return Promise.resolve({ exitCode: 0 });

          return new Promise<{ exitCode: number }>((_resolve, reject) => {
            command.signal.addEventListener(
              'abort',
              () =>
                reject(
                  command.signal.reason instanceof Error
                    ? command.signal.reason
                    : new Error('command aborted'),
                ),
              { once: true },
            );
            command.stdout?.write('1234');
            command.stderr?.write('56789');
          });
        },
      ),
      writeFiles: vi.fn(() => Promise.resolve()),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } satisfies VercelSandboxSdk;

    const environment = await run(
      vercelSandboxIsolation({
        outputBytes: 8,
        credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
        sandboxFactory: asFactory(sdk),
      })(caseContext()),
    );

    await expect(run(environment.exec('produce output'))).rejects.toThrow(/outputBytes/u);
    expect(sdk.stop).toHaveBeenCalledOnce();
    await expect(run(environment.exec('late'))).rejects.toThrow();
    await run(environment.dispose());
  });

  it('rejects disposal when poisoned VM cleanup fails and blocks every later operation', async () => {
    const commandError = new Error('command rejected while remote active');

    const runCommand = vi.fn((command: { cmd: string }) =>
      command.cmd === 'mkdir' ? Promise.resolve({ exitCode: 0 }) : Promise.reject(commandError),
    );

    const sdk = {
      runCommand,
      writeFiles: vi.fn(() => Promise.resolve()),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.reject(new Error('stop failed'))),
    } satisfies VercelSandboxSdk;

    const environment = await run(
      vercelSandboxIsolation({
        credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
        sandboxFactory: asFactory(sdk),
      })(caseContext()),
    );

    const error = await run(environment.exec('uncertain')).catch((cause: unknown) => cause);
    expect(error).toBe(commandError);
    // SAFETY: The test boundary attaches the original Effect Cause to typed errors.
    const failure = error as Error & { effectCause: Cause.Cause<Error> };

    const release = Context.getOrUndefined(
      Cause.annotations(failure.effectCause),
      EnvironmentCleanupDiagnostics,
    );

    expect(release?.cause.reasons[0]).toMatchObject({
      _tag: 'Fail',
      error: { message: 'stop failed' },
    });
    const calls = runCommand.mock.calls.length;
    await expect(run(environment.exec('late'))).rejects.toThrow();
    await expect(run(environment.readFile('partial.txt'))).rejects.toThrow();
    await expect(run(environment.writeFile('late.txt', 'no'))).rejects.toThrow();
    expect(runCommand).toHaveBeenCalledTimes(calls);
    await expect(run(environment.dispose())).rejects.toMatchObject({ cleanupConfirmed: false });
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('aborts and drains active file work before stopping on disposal', async () => {
    let writes = 0;

    const sdk = {
      runCommand: vi.fn(() => Promise.resolve({ exitCode: 0 })),
      writeFiles: vi.fn(
        (_files: Parameters<VercelSandboxSdk['writeFiles']>[0], options: { signal: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            writes += 1;
            options.signal.addEventListener(
              'abort',
              () =>
                reject(
                  options.signal.reason instanceof Error
                    ? options.signal.reason
                    : new Error('write aborted'),
                ),
              { once: true },
            );
          }),
      ),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } satisfies VercelSandboxSdk;

    const environment = await run(
      vercelSandboxIsolation({
        credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
        sandboxFactory: asFactory(sdk),
      })(caseContext()),
    );

    const write = run(environment.writeFile('active.txt', 'data'));
    await vi.waitFor(() => expect(writes).toBe(1));
    await run(environment.dispose());
    await expect(write).rejects.toThrow(/disposed/u);
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it.each(['confirmed', 'unconfirmed'] as const)(
    'retains the drain timeout when stop is %s',
    async (stopOutcome) => {
      let writes = 0;

      const sdk = {
        runCommand: vi.fn(() => Promise.resolve({ exitCode: 0 })),
        writeFiles: vi.fn(() => {
          writes += 1;

          return new Promise<void>(() => undefined);
        }),
        readFile: vi.fn(),
        stop: vi.fn(() =>
          stopOutcome === 'confirmed' ? Promise.resolve() : new Promise<void>(() => undefined),
        ),
      } satisfies VercelSandboxSdk;

      const environment = await run(
        vercelSandboxIsolation({
          cleanupTimeoutMs: 5,
          credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
          sandboxFactory: asFactory(sdk),
        })(caseContext()),
      );

      void run(environment.writeFile('active.txt', 'data'));
      await vi.waitFor(() => expect(writes).toBe(1));

      const failure = await run(environment.dispose()).then(
        () => {
          throw new Error('Expected cleanup failure');
        },
        (error: Error) => {
          if (!(error instanceof AggregateError)) throw error;

          return error;
        },
      );

      expect(failure).toMatchObject({ cleanupConfirmed: false });
      expect(failure.errors).toContainEqual(
        new Error('Sandbox operations did not drain before cleanup timed out.'),
      );
      await expect(run(environment.dispose())).rejects.toBe(failure);
      expect(sdk.stop).toHaveBeenCalledOnce();
    },
  );
});
