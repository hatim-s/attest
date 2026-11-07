import { parseWithSchemaSync } from '@attest/contracts';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { parseJson } from '../../internal/json-value.js';
import type { AgentRequest, VercelSandbox } from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import { startTimer } from '../../internal/elapsed.js';
import { createFailedAttempt } from '../../internal/failed-attempt.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import { invokeWithRetries, retryBudgetSchema } from '../../internal/invocation-retry.js';
import type { InvocationAttempt, InvocationDiagnostics, InvocationResult } from '../../types.js';
import { BoundedOutputWritable, BoundedTailWritable } from './bounded-writable.js';
import { createCaseSandbox, stopCaseSandbox } from './case-sandbox.js';
import { resolveVercelSandboxCredentials } from './credentials.js';
import { SANDBOX_WORKSPACE } from './sandbox-paths.js';
import { loadExplicitUploads, publishTerminalArtifacts } from './sandbox-transfer.js';
import type {
  VercelSandboxCaseOptions,
  VercelSandboxInvocation,
  VercelSandboxSdk,
} from './types.js';

const INTERNAL_ROOT = '/vercel/sandbox/.attest';

const REQUEST_PATH = `${INTERNAL_ROOT}/request.json`;

const STDIN_WRAPPER = 'exec "$@" < "$0"';

/** Retains successful attempt evidence when releasing its abort listener fails. */
class SandboxAttemptCleanupError extends Data.TaggedError('SandboxAttemptCleanupError')<{
  attempt: InvocationAttempt;
  cleanupCause: Cause.Cause<never>;
}> {}

/** Keeps release diagnostics on a primary defect or interruption without replacing it. */
class SandboxAttemptCleanupDiagnostics extends Context.Service<
  SandboxAttemptCleanupDiagnostics,
  { cause: Cause.Cause<never> }
>()('attest/SandboxAttemptCleanupDiagnostics') {}

/** Runs one command attempt inside an already prepared case-scoped sandbox. */
const invokeSandboxAttempt = Effect.fn('invokeSandboxAttempt')(function* (
  sdk: VercelSandboxSdk,
  invocation: VercelSandboxInvocation,
  request: AgentRequest,
  signal: AbortSignal | undefined,
): Effect.fn.Return<InvocationAttempt, SandboxAttemptCleanupError> {
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      let cleanupCause: Cause.Cause<never> | undefined;

      const primary = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const duration = startTimer();
            const controller = new AbortController();
            const cancel = (): void => controller.abort(signal?.reason);
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                signal?.addEventListener('abort', cancel, { once: true });

                if (signal?.aborted === true) cancel();
              }),
              () =>
                Effect.gen(function* () {
                  const released = yield* Effect.exit(
                    Effect.sync(() => signal?.removeEventListener('abort', cancel)),
                  );

                  if (Exit.isFailure(released)) cleanupCause = released.cause;
                }),
            );
            // The server deadline is primary. After one extra second, request SDK abort acknowledgement.
            yield* Effect.forkScoped(
              Effect.interruptible(
                Effect.gen(function* () {
                  yield* Effect.sleep(invocation.attemptTimeoutMs + 1_000);
                  controller.abort(
                    new DOMException('Sandbox attempt deadline expired', 'TimeoutError'),
                  );
                }),
              ),
            );

            // Keep draining after the cap. The server-enforced command timeout then confirms termination
            // before the retry loop may start another command in this case-scoped VM.
            const stdout = new BoundedOutputWritable(invocation.responseBytes);
            const stderr = new BoundedTailWritable(Math.min(4096, invocation.responseBytes));
            const capMessage = `Sandbox stdout exceeded the ${String(invocation.responseBytes)}-byte output cap`;

            const stderrDiagnostics = (): InvocationDiagnostics => {
              const stderrExcerpt = stderr.text();

              return stderrExcerpt === undefined ? {} : { stderrExcerpt };
            };

            const fail = (
              error: AgentInvocationError,
              diagnostics: InvocationDiagnostics,
              rawExcerpt?: InvocationAttempt['rawExcerpt'],
            ): InvocationAttempt =>
              createFailedAttempt(error, { diagnostics, durationMs: duration(), rawExcerpt });

            /** Classifies an SDK rejection, which leaves the remote command's state unconfirmed. */
            const interruptedError = (): AgentInvocationError => {
              // Cancellation outranks a cap breach, which outranks the attempt deadline.
              if (stdout.exceeded && signal?.aborted !== true) {
                return new AgentInvocationError('output_cap_exceeded', capMessage);
              }

              if (signal?.aborted === true || controller.signal.aborted) {
                return abortedError(signal, 'Sandbox agent invocation');
              }

              return new AgentInvocationError('network', 'Sandbox agent invocation failed');
            };

            return yield* Effect.gen(function* () {
              const requestDocument = JSON.stringify(request);

              if (Buffer.byteLength(requestDocument) > invocation.responseBytes) {
                return fail(
                  new AgentInvocationError(
                    'output_cap_exceeded',
                    'Sandbox request exceeds limits.response_bytes.',
                  ),
                  {},
                );
              }

              yield* Effect.tryPromise({
                try: (foreignSignal) =>
                  sdk.writeFiles([{ path: REQUEST_PATH, content: requestDocument }], {
                    signal: AbortSignal.any([foreignSignal, controller.signal]),
                  }),
                catch: interruptedError,
              });

              if (controller.signal.aborted) {
                return fail(interruptedError(), stderrDiagnostics());
              }

              const [command, ...args] = invocation.argv;

              const result = yield* Effect.tryPromise({
                try: (foreignSignal) =>
                  sdk.runCommand({
                    cmd: 'sh',
                    args: ['-c', STDIN_WRAPPER, REQUEST_PATH, command, ...args],
                    cwd:
                      invocation.cwd === undefined
                        ? SANDBOX_WORKSPACE
                        : `${SANDBOX_WORKSPACE}/${invocation.cwd}`,
                    env: invocation.env,
                    stdout,
                    stderr,
                    signal: AbortSignal.any([foreignSignal, controller.signal]),
                    timeoutMs: invocation.attemptTimeoutMs,
                  }),
                catch: interruptedError,
              });

              const raw = stdout.buffer().toString('utf8');
              const excerpt = createRawExcerpt(raw);

              const rawExcerpt = stdout.exceeded
                ? { ...excerpt, truncated: true, sha256: stdout.digest() }
                : excerpt;

              const diagnostics = { ...stderrDiagnostics(), exitCode: result.exitCode };

              if (signal?.aborted === true) {
                return fail(
                  abortedError(signal, 'Sandbox agent invocation'),
                  diagnostics,
                  rawExcerpt,
                );
              }

              if (stdout.exceeded) {
                return fail(
                  new AgentInvocationError('output_cap_exceeded', capMessage),
                  diagnostics,
                  rawExcerpt,
                );
              }

              // The SDK reports a server-side command timeout as SIGKILL (137) at the deadline.
              const killedAtDeadline =
                controller.signal.aborted ||
                (result.exitCode === 137 &&
                  (result.durationMs ?? duration()) >= invocation.attemptTimeoutMs);

              if (killedAtDeadline) {
                return fail(
                  new AgentInvocationError('timeout', 'Sandbox agent invocation timed out'),
                  diagnostics,
                  rawExcerpt,
                );
              }

              if (result.exitCode !== 0) {
                return fail(
                  new AgentInvocationError(
                    'nonzero_exit',
                    `Sandbox agent exited with code ${String(result.exitCode)}`,
                  ),
                  diagnostics,
                  rawExcerpt,
                );
              }

              try {
                return {
                  status: 'ok' as const,
                  raw: parseJson(raw),
                  diagnostics,
                  durationMs: duration(),
                  rawExcerpt,
                  warnings: [],
                };
              } catch (error: unknown) {
                return fail(
                  new AgentInvocationError(
                    'invalid_envelope',
                    'Sandbox agent stdout was not valid JSON',
                    {
                      cause: error,
                    },
                  ),
                  diagnostics,
                  rawExcerpt,
                );
              }
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  const rawExcerpt = createRawExcerpt(stdout.buffer().toString('utf8'));

                  return fail(
                    error,
                    { ...stderrDiagnostics(), sandboxCompletionConfirmed: false },
                    stdout.exceeded
                      ? { ...rawExcerpt, truncated: true, sha256: stdout.digest() }
                      : rawExcerpt,
                  );
                }),
              ),
            );
          }),
        ),
      );

      if (Exit.isFailure(primary)) {
        return yield* Effect.failCause(
          cleanupCause === undefined
            ? primary.cause
            : Cause.annotate(
                primary.cause,
                Context.make(SandboxAttemptCleanupDiagnostics, { cause: cleanupCause }),
              ),
        );
      }

      if (cleanupCause !== undefined) {
        return yield* Effect.fail(
          new SandboxAttemptCleanupError({ attempt: primary.value, cleanupCause }),
        );
      }

      return primary.value;
    }),
  );
});

/** Classifies a setup failure that is not already an invocation error. */
const setupError = (
  cause: unknown,
  callerSignal: AbortSignal | undefined,
  setupTimeout: AbortSignal,
): AgentInvocationError => {
  if (cause instanceof AgentInvocationError) return cause;

  if (callerSignal?.aborted === true || setupTimeout.aborted) {
    return abortedError(callerSignal, 'Vercel sandbox setup', { cause });
  }

  return new AgentInvocationError('spawn_failed', 'Vercel sandbox setup failed', { cause });
};

/** Exports terminal artifacts; a failure is recorded beside the result instead of replacing it. */
const exportArtifacts = async (
  sdk: VercelSandboxSdk,
  artifacts: NonNullable<VercelSandbox['artifacts']>,
  artifactRoot: string,
  invocation: VercelSandboxInvocation,
  options: VercelSandboxCaseOptions,
): Promise<AgentInvocationError | undefined> => {
  const artifactTimeout = AbortSignal.timeout(invocation.attemptTimeoutMs);

  const artifactSignal =
    options.signal === undefined
      ? artifactTimeout
      : AbortSignal.any([options.signal, artifactTimeout]);

  try {
    await publishTerminalArtifacts(sdk, artifacts, {
      projectRoot: options.projectRoot,
      artifactRoot,
      responseBytes: invocation.responseBytes,
      commandTimeoutMs: invocation.attemptTimeoutMs,
      signal: artifactSignal,
    });

    return undefined;
  } catch (error: unknown) {
    if (error instanceof AgentInvocationError) return error;

    return new AgentInvocationError('network', 'Sandbox artifact export failed', { cause: error });
  }
};

/** Invokes one native CLI case in one fresh Vercel sandbox reused across its retries. */
const invokeVercelSandboxAgent = async (
  sandbox: VercelSandbox,
  invocation: VercelSandboxInvocation,
  request: AgentRequest,
  options: VercelSandboxCaseOptions,
): Promise<InvocationResult> => {
  const { retries } = parseWithSchemaSync(retryBudgetSchema, invocation);
  const artifacts = sandbox.artifacts ?? [];
  const { artifactRoot } = options;

  if (artifacts.length > 0 && artifactRoot === undefined) {
    throw new TypeError('Sandbox artifacts require an output directory.');
  }

  const credentials = resolveVercelSandboxCredentials(options.credentialEnv ?? process.env);
  let sdk: VercelSandboxSdk | undefined;
  let result: InvocationResult | undefined;
  let postRunError: AgentInvocationError | undefined;
  let nativeFailure: Cause.Cause<SandboxAttemptCleanupError> | undefined;
  let cleanupConfirmed = true;
  const setupTimeout = AbortSignal.timeout(invocation.attemptTimeoutMs);

  const setupSignal =
    options.signal === undefined ? setupTimeout : AbortSignal.any([options.signal, setupTimeout]);

  try {
    const created = await createCaseSandbox({
      credentials,
      factory: options.sandboxFactory,
      image: sandbox.image,
      timeoutMs: invocation.sandboxTimeoutMs,
      signal: setupSignal,
    });

    sdk = created;

    const uploads = await loadExplicitUploads(
      options.projectRoot,
      sandbox.files,
      invocation.responseBytes,
    );

    const prepare = await created.runCommand({
      cmd: 'mkdir',
      args: ['-p', INTERNAL_ROOT, SANDBOX_WORKSPACE],
      signal: setupSignal,
      timeoutMs: invocation.attemptTimeoutMs,
    });

    if (prepare.exitCode !== 0) {
      throw new AgentInvocationError('spawn_failed', 'Could not prepare the sandbox workspace.');
    }

    if (uploads.length > 0) await created.writeFiles(uploads, { signal: setupSignal });

    // EFFECT-BRIDGE(S5): Promise sandbox lifecycle owns the native retry/attempt leaf until S5.
    const invocationExit = await Effect.runPromiseExit(
      invokeWithRetries(
        () => invokeSandboxAttempt(created, invocation, request, options.signal),
        retries,
      ),
    );

    if (Exit.isSuccess(invocationExit)) result = invocationExit.value;
    else nativeFailure = invocationExit.cause;

    if (nativeFailure === undefined && artifactRoot !== undefined && artifacts.length > 0) {
      postRunError = await exportArtifacts(created, artifacts, artifactRoot, invocation, options);
    }
  } catch (error: unknown) {
    postRunError = setupError(error, options.signal, setupTimeout);
  } finally {
    if (sdk !== undefined) {
      try {
        await stopCaseSandbox(sdk, options.cleanupTimeoutMs);
      } catch (error: unknown) {
        cleanupConfirmed = false;
        postRunError ??= new AgentInvocationError('network', 'Vercel sandbox cleanup failed', {
          cause: error,
        });
      }
    }
  }

  // Do not turn native defects or interruption into retryable setup errors at the S5 edge.
  if (nativeFailure !== undefined) {
    if (!Cause.hasDies(nativeFailure) && !Cause.hasInterrupts(nativeFailure)) {
      for (const reason of nativeFailure.reasons) {
        if (Cause.isFailReason(reason)) {
          Object.defineProperties(reason.error, {
            effectCause: { value: nativeFailure, configurable: true },
            sandboxCleanupError: { value: postRunError, configurable: true },
          });
          throw reason.error;
        }
      }
    }

    throw new Error('Native sandbox invocation did not complete normally.', {
      cause: { effectCause: nativeFailure, cleanupError: postRunError },
    });
  }

  if (postRunError === undefined && result !== undefined) return result;
  const cleanupDiagnostics = cleanupConfirmed ? {} : { sandboxCleanupConfirmed: false };

  if (result?.status === 'invocation_error') {
    return {
      ...result,
      diagnostics: {
        ...result.diagnostics,
        sandboxError: postRunError?.message ?? 'Sandbox execution did not produce a result.',
        ...cleanupDiagnostics,
      },
    };
  }

  const diagnostics: InvocationDiagnostics = { ...cleanupDiagnostics };

  if (postRunError !== undefined) diagnostics.sandboxError = postRunError.message;

  const attempt = createFailedAttempt(
    postRunError ??
      new AgentInvocationError('network', 'Sandbox execution did not produce a result.'),
    {
      diagnostics,
      durationMs: result?.durationMs ?? 0,
    },
  );

  return { ...attempt, attempts: [...(result?.attempts ?? []), attempt] };
};

export { invokeVercelSandboxAgent };
