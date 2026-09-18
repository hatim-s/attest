import type { VercelSandbox as VercelSandboxResource } from '@attest/contracts';
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

type VercelSandboxCreateParams = {
  image: string;
  persistent: false;
  timeout: number;
  signal?: AbortSignal;
  token?: string;
  teamId?: string;
  projectId?: string;
};

type VercelSandboxSdk = Pick<SandboxSdk, 'readFile' | 'runCommand' | 'stop' | 'writeFiles'>;

type VercelSandboxFactory = (params: VercelSandboxCreateParams) => Promise<VercelSandboxSdk>;

export type {
  VercelSandboxCaseOptions,
  VercelSandboxCreateParams,
  VercelSandboxFactory,
  VercelSandboxInvocation,
  VercelSandboxResource,
  VercelSandboxSdk,
};
