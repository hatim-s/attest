import { Link } from '@tanstack/react-router';
import type { CaseSummary } from '@attest/core/records';
import { StatusMark } from '../../components/marks/status-mark.js';
import { formatDuration } from '../../lib/format.js';

const VERDICT_WORDS = {
  pass: 'Passed',
  fail: 'Failed',
  error: 'Error',
} as const satisfies Record<CaseSummary['verdict'], string>;

/** Every loaded case of the run as one linked row; the evidence is on the case page. */
const RunCaseList = ({
  projectKey,
  runId,
  cases,
}: {
  projectKey: string;
  runId: string;
  cases: readonly CaseSummary[];
}) => (
  <ul className="attest-rlist">
    {cases.map((summary, index) => (
      <li key={summary.caseId}>
        <Link
          to="/projects/$projectKey/evals/$suiteName/runs/$runId/cases/$caseId"
          params={{ projectKey, suiteName: summary.suiteName, runId, caseId: summary.caseId }}
          aria-label={`Case ${index + 1}, ${summary.caseId}: ${VERDICT_WORDS[summary.verdict]}`}
        >
          <StatusMark tone={summary.verdict === 'pass' ? 'passing' : 'failing'} />
          <span className="attest-pos">#{index + 1}</span>
          <span className="attest-nm">{summary.caseId}</span>
          <span className="attest-du">{formatDuration(summary.durationMs)}</span>
        </Link>
      </li>
    ))}
  </ul>
);

export { RunCaseList, VERDICT_WORDS };
