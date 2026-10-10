import type { Sandbox as SandboxSdk } from '@vercel/sandbox';

type VercelSandboxInvocation = {
  argv: readonly [string, ...string[]];
  cwd?: string;
  env: Record<string, string>;
  attemptTimeoutMs: number;
  retries: number;
  /** Resolved agent limits.response_bytes. It bounds every transferred or retained file. */
  responseBytes: number;
  sandboxTimeoutMs: number;
};

type VercelSandboxCaseOptions = {
  projectRoot: string;
  /** Resolved absolute output root. Required when the resource declares artifacts. */
  artifactRoot?: string;
  signal?: AbortSignal;
  /** Test seam for credential checks. Production callers should leave this unset. */
  credentialEnv?: NodeJS.ProcessEnv;
  /** Small SDK seam. Production callers should leave this unset. */
  sandboxFactory?: VercelSandboxFactory;
  cleanupTimeoutMs?: number;
};

/** The SDK's own creation parameters, so the injectable factory cannot drift from the SDK. */
type VercelSandboxCreateParams = NonNullable<Parameters<typeof SandboxSdk.create>[0]>;

/** Executor-owned SDK operations; command execution consumes only completion and timing. */
type VercelSandboxSdk = Pick<SandboxSdk, 'readFile' | 'writeFiles'> & {
  runCommand: (
    params: Parameters<SandboxSdk['runCommand']>[0] & { signal: AbortSignal; args: string[] },
  ) => Promise<{
    exitCode: number;
    durationMs?: number;
  }>;
  stop: (
    options?: Parameters<SandboxSdk['stop']>[0],
  ) => Promise<void | Awaited<ReturnType<SandboxSdk['stop']>>>;
};

type VercelSandboxFactory = (params: VercelSandboxCreateParams) => Promise<VercelSandboxSdk>;

export type {
  VercelSandboxCaseOptions,
  VercelSandboxCreateParams,
  VercelSandboxFactory,
  VercelSandboxInvocation,
  VercelSandboxSdk,
};
