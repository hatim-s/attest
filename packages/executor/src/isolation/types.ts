import type * as Effect from 'effect/Effect';

/** Case-owned shell and workspace-relative filesystem. */
type CaseEnvironment = {
  exec(
    script: string,
    options?: { signal?: AbortSignal; env?: Record<string, string> },
  ): Effect.Effect<
    {
      stdout: string;
      stderr: string;
      exitCode: number;
    },
    Error
  >;
  readFile(path: string): Effect.Effect<string, Error>;
  writeFile(path: string, contents: string): Effect.Effect<void, Error>;
  /** Cancels and drains run work before admitting bounded final-hook operations. */
  beginFinalization(): Effect.Effect<void, Error>;
  /** Aborts and drains all admitted work before releasing the environment. */
  dispose(): Effect.Effect<void, Error>;
};

type CaseEnvironmentContext = {
  runId: string;
  testId: string;
  caseId: string;
  configuredIndex: number;
  workerIndex: number;
  signal: AbortSignal;
};

type CaseEnvironmentFactory = (
  context: CaseEnvironmentContext,
) => Effect.Effect<CaseEnvironment, Error>;

export { type CaseEnvironment, type CaseEnvironmentContext, type CaseEnvironmentFactory };
