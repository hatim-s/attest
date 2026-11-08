import type { EvalCaseWindow, EvalSlice } from '@attest/core/records';

/** A case's result in one run; `null` means the case has no row in that run. */
type WindowCell = EvalCaseWindow['items'][number]['cells'][number];

type CaseCell = NonNullable<WindowCell>;

/** The Test cases tab's chips, in the order they show. */
const CASE_FILTERS = ['all', 'failing', 'flaky'] as const;

type CaseFilter = (typeof CASE_FILTERS)[number];

const CELL_WORDS = {
  pass: 'Passed',
  fail: 'Failed',
  error: 'Error',
  skipped: 'Skipped',
} as const satisfies Record<CaseCell, string>;

/** How a case stands across the window's runs. */
type CaseStanding = { failing: boolean; flaky: boolean; passed: number; recorded: number };

const isBad = (cell: WindowCell) => cell === 'fail' || cell === 'error';

/**
 * The run whose cells decide Failing: the newest slice that completed. A running or partial slice
 * has no verdict for the eval, so it never decides whether a case is failing. Runs are newest first.
 */
const verdictRunIndex = (runs: readonly Pick<EvalSlice, 'state'>[]): number =>
  runs.findIndex((run) => run.state === 'complete');

/** Passed results over recorded ones. A skipped result is recorded; a missing row is not. */
const passedCount = (cells: readonly WindowCell[]) => ({
  passed: cells.filter((cell) => cell === 'pass').length,
  recorded: cells.filter((cell) => cell !== null).length,
});

/**
 * Failing: the case failed or errored in the newest complete run. Flaky: the window holds both a
 * pass and a failure or error. `cells[i]` lines up with `runs[i]`.
 */
const caseStanding = (
  runs: readonly Pick<EvalSlice, 'state'>[],
  cells: readonly WindowCell[],
): CaseStanding => {
  const verdictIndex = verdictRunIndex(runs);

  return {
    failing: verdictIndex !== -1 && isBad(cells[verdictIndex] ?? null),
    flaky: cells.includes('pass') && cells.some(isBad),
    ...passedCount(cells),
  };
};

/** Whether a case belongs under a chip. */
const matchesFilter = (standing: CaseStanding, filter: CaseFilter): boolean =>
  filter === 'all' || standing[filter];

export {
  CASE_FILTERS,
  CELL_WORDS,
  caseStanding,
  matchesFilter,
  passedCount,
  verdictRunIndex,
  type CaseCell,
  type CaseFilter,
  type CaseStanding,
  type WindowCell,
};
