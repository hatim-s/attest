import type { BashOptions } from 'just-bash';

import { createSerialQueue } from '../internal/serial-queue.js';
import { createEnvironmentLifecycle } from './environment-lifecycle.js';
import type { CaseEnvironmentFactory } from './types.js';
import {
  JUST_BASH_WORKSPACE,
  resolveJustBashFiles,
  resolveJustBashPath,
} from './workspace-path.js';

type JustBashIsolationOptions = {
  files?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  finalizationTimeoutMs?: number;
  outputBytes?: number;
  filesystemBytes?: number;
  executionLimits?: BashOptions['executionLimits'];
};

/** Creates a fresh virtual filesystem per case without host files, network, or custom host commands. */
const justBashIsolation =
  (options: JustBashIsolationOptions = {}): CaseEnvironmentFactory =>
  async ({ signal }) => {
    signal.throwIfAborted();
    // The portable build avoids Node-only global patching and exposes no host command adapters.
    const { Bash } = await import('just-bash/browser');
    signal.throwIfAborted();
    const shell = new Bash({
      files: resolveJustBashFiles(options.files ?? {}),
      env: { ...options.env },
      cwd: options.cwd ?? JUST_BASH_WORKSPACE,
      executionLimitProfile: 'hardened',
      executionLimits: {
        ...options.executionLimits,
        maxExecutionTimeMs: options.timeoutMs ?? 60_000,
        maxOutputSize: options.outputBytes ?? 1024 * 1024,
        maxFileSystemBytes: options.filesystemBytes ?? 16 * 1024 * 1024,
      },
    });
    const lifecycle = createEnvironmentLifecycle({
      signal,
      finalizationTimeoutMs: options.finalizationTimeoutMs ?? options.timeoutMs ?? 60_000,
    });
    // just-bash owns mutable interpreter state. Serialize tool calls within a case while allowing
    // separate case environments to execute concurrently.
    const runSerially = createSerialQueue();
    const enqueue = <Value>(operation: (admitted: AbortSignal) => Promise<Value>): Promise<Value> =>
      lifecycle.track((admitted) =>
        runSerially(() => {
          admitted.throwIfAborted();
          return operation(admitted);
        }),
      );
    let disposal: Promise<void> | undefined;
    return {
      kind: 'just-bash',
      exec: (script, execution = {}) =>
        enqueue((admitted) =>
          shell.exec(script, {
            env: execution.env,
            signal: AbortSignal.any([admitted, ...(execution.signal ? [execution.signal] : [])]),
          }),
        ),
      readFile: (path) => enqueue(() => shell.readFile(resolveJustBashPath(path))),
      writeFile: (path, contents) =>
        enqueue(() => shell.writeFile(resolveJustBashPath(path), contents)),
      beginFinalization: lifecycle.beginFinalization,
      dispose: () => {
        disposal ??= lifecycle.close(new Error('Case environment disposed.'));
        return disposal;
      },
    };
  };

export { justBashIsolation, type JustBashIsolationOptions };
