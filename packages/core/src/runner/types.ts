import type {
  AgentRequest,
  AgentResponse,
  CaseDefinition,
  CaseOutcome,
  ContractWarning,
  ParseReport,
  RawExcerpt,
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
  /** Fully resolved environment for the child process: allowlist + ATTEST_* + synthesized base. */
  env: Record<string, string>;
  /** Runtime-only native HTTP headers resolved from authored secret references. */
  httpHeaders?: Record<string, string>;
  /** Fresh per-attempt directory the CLI transport uses as cwd; owned by the invoker. */
  workingDirectory?: string;
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

/** Fields shared by every terminal case state; layout mirrors the store's persisted shape. */
type CaseExecutionBase = {
  caseId: string;
  suiteName: string;
  request: AgentRequest;
  /**
   * Transient full case document (including `expected`) so metrics can run
   * before persistence; the store adapter deliberately drops it.
   */
  caseDefinition: CaseDefinition;
  /** Metric names resolved for this case (per-case override, else suite metrics). */
  expectedMetrics: string[];
  /** Every transport attempt including retries, preserved per the agent contract. */
  attempts: InvocationAttempt[];
  diagnostics: InvocationDiagnostics;
  warnings: ContractWarning[];
  startedAt: string;
  durationMs: number;
};

/**
 * Everything downstream consumers (metrics, store, reports) need about one
 * executed case, discriminated on `outcome` so completed cases provably carry
 * a response and failed ones provably carry the invocation error.
 */
type CaseExecution = CaseExecutionBase &
  (
    | { outcome: 'completed'; response: AgentResponse; trace?: Trace }
    | {
        outcome: Exclude<CaseOutcome, 'completed'>;
        invocationError: AgentInvocationError;
      }
  );

export {
  type CaseExecution,
  type CaseExecutionBase,
  type InvocationAttempt,
  type InvocationDiagnostics,
  type InvocationResult,
  type InvokeAgentOptions,
  type InvokeOptions,
};
