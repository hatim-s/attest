import type {
  AgentRequest,
  AgentResponse,
  ContractWarning,
  ParseReport,
  Trace,
} from '@attest/contracts';

import type { AgentInvocationError } from './errors.js';

/** Controls a single agent invocation; timeouts and caps come from resolved config defaults. */
type InvokeOptions = {
  /** Aborts the invocation; the CLI transport kills the whole process tree. */
  signal?: AbortSignal;
  /** Per-invocation deadline in milliseconds (spec default 60 000). */
  timeoutMs: number;
  /** Maximum stdout / response-body size in bytes (spec default 10 MB). */
  outputCapBytes: number;
  /** Fully resolved environment for the child process: allowlist + ATTEST_* + base set. */
  env: Record<string, string>;
  /** Fresh temporary directory the CLI transport uses as cwd; owned by the caller. */
  workingDirectory?: string;
  /**
   * SIGTERM→SIGKILL grace window in milliseconds (spec: 5 000). Overridable so
   * kill-escalation tests do not wait out the full production grace period.
   */
  terminationGraceMs?: number;
};

/** Transport-level metadata recorded for one invocation attempt. */
type InvocationDiagnostics = {
  /** Last 4 KB of stderr for CLI agents; surfaced in reports, never parsed. */
  stderrExcerpt?: string;
  exitCode?: number;
  httpStatus?: number;
};

/** One transport attempt: either a raw envelope or an invocation error. */
type InvocationAttempt =
  | {
      status: 'ok';
      raw: unknown;
      /** Populated by invokeAgent after envelope validation; transport invokers leave it unset. */
      report?: ParseReport<AgentResponse>;
      diagnostics: InvocationDiagnostics;
      durationMs: number;
    }
  | {
      status: 'invocation_error';
      error: AgentInvocationError;
      diagnostics: InvocationDiagnostics;
      durationMs: number;
    };

/** Final result of `invokeAgent` after retries; `attempts` preserves every try for determinism. */
type InvocationResult = InvocationAttempt & { attempts: InvocationAttempt[] };

/** Terminal classification of one case after invocation, ingestion, and retries. */
type CaseOutcome = 'completed' | 'invocation_error' | 'timeout' | 'cancelled';

/**
 * Everything downstream consumers (metrics, store, reports) need about one executed case.
 *
 * Field layout deliberately mirrors the store package's `StoredCaseExecution` so
 * persistence is a near-noop mapping (error object → code/message pair).
 */
type CaseExecution = {
  caseId: string;
  suiteName: string;
  request: AgentRequest;
  outcome: CaseOutcome;
  /** Present when outcome is `completed`; carries the validated envelope + contract warnings. */
  response?: AgentResponse;
  warnings: ContractWarning[];
  /** Present when the completed response embedded a valid trace. */
  trace?: Trace;
  /** Present when outcome is not `completed`. */
  invocationError?: AgentInvocationError;
  diagnostics: InvocationDiagnostics;
  /** Every transport attempt including retries, preserved for determinism per the agent contract. */
  attempts: InvocationAttempt[];
  /** Metric names resolved for this case (per-case override, else suite metrics). */
  expectedMetrics: string[];
  startedAt: string;
  durationMs: number;
};

/** Progress signal emitted as cases finish; ordering follows completion, not config order. */
type RunProgressEvent = {
  completed: number;
  total: number;
  execution: CaseExecution;
};

/** Controls a whole-config execution pass. */
type ExecuteOptions = {
  runId: string;
  /** Directory used to resolve dataset paths from the loaded config. */
  baseDirectory: string;
  signal?: AbortSignal;
  /** Overrides `run.concurrency` from config (default 4). */
  concurrency?: number;
  /** Optional CLI termination grace override, forwarded unchanged to each invocation. */
  terminationGraceMs?: number;
  onProgress?: (event: RunProgressEvent) => void;
};

export {
  type CaseExecution,
  type CaseOutcome,
  type ExecuteOptions,
  type InvocationAttempt,
  type InvocationDiagnostics,
  type InvocationResult,
  type InvokeOptions,
  type RunProgressEvent,
};
