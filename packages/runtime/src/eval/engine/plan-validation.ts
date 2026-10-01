import { isDeepStrictEqual } from 'node:util';

import type { EvalRun } from '@attest/contracts';

import type { ResolvedEvalPlan } from '../types.js';

/** Every run emits run_started, two events per case, run_completed, and result. */
const expectedEventCount = (plan: ResolvedEvalPlan): number => plan.cases.length * 2 + 3;

/** Verifies that opaque cases still match the frozen snapshot and configured order exactly. */
const validateResolvedPlan = (
  plan: ResolvedEvalPlan,
  run: Readonly<EvalRun>,
): string | undefined => {
  const concurrency = run.effective_command.resolved.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return 'Resolved eval concurrency must be a positive integer.';
  }
  const workerCount = run.effective_command.resolved.execution?.workers?.count;
  if (workerCount !== undefined && workerCount !== concurrency) {
    return 'Resolved eval worker count must equal resolved concurrency.';
  }
  const selectedCases = run.snapshot.selected_cases;
  if (
    run.snapshot.selection !== undefined &&
    run.snapshot.selection.selected_cases !== selectedCases.length
  ) {
    return 'Selection coverage does not match the immutable eval snapshot.';
  }
  if (selectedCases.length !== plan.cases.length) {
    return 'Resolved case count does not match the immutable eval snapshot.';
  }
  for (let index = 0; index < plan.cases.length; index += 1) {
    const resolvedCase = plan.cases[index];
    const selectedCase = selectedCases[index];
    if (
      resolvedCase === undefined ||
      selectedCase === undefined ||
      resolvedCase.configured_index !== index ||
      selectedCase.configured_index !== index ||
      resolvedCase.test_id !== selectedCase.test_id ||
      resolvedCase.case_id !== selectedCase.case_id ||
      !isDeepStrictEqual(resolvedCase.source, selectedCase.source)
    ) {
      return `Resolved case at configured index ${String(index)} drifted from the immutable eval snapshot.`;
    }
    if (
      resolvedCase.test_concurrency !== undefined &&
      (!Number.isInteger(resolvedCase.test_concurrency) || resolvedCase.test_concurrency < 1)
    ) {
      return `Resolved test concurrency at configured index ${String(index)} must be a positive integer.`;
    }
    if (
      workerCount !== undefined &&
      resolvedCase.test_concurrency !== undefined &&
      resolvedCase.test_concurrency !== workerCount
    ) {
      return `Resolved test concurrency at configured index ${String(index)} must equal the worker count.`;
    }
  }
  return undefined;
};

export { expectedEventCount, validateResolvedPlan };
