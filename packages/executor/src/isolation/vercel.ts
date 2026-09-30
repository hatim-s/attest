import { BoundedOutputWritable } from '../adapters/sandbox/bounded-writable.js';
import { resolveVercelSandboxCredentials } from '../adapters/sandbox/credentials.js';
import { readRemoteFile, resolveRemotePath, SANDBOX_WORKSPACE } from '../adapters/sandbox/files.js';
import type { VercelSandboxFactory } from '../adapters/sandbox/types.js';
import { defaultSandboxFactory } from '../adapters/sandbox/vercel-sandbox-adapter.js';
import { requirePositiveInteger } from '../internal/positive-integer.js';
import { createEnvironmentLifecycle } from './environment-lifecycle.js';
import type { CaseEnvironmentFactory } from './types.js';
import { normalizeWorkspacePath } from './workspace-path.js';

type VercelIsolationOptions = {
  image?: string;
  timeoutMs?: number;
  commandTimeoutMs?: number;
  finalizationTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  outputBytes?: number;
  files?: Record<string, string>;
  env?: Record<string, string>;
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

/** Marks failed VM cleanup so runtime can prevent unsafe worker reuse. */
const cleanupFailure = (operationError: unknown, stopError: unknown): SandboxCleanupError =>
  new SandboxCleanupError([operationError, stopError], 'Sandbox operation and cleanup failed.');

/** Marks a standalone stop failure as unconfirmed cleanup. */
const stopFailure = (error: unknown): SandboxCleanupError =>
  new SandboxCleanupError([error], 'Sandbox cleanup failed.');

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
const vercelSandboxIsolation =
  (options: VercelIsolationOptions = {}): CaseEnvironmentFactory =>
  async ({ signal }) => {
    signal.throwIfAborted();
    const credentials = resolveVercelSandboxCredentials(options.credentialEnv ?? process.env);
    const factory = options.sandboxFactory ?? defaultSandboxFactory;
    const commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
    const finalizationTimeoutMs = options.finalizationTimeoutMs ?? commandTimeoutMs;
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
    const cap = options.outputBytes ?? 1024 * 1024;
    requirePositiveInteger('outputBytes', cap);
    requirePositiveInteger('commandTimeoutMs', commandTimeoutMs);
    requirePositiveInteger('finalizationTimeoutMs', finalizationTimeoutMs);
    requirePositiveInteger('cleanupTimeoutMs', cleanupTimeoutMs);
    const files = resolveSeedFiles(options.files ?? {}, cap);
    const sdk = await factory({
      image: options.image ?? 'vercel/sandbox/universal',
      persistent: false,
      timeout: options.timeoutMs ?? 600_000,
      signal: AbortSignal.any([signal, AbortSignal.timeout(commandTimeoutMs)]),
      ...(credentials.kind === 'oidc' ? {} : credentials.credentials),
    });
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
    const poison = async (error: unknown): Promise<never> => {
      poisonReason ??=
        error instanceof Error
          ? error
          : new Error('Vercel Sandbox command rejected.', { cause: error });
      lifecycle.poison(error);
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
      const stopped = stop().catch((error: unknown) => {
        cleanupError = error;
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
        .catch((error: unknown) => poison(error));
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
      kind: 'vercel',
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
            .catch((error: unknown) => poison(error));
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

export { vercelSandboxIsolation, type VercelIsolationOptions };
