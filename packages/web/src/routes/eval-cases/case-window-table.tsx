import type { ReactNode } from 'react';
import type { EvalSlice } from '@attest/core/records';
import { shortRunId } from '../../lib/format.js';
import { CaseHistoryStrip, type HistoryMark } from './case-history-strip.js';
import type { CaseStanding, WindowCell } from './case-standing.js';

/** One case of the loaded window. `position` is its place in case id order, before filtering. */
type CaseRow = {
  position: number;
  caseId: string;
  cells: readonly WindowCell[];
  standing: CaseStanding;
};

type CaseWindowTableProps = {
  projectKey: string;
  suiteName: string;
  /** The window's runs, newest first; every row's cells line up with them. */
  runs: readonly EvalSlice[];
  rows: readonly CaseRow[];
  /** Shown in place of the rows when the filters leave none. */
  empty: ReactNode;
};

/** The case's real results in the window, newest first. A `null` cell leaves no mark. */
const marksOf = (runs: readonly EvalSlice[], cells: readonly WindowCell[]): HistoryMark[] =>
  runs.flatMap((run, index) => {
    const cell = cells[index] ?? null;

    return cell === null ? [] : [{ runId: run.runId, createdAt: run.createdAt, cell }];
  });

/** Position, case id, its history strip and how often it passed in the window. */
const CaseWindowTable = ({ projectKey, suiteName, runs, rows, empty }: CaseWindowTableProps) => {
  const newest = runs[0];
  const oldest = runs.at(-1);

  return (
    <table className="attest-table attest-cases-table">
      <caption className="attest-sr-only">Test cases in {suiteName}</caption>
      <thead>
        <tr>
          <th scope="col" className="attest-num attest-pos-c">
            #
          </th>
          <th scope="col">Case</th>
          <th
            scope="col"
            className="attest-hide-narrow"
            title={
              newest === undefined || oldest === undefined
                ? undefined
                : `Runs ${shortRunId(oldest.runId)} to ${shortRunId(newest.runId)}, oldest first`
            }
          >
            History
          </th>
          <th scope="col" className="attest-num">
            Passed
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const marks = marksOf(runs, row.cells);

          return (
            <tr key={row.caseId}>
              <td className="attest-num attest-dim attest-mono attest-pos-c">{row.position}</td>
              <td className="attest-case-id">
                <span className="attest-mono">{row.caseId}</span>
              </td>
              <td className="attest-nw attest-hide-narrow">
                {marks.length === 0 ? (
                  <span className="attest-dim">No result in these runs</span>
                ) : (
                  <CaseHistoryStrip
                    projectKey={projectKey}
                    suiteName={suiteName}
                    caseId={row.caseId}
                    marks={marks}
                  />
                )}
              </td>
              <td className="attest-num">
                {row.standing.recorded === 0 ? (
                  <span className="attest-dim">None</span>
                ) : (
                  `${row.standing.passed} of ${row.standing.recorded}`
                )}
              </td>
            </tr>
          );
        })}
        {rows.length === 0 && (
          <tr>
            <td colSpan={4}>{empty}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
};

export { CaseWindowTable, type CaseRow };
