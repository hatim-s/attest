import type { CaseSummary } from '@attest/core/records';

type CaseWalk = {
  previous: CaseSummary | undefined;
  next: CaseSummary | undefined;
  /** The next failed or errored case after this one, wrapping to the start; never this case. */
  nextFailure: CaseSummary | undefined;
};

const failing = (summary: CaseSummary) => summary.verdict !== 'pass';

/**
 * Previous, Next and Next failure through the run's loaded cases, in run order. A case missing
 * from the loaded rows has no neighbours, and its next failure is the first one in the run.
 */
const caseWalk = (cases: readonly CaseSummary[], caseId: string): CaseWalk => {
  const index = cases.findIndex((summary) => summary.caseId === caseId);

  if (index === -1)
    return { previous: undefined, next: undefined, nextFailure: cases.find(failing) };

  return {
    previous: cases[index - 1],
    next: cases[index + 1],
    nextFailure: cases.slice(index + 1).find(failing) ?? cases.slice(0, index).find(failing),
  };
};

export { caseWalk, type CaseWalk };
