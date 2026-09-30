import type { AgentResponse, ContractWarning, ParseReport, RawExcerpt } from '@attest/contracts';

import type { AgentInvocationError } from './errors.js';

/** Describes the two native transports that still use the shared envelope invoker. */
type NativeAgentTarget = { type: 'cli'; command: string[] } | { type: 'http'; url: string };

/** Controls a single agent invocation; timeouts and caps come from resolved config defaults. */
type InvokeOptions = {
  /** Aborts the invocation; the CLI transport kills the whole process tree. */
  signal?: AbortSignal;
  /** Per-invocation deadline in milliseconds (spec default 60 000). */
  timeoutMs: number;
  /** Maximum stdout / response-body size in bytes (spec default 10 MB). */
  outputCapBytes: number;
  /** Fully resolved environment for the child process: allowlist + ATTEST_* + synthesized base. */
  env: Record<string, string>;
  /** Runtime-only native HTTP headers resolved from authored secret references. */
  httpHeaders?: Record<string, string>;
  /** Fresh per-attempt directory the CLI transport uses as cwd; owned by the invoker. */
  workingDirectory?: string;
  /** Uses workingDirectory itself as cwd and preserves its contents for lifecycle hooks. */
  preserveWorkingDirectory?: boolean;
  /**
   * SIGTERM→SIGKILL grace window in milliseconds (spec: 5 000). Overridable so
   * kill-escalation tests do not wait out the full production grace period.
   */
  terminationGraceMs?: number;
};

/** Options for the retrying dispatch entry point, on top of single-attempt invocation. */
type InvokeAgentOptions = InvokeOptions & {
  /** Invocation-error retry budget (spec default 0); agent-reported errors never retry. */
  retries: number;
};

/** Transport-level metadata recorded for one invocation attempt. */
type InvocationDiagnostics = {
  /** Last 4 KB of stderr for CLI agents; surfaced in reports, never parsed. */
  stderrExcerpt?: string;
  exitCode?: number;
  httpStatus?: number;
  /** Bounded provider correlation id extracted from an authored response mapping. */
  remoteJobId?: string | number;
  /** Snapshotted descendants that survived SIGKILL verification, if any (best-effort containment). */
  unreapedProcessIds?: number[];
  /** Bounded sandbox setup, artifact, or cleanup failure retained beside the primary outcome. */
  sandboxError?: string;
  /** False when a remote sandbox could not be stopped and its case worker must not be reused. */
  sandboxCleanupConfirmed?: boolean;
  /** False when an SDK transport failure did not confirm that the remote command stopped. */
  sandboxCompletionConfirmed?: boolean;
  /** Bounded post-case lifecycle failure retained without discarding invocation evidence. */
  lifecycleError?: string;
};

/**
 * One transport attempt. Every attempt — including failures — retains bounded
 * payload evidence and parse warnings so runs are deterministic and auditable
 * per the agent contract's recording requirement.
 */
type InvocationAttempt = {
  diagnostics: InvocationDiagnostics;
  durationMs: number;
  /** Bounded transport payload evidence; hash+prefix when the cap truncated it. */
  rawExcerpt?: RawExcerpt;
  warnings: ContractWarning[];
} & (
  | {
      status: 'ok';
      raw: unknown;
      /** Populated by invokeAgent after envelope validation; transports leave it unset. */
      report?: ParseReport<AgentResponse>;
    }
  | { status: 'invocation_error'; error: AgentInvocationError }
);

/** Final result of `invokeAgent` after retries; `attempts` preserves every try for determinism. */
type InvocationResult = InvocationAttempt & { attempts: InvocationAttempt[] };

export {
  type InvocationAttempt,
  type InvocationDiagnostics,
  type InvocationResult,
  type InvokeAgentOptions,
  type InvokeOptions,
  type NativeAgentTarget,
};
