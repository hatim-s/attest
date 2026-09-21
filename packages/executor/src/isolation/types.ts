/** Case-owned shell and workspace-relative filesystem. */
type CaseEnvironment = {
  readonly kind: string;
  exec(
    script: string,
    options?: { signal?: AbortSignal; env?: Record<string, string> },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /** Cancels and drains run work before admitting bounded final-hook operations. */
  beginFinalization?(): Promise<void>;
  /** Aborts and drains all admitted work before releasing the environment. */
  dispose(): Promise<void>;
};
type CaseEnvironmentContext = {
  runId: string;
  testId: string;
  caseId: string;
  configuredIndex: number;
  workerIndex: number;
  signal: AbortSignal;
};
type CaseEnvironmentFactory = (context: CaseEnvironmentContext) => Promise<CaseEnvironment>;

export { type CaseEnvironment, type CaseEnvironmentContext, type CaseEnvironmentFactory };
