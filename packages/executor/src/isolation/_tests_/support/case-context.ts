import type { CaseEnvironmentContext } from '../../types.js';

/** Builds the context runtime passes to a case environment factory. */
const caseContext = (signal = new AbortController().signal): CaseEnvironmentContext => ({
  runId: 'run',
  testId: 'test',
  caseId: 'case',
  configuredIndex: 0,
  workerIndex: 0,
  signal,
});

export { caseContext };
