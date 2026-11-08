import { getRouteApi, Link } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { CaseRecord, CaseSummary } from '@attest/core/records';
import { caseRecordVerdict } from '@attest/core/records';
import { useDashboardSource } from '../../api/api-client-context.js';
import { useLiveProjectOverview } from '../../api/live-updates.js';
import {
  caseRecordQueryOptions,
  caseSummariesQueryOptions,
  runQueryOptions,
} from '../../api/queries/runs.js';
import { EmptyState } from '../../components/empty/empty-state.js';
import { RunLifecycle } from '../../components/marks/run-lifecycle.js';
import { StatusMark } from '../../components/marks/status-mark.js';
import { JsonBlock } from '../../components/values/json-block.js';
import { formatDuration, shortRunId } from '../../lib/format.js';
import { VERDICT_WORDS } from '../eval-run/run-case-list.js';
import { CaseArtifacts } from './case-artifacts.js';
import { CaseChecks } from './case-checks.js';
import { CaseSteps } from './case-steps.js';
import { caseWalk } from './case-walk.js';
import { useWalkKeys } from './use-walk-keys.js';
import '../../styles/compact/pages.css';
import '../../styles/compact/runs.css';

const route = getRouteApi('/projects/$projectKey/evals/$suiteName/runs/$runId/cases/$caseId');

const OUTCOME_WORDS = {
  invocation_error: 'Invocation error',
  timeout: 'Timed out',
  cancelled: 'Cancelled',
} as const satisfies Record<Exclude<CaseRecord['outcome'], 'completed'>, string>;

/** The agent's response without its artifacts, which have their own section. */
const outputText = (record: CaseRecord) => {
  if (record.outcome !== 'completed') return undefined;

  return JSON.stringify(
    Object.fromEntries(Object.entries(record.response).filter(([key]) => key !== 'artifacts')),
    null,
    2,
  );
};

/** Why a case has no output, or what the agent reported instead of one. */
const StateNote = ({ record }: { record: CaseRecord }) => {
  if (record.outcome !== 'completed')
    return (
      <p className="attest-note" data-tone="error">
        <b>{OUTCOME_WORDS[record.outcome]}</b> <code>{record.errorCode}</code> {record.errorMessage}
      </p>
    );

  if (record.response.error !== undefined)
    return (
      <p className="attest-note" data-tone="error">
        <b>The agent returned an error.</b>{' '}
        {record.response.error.code !== undefined && <code>{record.response.error.code}</code>}{' '}
        {record.response.error.message}
      </p>
    );

  return null;
};

/** One recorded case: input and output, the checks and their reasons, then steps and artifacts. */
const CaseEvidence = ({ record }: { record: CaseRecord }) => {
  const output = outputText(record);

  return (
    <>
      <StateNote record={record} />
      <div className="attest-io">
        <section aria-label="Input">
          <h3>Input</h3>
          <JsonBlock label="Input" text={JSON.stringify(record.request.input, null, 2)} />
        </section>
        <section aria-label="Output">
          <h3>Output</h3>
          {output === undefined ? (
            <p className="attest-dim">No output. The agent call did not complete.</p>
          ) : (
            <JsonBlock label="Output" text={output} />
          )}
        </section>
      </div>
      <section className="attest-ev-sec" aria-labelledby="attest-checks-h">
        <h3 id="attest-checks-h">
          Checks{' '}
          {record.metrics.length > 0 && (
            <span className="attest-dim">
              {
                record.metrics.filter((metric) => metric.status === 'evaluated' && metric.pass)
                  .length
              }{' '}
              of {record.metrics.length} passed
            </span>
          )}
        </h3>
        <CaseChecks record={record} />
      </section>
      <section className="attest-ev-sec" aria-labelledby="attest-steps-h">
        <h3 id="attest-steps-h">Steps</h3>
        {record.outcome === 'completed' && record.trace !== undefined ? (
          <CaseSteps trace={record.trace} />
        ) : (
          <p className="attest-dim">No steps recorded.</p>
        )}
      </section>
      {record.outcome === 'completed' && (record.response.artifacts?.length ?? 0) > 0 && (
        <CaseArtifacts artifacts={record.response.artifacts ?? []} />
      )}
      {record.warnings.length > 0 && (
        <details className="attest-disc">
          <summary>
            Warnings <span className="attest-dim">{record.warnings.length}</span>
          </summary>
          <ul className="attest-disc-b attest-arts">
            {record.warnings.map((warning) => (
              <li key={`${warning.path}:${warning.code}`}>
                <code>{warning.path}</code>
                <span>{warning.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
};

/**
 * One case in one run. Only this page reads the full case record. Previous, Next, Next failure
 * and `j` / `k` walk the run's loaded case rows in run order.
 */
const RunCasePage = () => {
  const { projectKey, suiteName, runId, caseId } = route.useParams();
  const navigate = route.useNavigate();
  const source = useDashboardSource();

  useLiveProjectOverview(source, projectKey);

  const run = useQuery(runQueryOptions(source, projectKey, runId));
  const running = run.data?.status === 'running';

  const cases = useInfiniteQuery(
    caseSummariesQueryOptions(source, projectKey, { runId, suiteName }, running),
  );

  const record = useQuery(caseRecordQueryOptions(source, projectKey, { runId, suiteName, caseId }));
  const rows = cases.data?.pages.flatMap((page) => page.items) ?? [];
  const walk = caseWalk(rows, caseId);
  const position = rows.findIndex((summary) => summary.caseId === caseId) + 1;

  const open = (summary: CaseSummary | undefined) => {
    if (summary !== undefined)
      void navigate({ params: (previous) => ({ ...previous, caseId: summary.caseId }) });
  };

  useWalkKeys(
    () => open(walk.next),
    () => open(walk.previous),
  );

  const pagerLink = (summary: CaseSummary | undefined, label: string, keys?: string) =>
    summary === undefined ? (
      <span className="attest-btn-2" aria-disabled="true">
        {label}
      </span>
    ) : (
      <Link
        className="attest-btn-2"
        to="/projects/$projectKey/evals/$suiteName/runs/$runId/cases/$caseId"
        params={{ projectKey, suiteName, runId, caseId: summary.caseId }}
        aria-keyshortcuts={keys}
        title={summary.caseId}
      >
        {label}
      </Link>
    );

  const verdict = record.data === undefined ? undefined : caseRecordVerdict(record.data);

  return (
    <>
      <div className="attest-page-head">
        <div className="attest-page-title">
          <h1 className="attest-mono-title">{caseId}</h1>
          <p className="attest-sub attest-meta">
            {verdict !== undefined && (
              <span
                className="attest-status"
                data-tone={verdict === 'pass' ? 'passing' : 'failing'}
              >
                <StatusMark tone={verdict === 'pass' ? 'passing' : 'failing'} />
                {VERDICT_WORDS[verdict]}
              </span>
            )}
            {record.data !== undefined && <span>{formatDuration(record.data.durationMs)}</span>}
            {position > 0 && (
              <span>
                Case {position} of {rows.length}
              </span>
            )}
            <span>
              in run{' '}
              <Link
                className="attest-mono"
                to="/projects/$projectKey/evals/$suiteName/runs/$runId"
                params={{ projectKey, suiteName, runId }}
                title={runId}
              >
                {shortRunId(runId)}
              </Link>
            </span>
            {run.data !== undefined && <RunLifecycle status={run.data.status} />}
          </p>
        </div>
        <nav className="attest-page-end attest-pager" aria-label="Cases in this run">
          {pagerLink(walk.previous, 'Previous', 'k')}
          {pagerLink(walk.next, 'Next', 'j')}
          {pagerLink(walk.nextFailure, 'Next failure')}
        </nav>
      </div>
      {record.data === undefined ? (
        record.error === null ? (
          <p className="attest-loading" role="status">
            Loading case {caseId}...
          </p>
        ) : (
          <EmptyState title="Could not load this case" description={record.error.message} />
        )
      ) : (
        <CaseEvidence record={record.data} />
      )}
    </>
  );
};

export { RunCasePage };
