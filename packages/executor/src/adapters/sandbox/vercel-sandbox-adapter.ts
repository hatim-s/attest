import { performance } from 'node:perf_hooks';

import type { AgentRequest } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import { invokeWithRetries } from '../../internal/invocation-retry.js';
import type { InvocationAttempt, InvocationResult } from '../../types.js';
import { BoundedOutputWritable, BoundedTailWritable } from './bounded-writable.js';
import { resolveVercelSandboxCredentials } from './credentials.js';
import { loadExplicitUploads, publishTerminalArtifacts, SANDBOX_WORKSPACE } from './files.js';
import type {
  VercelSandboxCaseOptions,
  VercelSandboxCreateParams,
  VercelSandboxInvocation,
  VercelSandboxResource,
  VercelSandboxSdk,
} from './types.js';

const DEFAULT_IMAGE = 'vercel/sandbox/universal';
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const INTERNAL_ROOT = '/vercel/sandbox/.attest';
const REQUEST_PATH = `${INTERNAL_ROOT}/request.json`;
const STDIN_WRAPPER = 'exec "$@" < "$0"';

const defaultSandboxFactory = async (
  params: VercelSandboxCreateParams,
): Promise<VercelSandboxSdk> => {
  const { Sandbox } = await import('@vercel/sandbox');
  return Sandbox.create(params);
};

/** Runs one command attempt inside an already prepared case-scoped sandbox. */
const invokeSandboxAttempt = async (
  sdk: VercelSandboxSdk,
  invocation: VercelSandboxInvocation,
  request: AgentRequest,
  signal: AbortSignal | undefined,
): Promise<InvocationAttempt> => {
  const started = performance.now();
  const attemptTimeout = AbortSignal.timeout(invocation.attemptTimeoutMs + 1_000);
  const attemptSignal =
    signal === undefined ? attemptTimeout : AbortSignal.any([signal, attemptTimeout]);
  // Keep draining after the cap. The server-enforced command timeout then confirms termination
  // before the retry loop may start another command in this case-scoped VM.
  const stdout = new BoundedOutputWritable(invocation.responseBytes, () => undefined);
  const stderr = new BoundedTailWritable(Math.min(4096, invocation.responseBytes));
  try {
    const requestDocument = JSON.stringify(request);
    if (Buffer.byteLength(requestDocument) > invocation.responseBytes) {
      return {
        status: 'invocation_error',
        error: new AgentInvocationError(
          'output_cap_exceeded',
          'Sandbox request exceeds limits.response_bytes.',
        ),
        diagnostics: {},
        durationMs: performance.now() - started,
        warnings: [],
      };
    }
    await sdk.writeFiles([{ path: REQUEST_PATH, content: requestDocument }], {
      signal: attemptSignal,
    });
    const [command, ...args] = invocation.argv;
    const result = await sdk.runCommand({
      cmd: 'sh',
      args: ['-c', STDIN_WRAPPER, REQUEST_PATH, command, ...args],
      cwd:
        invocation.cwd === undefined ? SANDBOX_WORKSPACE : `${SANDBOX_WORKSPACE}/${invocation.cwd}`,
      env: invocation.env,
      stdout,
      stderr,
      signal: attemptSignal,
      timeoutMs: invocation.attemptTimeoutMs,
    });
    const raw = stdout.buffer().toString('utf8');
    const rawExcerpt = createRawExcerpt(raw);
    const diagnostics = {
      ...(stderr.text() === undefined ? {} : { stderrExcerpt: stderr.text() }),
      exitCode: result.exitCode,
    };
    if (stdout.exceeded) {
      return {
        status: 'invocation_error',
        error: new AgentInvocationError(
          'output_cap_exceeded',
          `Sandbox stdout exceeded the ${String(invocation.responseBytes)}-byte output cap`,
        ),
        diagnostics,
        durationMs: performance.now() - started,
        rawExcerpt: { ...rawExcerpt, truncated: true, sha256: stdout.digest() },
        warnings: [],
      };
    }
    if (
      result.exitCode === 137 &&
      (result.durationMs ?? performance.now() - started) >= invocation.attemptTimeoutMs
    ) {
      return {
        status: 'invocation_error',
        error: new AgentInvocationError('timeout', 'Sandbox agent invocation timed out'),
        diagnostics,
        durationMs: performance.now() - started,
        rawExcerpt,
        warnings: [],
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: 'invocation_error',
        error: new AgentInvocationError(
          'nonzero_exit',
          `Sandbox agent exited with code ${String(result.exitCode)}`,
        ),
        diagnostics,
        durationMs: performance.now() - started,
        rawExcerpt,
        warnings: [],
      };
    }
    try {
      return {
        status: 'ok',
        raw: JSON.parse(raw) as unknown,
        diagnostics,
        durationMs: performance.now() - started,
        rawExcerpt,
        warnings: [],
      };
    } catch (error: unknown) {
      return {
        status: 'invocation_error',
        error: new AgentInvocationError(
          'invalid_envelope',
          'Sandbox agent stdout was not valid JSON',
          {
            cause: error,
          },
        ),
        diagnostics,
        durationMs: performance.now() - started,
        rawExcerpt,
        warnings: [],
      };
    }
  } catch {
    const cancelled = signal?.aborted === true;
    const timedOut = !cancelled && attemptTimeout.aborted;
    return {
      status: 'invocation_error',
      error: new AgentInvocationError(
        cancelled
          ? 'cancelled'
          : stdout.exceeded
            ? 'output_cap_exceeded'
            : timedOut
              ? 'timeout'
              : 'network',
        cancelled
          ? 'Sandbox agent invocation was cancelled'
          : stdout.exceeded
            ? `Sandbox stdout exceeded the ${String(invocation.responseBytes)}-byte output cap`
            : 'Sandbox agent invocation failed',
      ),
      diagnostics: {
        ...(stderr.text() === undefined ? {} : { stderrExcerpt: stderr.text() }),
        sandboxCompletionConfirmed: false,
      },
      durationMs: performance.now() - started,
      rawExcerpt: createRawExcerpt(stdout.buffer().toString('utf8')),
      warnings: [],
    };
  }
};

/** Invokes one native CLI case in one fresh Vercel sandbox reused across its retries. */
const invokeVercelSandboxAgent = async (
  sandbox: VercelSandboxResource,
  invocation: VercelSandboxInvocation,
  request: AgentRequest,
  options: VercelSandboxCaseOptions,
): Promise<InvocationResult> => {
  if ((sandbox.artifacts?.length ?? 0) > 0 && options.artifactRoot === undefined) {
    throw new AgentInvocationError(
      'spawn_failed',
      'Sandbox artifacts require an output directory.',
    );
  }
  const credentials = resolveVercelSandboxCredentials(options.credentialEnv ?? process.env);
  const factory = options.sandboxFactory ?? defaultSandboxFactory;
  let sdk: VercelSandboxSdk | undefined;
  let result: InvocationResult | undefined;
  let postRunError: AgentInvocationError | undefined;
  let cleanupConfirmed = true;
  const setupTimeout = AbortSignal.timeout(invocation.attemptTimeoutMs);
  const setupSignal =
    options.signal === undefined ? setupTimeout : AbortSignal.any([options.signal, setupTimeout]);
  try {
    sdk = await factory({
      image: sandbox.image ?? DEFAULT_IMAGE,
      persistent: false,
      timeout: invocation.sandboxTimeoutMs,
      signal: setupSignal,
      ...(credentials.kind === 'oidc' ? {} : credentials.credentials),
    });
    const uploads = await loadExplicitUploads(
      options.projectRoot,
      sandbox.files,
      invocation.responseBytes,
    );
    const prepare = await sdk.runCommand({
      cmd: 'mkdir',
      args: ['-p', INTERNAL_ROOT, SANDBOX_WORKSPACE],
      signal: setupSignal,
      timeoutMs: invocation.attemptTimeoutMs,
    });
    if (prepare.exitCode !== 0) {
      throw new AgentInvocationError('spawn_failed', 'Could not prepare the sandbox workspace.');
    }
    if (uploads.length > 0) await sdk.writeFiles(uploads, { signal: setupSignal });
    result = await invokeWithRetries(
      () => invokeSandboxAttempt(sdk!, invocation, request, options.signal),
      invocation.retries,
    );
    if ((sandbox.artifacts?.length ?? 0) > 0) {
      try {
        const artifactTimeout = AbortSignal.timeout(invocation.attemptTimeoutMs);
        const artifactSignal =
          options.signal === undefined
            ? artifactTimeout
            : AbortSignal.any([options.signal, artifactTimeout]);
        await publishTerminalArtifacts(
          sdk,
          sandbox.artifacts ?? [],
          options.projectRoot,
          options.artifactRoot!,
          invocation.responseBytes,
          invocation.attemptTimeoutMs,
          artifactSignal,
        );
      } catch (error: unknown) {
        postRunError =
          error instanceof AgentInvocationError
            ? error
            : new AgentInvocationError('network', 'Sandbox artifact export failed', {
                cause: error instanceof Error ? error : undefined,
              });
      }
    }
  } catch (error: unknown) {
    postRunError =
      error instanceof AgentInvocationError
        ? error
        : new AgentInvocationError(
            options.signal?.aborted === true
              ? 'cancelled'
              : setupTimeout.aborted
                ? 'timeout'
                : 'spawn_failed',
            options.signal?.aborted === true
              ? 'Vercel sandbox setup was cancelled'
              : setupTimeout.aborted
                ? 'Vercel sandbox setup timed out'
                : 'Vercel sandbox setup failed',
            { cause: error instanceof Error ? error : undefined },
          );
  } finally {
    if (sdk !== undefined) {
      try {
        await sdk.stop({
          signal: AbortSignal.timeout(options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS),
        });
      } catch (error: unknown) {
        cleanupConfirmed = false;
        postRunError ??= new AgentInvocationError('network', 'Vercel sandbox cleanup failed', {
          cause: error instanceof Error ? error : undefined,
        });
      }
    }
  }

  if (postRunError === undefined && result !== undefined) return result;
  if (result?.status === 'invocation_error') {
    return {
      ...result,
      diagnostics: {
        ...result.diagnostics,
        sandboxError: postRunError?.message ?? 'Sandbox execution did not produce a result.',
        ...(cleanupConfirmed ? {} : { sandboxCleanupConfirmed: false }),
      },
    };
  }
  const attempt: InvocationAttempt = {
    status: 'invocation_error',
    error:
      postRunError ??
      new AgentInvocationError('network', 'Sandbox execution did not produce a result.'),
    diagnostics: {
      ...(postRunError === undefined ? {} : { sandboxError: postRunError.message }),
      ...(cleanupConfirmed ? {} : { sandboxCleanupConfirmed: false }),
    },
    durationMs: result?.durationMs ?? 0,
    warnings: [],
  };
  return { ...attempt, attempts: [...(result?.attempts ?? []), attempt] };
};

export { invokeVercelSandboxAgent };
