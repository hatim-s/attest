import { Link } from '@tanstack/react-router';
import type { CaseHistoryPage } from '@attest/core/records';
import { StatusMark, type StatusTone } from '../../components/marks/status-mark.js';
import { formatStarted, shortRunId } from '../../lib/format.js';
import { CELL_WORDS, type CaseCell } from '../eval-cases/case-standing.js';

const CELL_TONES = {
  pass: 'passing',
  fail: 'failing',
  error: 'failing',
  skipped: 'skipped',
} as const satisfies Record<CaseCell, StatusTone>;

type CaseOutcomesProps = {
  projectKey: string;
  suiteName: string;
  caseId: string;
  /** Newest first. */
  outcomes: readonly CaseHistoryPage['items'][number][];
};

/** The case's result in each run, each linked to the case in that run. */
const CaseOutcomes = ({ projectKey, suiteName, caseId, outcomes }: CaseOutcomesProps) => (
  <table className="attest-table">
    <caption className="attest-sr-only">Outcomes of {caseId} by run, newest first</caption>
    <thead>
      <tr>
        <th scope="col">Run</th>
        <th scope="col">Result</th>
        <th scope="col">Started</th>
      </tr>
    </thead>
    <tbody>
      {outcomes.map((outcome) => (
        <tr key={outcome.runId}>
          <td className="attest-nw">
            <Link
              className="attest-rowlink attest-mono"
              to="/projects/$projectKey/evals/$suiteName/runs/$runId/cases/$caseId"
              params={{ projectKey, suiteName, runId: outcome.runId, caseId }}
              title={outcome.runId}
              aria-label={`Open ${caseId} in run ${shortRunId(outcome.runId)}`}
            >
              {shortRunId(outcome.runId)}
            </Link>
          </td>
          <td>
            <span className="attest-status" data-tone={CELL_TONES[outcome.cell]}>
              <StatusMark tone={CELL_TONES[outcome.cell]} />
              {CELL_WORDS[outcome.cell]}
            </span>
          </td>
          <td className="attest-nw attest-dim">{formatStarted(outcome.createdAt)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

export { CaseOutcomes };
