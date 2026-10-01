import type { BashOptions } from 'just-bash';

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
    const runLifetime = new AbortController();
    const finalizationLifetime = new AbortController();
    const pending = new Set<Promise<unknown>>();
    let phase: 'run' | 'transitioning' | 'finalizing' | 'disposed' = 'run';
    let finalizationSignal: AbortSignal | undefined;
    let transition: Promise<void> | undefined;
    let disposal: Promise<void> | undefined;
    const admissionSignal = (): AbortSignal => {
      if (phase === 'disposed') throw new Error('Case environment has been disposed.');
      if (phase === 'transitioning') {
        throw new Error('Case environment finalization is starting.');
      }
      const admitted =
        phase === 'run' ? AbortSignal.any([signal, runLifetime.signal]) : finalizationSignal!;
      admitted.throwIfAborted();
      return admitted;
    };
    // just-bash owns mutable interpreter state. Serialize tool calls within a case while allowing
    // separate case environments to execute concurrently.
    let tail = Promise.resolve();
    const enqueue = <Value>(
      operation: (admitted: AbortSignal) => Promise<Value>,
    ): Promise<Value> => {
      const admitted = admissionSignal();
      const task = tail.then(() => {
        admitted.throwIfAborted();
        return operation(admitted);
      });
      tail = task.then(
        () => undefined,
        () => undefined,
      );
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    };
    /** Switches from the cancelled run signal to a separate deadline for final hooks. */
    const beginFinalization = (): Promise<void> => {
      if (phase === 'disposed')
        return Promise.reject(new Error('Case environment has been disposed.'));
      transition ??= (async () => {
        phase = 'transitioning';
        runLifetime.abort(new Error('Case run operations cancelled for finalization.'));
        await Promise.allSettled([...pending]);
        if ((phase as string) === 'disposed') {
          throw new Error('Case environment has been disposed.');
        }
        finalizationSignal = AbortSignal.any([
          finalizationLifetime.signal,
          AbortSignal.timeout(options.finalizationTimeoutMs ?? options.timeoutMs ?? 60_000),
        ]);
        phase = 'finalizing';
      })();
      return transition;
    };
    /** Aborts both phases and waits for every operation admitted before disposal. */
    const dispose = (): Promise<void> => {
      disposal ??= (async () => {
        phase = 'disposed';
        runLifetime.abort(new Error('Case environment disposed.'));
        finalizationLifetime.abort(new Error('Case environment disposed.'));
        await Promise.allSettled([...pending]);
      })();
      return disposal;
    };
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
      beginFinalization,
      dispose,
    };
  };

export { justBashIsolation, type JustBashIsolationOptions };
