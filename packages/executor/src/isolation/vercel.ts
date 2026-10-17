import { z } from 'zod';

import { BoundedOutputWritable } from '../adapters/sandbox/bounded-writable.js';
import { resolveVercelSandboxCredentials } from '../adapters/sandbox/credentials.js';
import { SANDBOX_WORKSPACE, resolveRemotePath } from '../adapters/sandbox/sandbox-paths.js';
import { readRemoteFile } from '../adapters/sandbox/sandbox-transfer.js';
import type { VercelSandboxCreateParams, VercelSandboxFactory } from '../adapters/sandbox/types.js';
import { defaultSandboxFactory } from '../adapters/sandbox/vercel-sandbox-adapter.js';
import { createEnvironmentLifecycle } from './environment-lifecycle.js';
import type { CaseEnvironmentFactory } from './types.js';
import { normalizeWorkspacePath } from './workspace-path.js';

/**
 * Node's timers and `AbortSignal.timeout` throw on fractions and overflow past 2^31 - 1 ms. A
 * cleanup bound that throws after creation would leave the VM running, so every bound is checked
 * here before a VM exists.
 */
const timerMsSchema = z.int().positive().max(2_147_483_647);

/** Programmatic options never pass through contracts, so this schema is their only parse. */
const vercelIsolationOptionsSchema = z.strictObject({
  image: z.string().default('vercel/sandbox/universal'),
  timeoutMs: timerMsSchema.default(600_000),
  commandTimeoutMs: timerMsSchema.default(60_000),
  /** Defaults to commandTimeoutMs. */
  finalizationTimeoutMs: timerMsSchema.optional(),
  cleanupTimeoutMs: timerMsSchema.default(10_000),
  outputBytes: z
    .int()
    .positive()
    .default(1024 * 1024),
  files: z.record(z.string(), z.string()).default({}),
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Passed through as typed. A non-function factory throws at the creation call, before any VM
   * exists, and credential resolution parses the env at case start.
   */
  sandboxFactory: z.custom<VercelSandboxFactory>().default(() => defaultSandboxFactory),
  credentialEnv: z.custom<NodeJS.ProcessEnv>().optional(),
});

type VercelIsolationOptions = z.input<typeof vercelIsolationOptionsSchema>;

/**
 * A VM that could not be confirmed stopped. Runtime reads `cleanupConfirmed` to stop reusing the
 * case worker, since the remote command may still be running.
 */
class SandboxCleanupError extends AggregateError {
  readonly cleanupConfirmed = false;
}

/** BOUNDARY: retains both rejected SDK operation and cleanup causes without assuming an Error subtype.
 * Marks failed VM cleanup so runtime can prevent unsafe worker reuse. */
const cleanupFailure = (cause: unknown, stopCause: unknown): SandboxCleanupError =>
  new SandboxCleanupError([cause, stopCause], 'Sandbox operation and cleanup failed.');

/** Marks a standalone stop failure as unconfirmed cleanup. */
const stopFailure = (cause: unknown): SandboxCleanupError =>
  new SandboxCleanupError([cause], 'Sandbox cleanup failed.');

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
  const options = vercelIsolationOptionsSchema.parse(input);
  const { commandTimeoutMs, cleanupTimeoutMs, outputBytes: cap } = options;
  const finalizationTimeoutMs = options.finalizationTimeoutMs ?? commandTimeoutMs;

  return async ({ signal }) => {
    signal.throwIfAborted();
    const credentials = resolveVercelSandboxCredentials(options.credentialEnv ?? process.env);
    const files = resolveSeedFiles(options.files, cap);

    const creation: VercelSandboxCreateParams = {
      image: options.image,
      persistent: false,
      timeout: options.timeoutMs,
      signal: AbortSignal.any([signal, AbortSignal.timeout(commandTimeoutMs)]),
    };

    if (credentials.kind !== 'oidc') Object.assign(creation, credentials.credentials);
    const sdk = await options.sandboxFactory(creation);

    let poisonReason: Error | undefined;
    let stopping: Promise<void> | undefined;
    let disposal: Promise<void> | undefined;

    const lifecycle = createEnvironmentLifecycle({
      signal,
      finalizationTimeoutMs,
      poisonedError: () => poisonReason ?? new Error('Case environment has been poisoned.'),
    });

    /** Stops this SDK instance at most once, including concurrent poison and disposal paths. */
    const stop = (): Promise<void> => {
      stopping ??= Promise.resolve()
        .then(() => sdk.stop({ signal: AbortSignal.timeout(cleanupTimeoutMs) }))
        .then(() => undefined);

      return stopping;
    };

    /** Stops a VM whose command rejected because the remote process may still be running. */
    const poison = async (cause: unknown): Promise<never> => {
      poisonReason ??=
        cause instanceof Error
          ? cause
          : new Error('Vercel Sandbox command rejected.', { cause: cause });
      lifecycle.poison(cause);

      try {
        await stop();
      } catch (cleanupError) {
        if (!(poisonReason instanceof SandboxCleanupError)) {
          poisonReason = cleanupFailure(poisonReason, cleanupError);
        }
      }

      throw poisonReason;
    };

    /** Adds per-command and caller deadlines to an admitted phase signal. */
    const operationSignal = (admitted: AbortSignal, extra?: AbortSignal): AbortSignal =>
      AbortSignal.any([admitted, AbortSignal.timeout(commandTimeoutMs), ...(extra ? [extra] : [])]);

    /** Aborts and drains all operations, then confirms the VM stopped. */
    const dispose = async (): Promise<void> => {
      const drained = lifecycle.close(new Error('Case environment disposed.'));
      // Stop right away so an SDK call that ignores local abort still loses its remote VM.
      let cleanupError: unknown;

      const stopped = stop().catch((cause: unknown) => {
        cleanupError = cause;
      });

      let timeout: ReturnType<typeof setTimeout> | undefined;

      const settled = await Promise.race([
        Promise.all([drained, stopped]).then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), cleanupTimeoutMs);
        }),
      ]);

      clearTimeout(timeout);

      if (settled && cleanupError === undefined) return;

      if (poisonReason instanceof SandboxCleanupError) throw poisonReason;
      throw stopFailure(
        cleanupError ?? new Error('Sandbox operations did not drain before cleanup timed out.'),
      );
    };

    try {
      const setupSignal = operationSignal(signal);

      const ready = await sdk
        .runCommand({
          cmd: 'mkdir',
          args: ['-p', SANDBOX_WORKSPACE],
          signal: setupSignal,
          timeoutMs: commandTimeoutMs,
        })
        .catch((cause: unknown) => poison(cause));

      if (ready.exitCode !== 0) throw new Error('Could not prepare case sandbox.');

      if (files.length > 0) await sdk.writeFiles(files, { signal: setupSignal });
    } catch (error) {
      try {
        await stop();
      } catch (cleanupError) {
        if (error instanceof SandboxCleanupError) throw error;
        throw cleanupFailure(error, cleanupError);
      }

      throw error;
    }

    return {
      exec: (script, execution = {}) =>
        lifecycle.track(async (admitted) => {
          const commandLifetime = new AbortController();
          const stdoutCap = Math.ceil(cap / 2);
          const stderrCap = Math.floor(cap / 2);

          const onExceeded = (): void =>
            commandLifetime.abort(new Error('Sandbox command output exceeds outputBytes.'));

          const stdout = new BoundedOutputWritable(stdoutCap, onExceeded);
          const stderr = new BoundedOutputWritable(stderrCap, onExceeded);

          const result = await sdk
            .runCommand({
              cmd: 'sh',
              args: ['-c', script],
              cwd: SANDBOX_WORKSPACE,
              env: { ...options.env, ...execution.env },
              signal: operationSignal(
                AbortSignal.any([admitted, commandLifetime.signal]),
                execution.signal,
              ),
              timeoutMs: commandTimeoutMs,
              stdout,
              stderr,
            })
            .catch((cause: unknown) => poison(cause));

          if (stdout.exceeded || stderr.exceeded) {
            throw new Error('Sandbox command output exceeds outputBytes.');
          }

          return {
            stdout: stdout.buffer().toString('utf8'),
            stderr: stderr.buffer().toString('utf8'),
            exitCode: result.exitCode,
          };
        }),
      readFile: (path) =>
        lifecycle.track(async (admitted) => {
          const contents = await readRemoteFile(
            sdk,
            resolveRemotePath(normalizeWorkspacePath(path)),
            cap,
            operationSignal(admitted),
          );

          if (contents === null) throw new Error(`Sandbox file does not exist: ${path}`);

          return contents.toString('utf8');
        }),
      writeFile: (path, content) =>
        lifecycle.track(async (admitted) => {
          if (Buffer.byteLength(content) > cap) {
            throw new Error('Sandbox file exceeds outputBytes.');
          }

          await sdk.writeFiles(
            [{ path: resolveRemotePath(normalizeWorkspacePath(path)), content }],
            { signal: operationSignal(admitted) },
          );
        }),
      beginFinalization: lifecycle.beginFinalization,
      dispose: () => {
        disposal ??= dispose();

        return disposal;
      },
    };
  };
};

export { vercelSandboxIsolation, type VercelIsolationOptions };
