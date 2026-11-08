import { Link } from '@tanstack/react-router';
import type { CaseSummary } from '@attest/core/records';
import { StatusMark } from '../../components/marks/status-mark.js';
import { FailureReasonCell } from './failure-reason-cell.js';

type FailedCasesProps = {
  projectKey: string;
  runId: string;
  /** The failed and errored cases among the loaded rows, in run order. */
  failed: readonly CaseSummary[];
  /** Position of each case in the run, counted from 1. */
  positions: ReadonlyMap<string, number>;
};

/** Every failed or errored case with the reason it did not pass. */
const FailedCases = ({ projectKey, runId, failed, positions }: FailedCasesProps) => (
  <ul className="attest-alist">
    {failed.map((summary) => (
      <li key={summary.caseId}>
        <span className="attest-pos">#{positions.get(summary.caseId)}</span>
        <Link
          className="attest-an"
          to="/projects/$projectKey/evals/$suiteName/runs/$runId/cases/$caseId"
          params={{ projectKey, suiteName: summary.suiteName, runId, caseId: summary.caseId }}
          title={summary.caseId}
        >
          {summary.caseId}
        </Link>
        <FailureReasonCell
          projectKey={projectKey}
          identity={{ runId, suiteName: summary.suiteName, caseId: summary.caseId }}
        />
        <span className="attest-status" data-tone="failing">
          <StatusMark tone="failing" />
          {summary.verdict === 'error' ? 'Error' : 'Failed'}
        </span>
      </li>
    ))}
  </ul>
);

export { FailedCases };
