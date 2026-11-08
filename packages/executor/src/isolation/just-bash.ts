import type { BashOptions } from 'just-bash';

import * as Effect from 'effect/Effect';
import * as Semaphore from 'effect/Semaphore';
import { foreign } from './operation.js';
import { EnvironmentOperationError } from './environment-error.js';
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
const justBashIsolation = (options: JustBashIsolationOptions = {}): CaseEnvironmentFactory =>
  Effect.fn(function* ({ signal }) {
    if (signal.aborted)
      return yield* EnvironmentOperationError.from(signal.reason, 'case_acquisition_aborted');
    // The portable build avoids Node-only global patching and exposes no host command adapters.
    const { Bash } = yield* foreign(() => import('just-bash/browser'));

    if (signal.aborted)
      return yield* EnvironmentOperationError.from(signal.reason, 'case_acquisition_aborted');

    const files = yield* Effect.try({
      try: () => resolveJustBashFiles(options.files ?? {}),
      catch: (cause) => EnvironmentOperationError.from(cause, 'seed_files_invalid'),
    });

    const shell = new Bash({
      files,
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
    const serial = yield* Semaphore.make(1);

    const enqueue = <Value>(operation: (admitted: AbortSignal) => Promise<Value>) =>
      lifecycle.track((admitted) =>
        serial.withPermits(1)(
          Effect.gen(function* () {
            const value = yield* foreign(() => {
              admitted.throwIfAborted();

              return operation(admitted);
            });

            if (admitted.aborted)
              return yield* EnvironmentOperationError.from(
                admitted.reason,
                'case_operation_aborted',
              );

            return value;
          }),
        ),
      );

    return {
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
      dispose: () =>
        Effect.uninterruptible(lifecycle.close(new Error('Case environment disposed.'))),
    };
  });

export { justBashIsolation, type JustBashIsolationOptions };
