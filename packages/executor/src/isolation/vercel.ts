import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Semaphore from 'effect/Semaphore';
import { foreign, withRelease, ownOperation } from './operation.js';
import { parseWithSchemaSync } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import * as Effect from 'effect/Effect';

import { BoundedOutputWritable } from '../adapters/sandbox/bounded-writable.js';
import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  createCaseSandbox,
  stopCaseSandbox,
} from '../adapters/sandbox/case-sandbox.js';
import { resolveVercelSandboxCredentials } from '../adapters/sandbox/credentials.js';
import { SANDBOX_WORKSPACE, resolveRemotePath } from '../adapters/sandbox/sandbox-paths.js';
import { readRemoteFile } from '../adapters/sandbox/sandbox-transfer.js';
import type { VercelSandboxFactory } from '../adapters/sandbox/types.js';
import { createEnvironmentLifecycle } from './environment-lifecycle.js';
import { EnvironmentOperationError } from './environment-error.js';
import type { CaseEnvironment, CaseEnvironmentFactory } from './types.js';
import { normalizeWorkspacePath } from './workspace-path.js';

/**
 * Node's timers and `AbortSignal.timeout` throw on fractions and overflow past 2^31 - 1 ms. A
 * cleanup bound that throws after creation would leave the VM running, so every bound is checked
 * here before a VM exists.
 */
const timerMsSchema = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(2_147_483_647),
);

/** Validates serializable controls before allocating a VM. */
const vercelIsolationOptionsSchema = Schema.Struct({
  image: Schema.optional(Schema.String),
  timeoutMs: timerMsSchema.pipe(Schema.withDecodingDefault(Effect.succeed(600_000))),
  commandTimeoutMs: timerMsSchema.pipe(Schema.withDecodingDefault(Effect.succeed(60_000))),
  finalizationTimeoutMs: Schema.optional(timerMsSchema),
  cleanupTimeoutMs: timerMsSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CLEANUP_TIMEOUT_MS)),
  ),
  outputBytes: Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(1024 * 1024)),
  ),
  files: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** Programmatic dependencies are already typed; only data controls need decoding. */
type VercelIsolationOptions = typeof vercelIsolationOptionsSchema.Encoded & {
  sandboxFactory?: VercelSandboxFactory;
  credentialEnv?: NodeJS.ProcessEnv;
};

/**
 * A VM that could not be confirmed stopped. Runtime reads `cleanupConfirmed` to stop reusing the
 * case worker, since the remote command may still be running.
 */
class SandboxCleanupError extends AggregateError {
  readonly cleanupConfirmed = false;
}

/** Resolves seed files before creating a VM so invalid paths cannot leave remote state behind. */
const resolveSeedFiles = (
  files: Readonly<Record<string, string>>,
  cap: number,
): { path: string; content: string }[] => {
  const resolved: { path: string; content: string }[] = [];
  const destinations = new Set<string>();
  let bytes = 0;

  for (const [path, content] of Object.entries(files)) {
    const destination = resolveRemotePath(normalizeWorkspacePath(path, 'Seed file path'));

    if (destinations.has(destination)) throw new TypeError(`Duplicate seed file path: ${path}`);
    destinations.add(destination);
    bytes += Buffer.byteLength(content);

    if (bytes > cap) throw new Error('Initial sandbox files exceed outputBytes.');
    resolved.push({ path: destination, content });
  }

  return resolved;
};

/** Keeps a fresh VM alive across case hooks, agent tools, evaluation, and bounded final hooks. */
const vercelSandboxIsolation = (input: VercelIsolationOptions = {}): CaseEnvironmentFactory => {
  const { sandboxFactory, credentialEnv, ...controls } = input;
  const options = parseWithSchemaSync(vercelIsolationOptionsSchema, controls);
  const { commandTimeoutMs, cleanupTimeoutMs, outputBytes: cap } = options;
  const finalizationTimeoutMs = options.finalizationTimeoutMs ?? commandTimeoutMs;

  return Effect.fn(function* ({ signal }) {
    if (signal.aborted)
      return yield* EnvironmentOperationError.from(signal.reason, 'case_acquisition_aborted');

    const credentials = yield* Effect.try({
      try: () => resolveVercelSandboxCredentials(credentialEnv ?? process.env),
      catch: (cause) => EnvironmentOperationError.from(cause, 'sandbox_credentials_failed'),
    });

    const files = yield* Effect.try({
      try: () => resolveSeedFiles(options.files, cap),
      catch: (cause) => EnvironmentOperationError.from(cause, 'sandbox_seed_failed'),
    });

    return yield* ownOperation((cancelled) =>
      Effect.gen(function* () {
        signal = AbortSignal.any([signal, cancelled]);

        const sdk = yield* createCaseSandbox({
          credentials,
          factory: sandboxFactory,
          image: options.image,
          timeoutMs: options.timeoutMs,
          signal: AbortSignal.any([signal, AbortSignal.timeout(commandTimeoutMs)]),
        });

        let poisonReason: EnvironmentOperationError | SandboxCleanupError | undefined;

        const lifecycle = createEnvironmentLifecycle({
          signal,
          finalizationTimeoutMs,
          poisonedError: () => poisonReason,
        });

        const stopLock = yield* Semaphore.make(1);
        let stopped: Exit.Exit<void, EnvironmentOperationError> | undefined;

        /** Every caller observes the same stop receipt, including failed confirmation. */
        const stop = () =>
          stopLock.withPermits(1)(
            Effect.gen(function* () {
              stopped ??= yield* Effect.exit(stopCaseSandbox(sdk, cleanupTimeoutMs));

              return yield* stopped;
            }),
          );

        /** A rejected command cannot be retried or reused until the VM has been stopped. */
        const poison = (error: EnvironmentOperationError) => {
          poisonReason ??= error;
          lifecycle.poison(error);

          return withRelease(Effect.fail(error), stop()).pipe(
            Effect.catchCause((cause) => {
              // Keep the original Cause, including any attached cleanup diagnostic.
              if (stopped && Exit.isFailure(stopped))
                poisonReason = new SandboxCleanupError(
                  [error, stopped.cause],
                  'Sandbox operation and cleanup failed.',
                );

              return Effect.failCause(cause);
            }),
          );
        };

        const operationSignal = (admitted: AbortSignal, extra?: AbortSignal) =>
          AbortSignal.any([
            admitted,
            AbortSignal.timeout(commandTimeoutMs),
            ...(extra ? [extra] : []),
          ]);

        // A factory may finish after cancellation. Release its VM before starting any setup work.
        if (signal.aborted)
          return yield* withRelease(
            Effect.fail(
              EnvironmentOperationError.from(signal.reason, 'sandbox_acquisition_aborted'),
            ),
            stop(),
          );

        const setup = yield* Effect.exit(
          Effect.gen(function* () {
            const setupSignal = operationSignal(signal);

            const ready = yield* foreign((foreignSignal) =>
              sdk.runCommand({
                cmd: 'mkdir',
                args: ['-p', SANDBOX_WORKSPACE],
                signal: AbortSignal.any([foreignSignal, setupSignal]),
                timeoutMs: commandTimeoutMs,
              }),
            );

            if (ready.exitCode !== 0)
              return yield* new EnvironmentOperationError({ reason: 'sandbox_prepare_failed' });

            if (files.length > 0)
              yield* foreign((foreignSignal) =>
                sdk.writeFiles(files, { signal: AbortSignal.any([foreignSignal, setupSignal]) }),
              );
          }),
        );

        if (signal.aborted && Exit.isSuccess(setup))
          return yield* withRelease(
            Effect.fail(
              EnvironmentOperationError.from(signal.reason, 'sandbox_acquisition_aborted'),
            ),
            stop(),
          );

        if (Exit.isFailure(setup)) return yield* withRelease(Effect.failCause(setup.cause), stop());
        const disposeLock = yield* Semaphore.make(1);
        let disposal: Exit.Exit<void, SandboxCleanupError> | undefined;

        const environment: CaseEnvironment = {
          exec: (script, execution = {}) =>
            lifecycle.track((admitted) =>
              Effect.gen(function* () {
                const commandLifetime = new AbortController();

                const onExceeded = (): void =>
                  commandLifetime.abort(new Error('Sandbox command output exceeds outputBytes.'));

                const stdout = new BoundedOutputWritable(Math.ceil(cap / 2), onExceeded);
                const stderr = new BoundedOutputWritable(Math.floor(cap / 2), onExceeded);

                const result = yield* foreign((foreignSignal) =>
                  sdk.runCommand({
                    cmd: 'sh',
                    args: ['-c', script],
                    cwd: SANDBOX_WORKSPACE,
                    env: { ...options.env, ...execution.env },
                    signal: AbortSignal.any([
                      foreignSignal,
                      operationSignal(
                        AbortSignal.any([admitted, commandLifetime.signal]),
                        execution.signal,
                      ),
                    ]),
                    timeoutMs: commandTimeoutMs,
                    stdout,
                    stderr,
                  }),
                ).pipe(Effect.catch(poison));

                if (stdout.exceeded || stderr.exceeded)
                  return yield* poison(
                    new EnvironmentOperationError({ reason: 'command_output_too_large' }),
                  );

                return {
                  stdout: stdout.buffer().toString('utf8'),
                  stderr: stderr.buffer().toString('utf8'),
                  exitCode: result.exitCode,
                };
              }),
            ),
          readFile: (path) =>
            lifecycle.track((admitted) =>
              Effect.gen(function* () {
                const contents = yield* readRemoteFile(
                  sdk,
                  resolveRemotePath(normalizeWorkspacePath(path)),
                  cap,
                  operationSignal(admitted),
                );

                if (contents === null)
                  return yield* new EnvironmentOperationError({ reason: 'file_missing', path });

                return contents.toString('utf8');
              }),
            ),
          writeFile: (path, content) =>
            lifecycle.track((admitted) =>
              Effect.gen(function* () {
                if (Buffer.byteLength(content) > cap)
                  return yield* new EnvironmentOperationError({ reason: 'file_too_large' });
                yield* foreign((foreignSignal) =>
                  sdk.writeFiles(
                    [{ path: resolveRemotePath(normalizeWorkspacePath(path)), content }],
                    { signal: AbortSignal.any([foreignSignal, operationSignal(admitted)]) },
                  ),
                );
              }),
            ),
          beginFinalization: lifecycle.beginFinalization,
          dispose: () =>
            Effect.uninterruptible(
              disposeLock.withPermits(1)(
                Effect.gen(function* () {
                  if (disposal) return yield* disposal;
                  disposal = yield* Effect.exit(
                    Effect.gen(function* () {
                      // Close admission immediately; stop concurrently so ignored local abort cannot keep a VM alive.
                      const releases = yield* Effect.all(
                        [
                          Effect.exit(
                            Effect.timeoutOption(
                              Effect.interruptible(
                                lifecycle.close(new Error('Case environment disposed.')),
                              ),
                              cleanupTimeoutMs,
                            ),
                          ),
                          Effect.exit(stop()),
                        ],
                        { concurrency: 'unbounded' },
                      );

                      const [drained, stopReceipt] = releases;
                      const errors: unknown[] = [];

                      if (Exit.isFailure(drained)) errors.push(drained.cause);

                      if (Exit.isFailure(stopReceipt)) errors.push(stopReceipt.cause);

                      if (Exit.isSuccess(drained) && Option.isNone(drained.value))
                        errors.push(
                          new Error('Sandbox operations did not drain before cleanup timed out.'),
                        );

                      if (errors.length > 0)
                        return yield* Effect.fail(
                          new SandboxCleanupError(errors, 'Sandbox cleanup failed.'),
                        );
                    }),
                  );

                  return yield* disposal;
                }),
              ),
            ),
        };

        return environment;
      }),
    );
  });
};

export { vercelSandboxIsolation, type VercelIsolationOptions };
