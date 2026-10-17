import type { AgentResponse, ContractWarning, ParseReport, RawExcerpt } from '@attest/contracts';

import type { AgentInvocationError } from './errors.js';

/** Describes the two native transports that use the shared envelope invoker. */
type NativeAgentTarget = { type: 'cli'; command: string[] } | { type: 'http'; url: string };

/** Controls a single agent invocation; timeouts and caps come from resolved config defaults. */
type InvokeOptions = {
  /** Aborts the invocation; the CLI transport kills the whole process tree. */
  signal?: AbortSignal;
  /** Per-invocation deadline in milliseconds (spec default 60 000). */
  timeoutMs: number;
  /** Maximum stdout / response-body size in bytes (spec default 10 MB). */
  outputCapBytes: number;
  /**
   * Resolved variables for a CLI agent, layered over its isolated base environment. Every key is
   * forwarded, including PATH. When unset, the agent gets only the host's absolute PATH entries.
   */
  env?: Record<string, string>;
  /** Runtime-only native HTTP headers resolved from authored secret references. */
  httpHeaders?: Record<string, string>;
  /** Host-owned guarded HTTP I/O, used instead of the global fetch implementation. */
  httpFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * CLI cwd shared with lifecycle hooks, kept after the attempt. When unset, every attempt gets a
   * fresh directory under the system temporary directory that is removed afterwards.
   */
  workingDirectory?: string;
  /** SIGTERM→SIGKILL grace window in milliseconds (spec: 5 000). */
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
