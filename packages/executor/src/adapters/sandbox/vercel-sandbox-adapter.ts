import type { AgentRequest, VercelSandbox } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { startTimer } from '../../internal/elapsed.js';
import { createFailedAttempt } from '../../internal/failed-attempt.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import { invokeWithRetries } from '../../internal/invocation-retry.js';
import type { InvocationAttempt, InvocationDiagnostics, InvocationResult } from '../../types.js';
import { BoundedOutputWritable, BoundedTailWritable } from './bounded-writable.js';
import { resolveVercelSandboxCredentials } from './credentials.js';
import { SANDBOX_WORKSPACE } from './sandbox-paths.js';
import { loadExplicitUploads, publishTerminalArtifacts } from './sandbox-transfer.js';
import type {
  VercelSandboxCaseOptions,
  VercelSandboxCreateParams,
  VercelSandboxInvocation,
  VercelSandboxSdk,
} from './types.js';

const DEFAULT_IMAGE = 'vercel/sandbox/universal';
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const INTERNAL_ROOT = '/vercel/sandbox/.attest';
const REQUEST_PATH = `${INTERNAL_ROOT}/request.json`;
const STDIN_WRAPPER = 'exec "$@" < "$0"';

/** Loads the Vercel SDK lazily so hosts that never use sandboxes do not pay for the import. */
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
  const duration = startTimer();
  const attemptTimeout = AbortSignal.timeout(invocation.attemptTimeoutMs + 1_000);
  const attemptSignal =
    signal === undefined ? attemptTimeout : AbortSignal.any([signal, attemptTimeout]);
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
    if (signal?.aborted === true) {
      return new AgentInvocationError('cancelled', 'Sandbox agent invocation was cancelled');
    }
    if (stdout.exceeded) return new AgentInvocationError('output_cap_exceeded', capMessage);
    if (attemptTimeout.aborted) {
      return new AgentInvocationError('timeout', 'Sandbox agent invocation failed');
    }
    return new AgentInvocationError('network', 'Sandbox agent invocation failed');
  };

  try {
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
    const diagnostics = { ...stderrDiagnostics(), exitCode: result.exitCode };
    if (stdout.exceeded) {
      return fail(new AgentInvocationError('output_cap_exceeded', capMessage), diagnostics, {
        ...rawExcerpt,
        truncated: true,
        sha256: stdout.digest(),
      });
    }
    // The SDK reports a server-side command timeout as SIGKILL (137) at the deadline.
    const killedAtDeadline =
      result.exitCode === 137 && (result.durationMs ?? duration()) >= invocation.attemptTimeoutMs;
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
        status: 'ok',
        raw: JSON.parse(raw) as unknown,
        diagnostics,
        durationMs: duration(),
        rawExcerpt,
        warnings: [],
      };
    } catch (error: unknown) {
      return fail(
        new AgentInvocationError('invalid_envelope', 'Sandbox agent stdout was not valid JSON', {
          cause: error,
        }),
        diagnostics,
        rawExcerpt,
      );
    }
  } catch {
    return fail(
      interruptedError(),
      { ...stderrDiagnostics(), sandboxCompletionConfirmed: false },
      createRawExcerpt(stdout.buffer().toString('utf8')),
    );
  }
};

/** Classifies a setup failure that is not already an invocation error. */
const setupError = (
  error: unknown,
  callerSignal: AbortSignal | undefined,
  setupTimeout: AbortSignal,
): AgentInvocationError => {
  if (error instanceof AgentInvocationError) return error;
  const options = { cause: error instanceof Error ? error : undefined };
  if (callerSignal?.aborted === true) {
    return new AgentInvocationError('cancelled', 'Vercel sandbox setup was cancelled', options);
  }
  if (setupTimeout.aborted) {
    return new AgentInvocationError('timeout', 'Vercel sandbox setup timed out', options);
  }
  return new AgentInvocationError('spawn_failed', 'Vercel sandbox setup failed', options);
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
    await publishTerminalArtifacts(
      sdk,
      artifacts,
      options.projectRoot,
      artifactRoot,
      invocation.responseBytes,
      invocation.attemptTimeoutMs,
      artifactSignal,
    );
    return undefined;
  } catch (error: unknown) {
    if (error instanceof AgentInvocationError) return error;
    return new AgentInvocationError('network', 'Sandbox artifact export failed', {
      cause: error instanceof Error ? error : undefined,
    });
  }
};

/** Invokes one native CLI case in one fresh Vercel sandbox reused across its retries. */
const invokeVercelSandboxAgent = async (
  sandbox: VercelSandbox,
  invocation: VercelSandboxInvocation,
  request: AgentRequest,
  options: VercelSandboxCaseOptions,
): Promise<InvocationResult> => {
  const artifacts = sandbox.artifacts ?? [];
  const { artifactRoot } = options;
  if (artifacts.length > 0 && artifactRoot === undefined) {
    throw new TypeError('Sandbox artifacts require an output directory.');
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
    const created = await factory({
      image: sandbox.image ?? DEFAULT_IMAGE,
      persistent: false,
      timeout: invocation.sandboxTimeoutMs,
      signal: setupSignal,
      ...(credentials.kind === 'oidc' ? {} : credentials.credentials),
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
    result = await invokeWithRetries(
      () => invokeSandboxAttempt(created, invocation, request, options.signal),
      invocation.retries,
    );
    if (artifactRoot !== undefined && artifacts.length > 0) {
      postRunError = await exportArtifacts(created, artifacts, artifactRoot, invocation, options);
    }
  } catch (error: unknown) {
    postRunError = setupError(error, options.signal, setupTimeout);
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
  const attempt = createFailedAttempt(
    postRunError ??
      new AgentInvocationError('network', 'Sandbox execution did not produce a result.'),
    {
      diagnostics: {
        ...(postRunError === undefined ? {} : { sandboxError: postRunError.message }),
        ...cleanupDiagnostics,
      },
      durationMs: result?.durationMs ?? 0,
    },
  );
  return { ...attempt, attempts: [...(result?.attempts ?? []), attempt] };
};

export { defaultSandboxFactory, invokeVercelSandboxAgent };
