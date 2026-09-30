import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { SANDBOX_WORKSPACE } from '../../adapters/sandbox/sandbox-paths.js';
import type { VercelSandboxFactory, VercelSandboxSdk } from '../../adapters/sandbox/types.js';
import { vercelSandboxIsolation } from '../vercel.js';
import { caseContext } from './support/case-context.js';

const asFactory = (sdk: VercelSandboxSdk): VercelSandboxFactory =>
  vi.fn(() => Promise.resolve(sdk));

describe('Vercel case isolation', () => {
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
    } as unknown as VercelSandboxSdk;
    const environment = await vercelSandboxIsolation({
      files: { './inputs/../seed.txt': 'seed' },
      credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
      sandboxFactory: asFactory(sdk),
    })(caseContext(controller.signal));

    expect(await environment.exec('echo ok')).toMatchObject({ stdout: 'ok', exitCode: 0 });
    controller.abort(new Error('run cancelled'));
    await environment.beginFinalization();
    await expect(environment.readFile('partial.txt')).resolves.toBe('partial');
    await environment.writeFile('results/../final.txt', 'done');
    expect(sdk.writeFiles).toHaveBeenCalledWith(
      [{ path: `${SANDBOX_WORKSPACE}/final.txt`, content: 'done' }],
      expect.any(Object),
    );

    await environment.dispose();
    await environment.dispose();
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('stops a partially prepared sandbox and rejects invalid seed paths before creation', async () => {
    const sdk = {
      runCommand: vi.fn(() => Promise.resolve({ exitCode: 0 })),
      writeFiles: vi.fn(() => Promise.reject(new Error('upload failed'))),
      readFile: vi.fn(),
      stop: vi.fn(() => Promise.resolve()),
    } as unknown as VercelSandboxSdk;
    const factory = asFactory(sdk);

    await expect(
      vercelSandboxIsolation({
        files: { 'seed.txt': 'seed' },
        credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
        sandboxFactory: factory,
      })(caseContext()),
    ).rejects.toThrow('upload failed');
    expect(sdk.stop).toHaveBeenCalledOnce();

    const invalidFactory = vi.fn<VercelSandboxFactory>();
    await expect(
      vercelSandboxIsolation({
        files: { '../outside.txt': 'no' },
        credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
        sandboxFactory: invalidFactory,
      })(caseContext()),
    ).rejects.toThrow(/workspace/u);
    expect(invalidFactory).not.toHaveBeenCalled();
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
    } as unknown as VercelSandboxSdk;
    const environment = await vercelSandboxIsolation({
      credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
      sandboxFactory: asFactory(sdk),
    })(caseContext(controller.signal));

    const execution = environment.exec('long command');
    await vi.waitFor(() => expect(remoteActive).toBe(true));
    controller.abort(new Error('cancelled'));
    await expect(execution).rejects.toThrow(/remote active/u);
    await expect(environment.beginFinalization()).rejects.toThrow(/remote active/u);
    expect(() => environment.readFile('partial.txt')).toThrow();
    expect(() => environment.writeFile('late.txt', 'no')).toThrow();
    expect(() => environment.exec('late')).toThrow();
    expect(remoteActive).toBe(false);
    expect(sdk.stop).toHaveBeenCalledOnce();
    await environment.dispose();
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
    } as unknown as VercelSandboxSdk;
    const environment = await vercelSandboxIsolation({
      outputBytes: 8,
      credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
      sandboxFactory: asFactory(sdk),
    })(caseContext());

    await expect(environment.exec('produce output')).rejects.toThrow(/outputBytes/u);
    expect(sdk.stop).toHaveBeenCalledOnce();
    expect(() => environment.exec('late')).toThrow();
    await environment.dispose();
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
    } as unknown as VercelSandboxSdk;
    const environment = await vercelSandboxIsolation({
      credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
      sandboxFactory: asFactory(sdk),
    })(caseContext());

    const error = await environment.exec('uncertain').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ cleanupConfirmed: false });
    expect((error as AggregateError).errors[0]).toBe(commandError);
    const calls = runCommand.mock.calls.length;
    expect(() => environment.exec('late')).toThrow();
    expect(() => environment.readFile('partial.txt')).toThrow();
    expect(() => environment.writeFile('late.txt', 'no')).toThrow();
    expect(runCommand).toHaveBeenCalledTimes(calls);
    await expect(environment.dispose()).rejects.toMatchObject({ cleanupConfirmed: false });
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('aborts and drains active file work before stopping on disposal', async () => {
    let writes = 0;
    const sdk = {
      runCommand: vi.fn(() => Promise.resolve({ exitCode: 0 })),
      writeFiles: vi.fn(
        (_files: unknown, options: { signal: AbortSignal }) =>
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
    } as unknown as VercelSandboxSdk;
    const environment = await vercelSandboxIsolation({
      credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
      sandboxFactory: asFactory(sdk),
    })(caseContext());

    const write = environment.writeFile('active.txt', 'data');
    await vi.waitFor(() => expect(writes).toBe(1));
    await environment.dispose();
    await expect(write).rejects.toThrow(/disposed/u);
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it('bounds disposal when SDK operations ignore abort and stop', async () => {
    let writes = 0;
    const sdk = {
      runCommand: vi.fn(() => Promise.resolve({ exitCode: 0 })),
      writeFiles: vi.fn(() => {
        writes += 1;
        return new Promise<void>(() => undefined);
      }),
      readFile: vi.fn(),
      stop: vi.fn(() => new Promise<void>(() => undefined)),
    } as unknown as VercelSandboxSdk;
    const environment = await vercelSandboxIsolation({
      cleanupTimeoutMs: 5,
      credentialEnv: { VERCEL_OIDC_TOKEN: 'token' },
      sandboxFactory: asFactory(sdk),
    })(caseContext());
    void environment.writeFile('active.txt', 'data');
    await vi.waitFor(() => expect(writes).toBe(1));

    await expect(environment.dispose()).rejects.toMatchObject({ cleanupConfirmed: false });
    expect(sdk.stop).toHaveBeenCalledOnce();
  });
});
