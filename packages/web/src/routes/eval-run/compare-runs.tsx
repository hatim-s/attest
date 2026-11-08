import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { CaseTransition, EvalSlice } from '@attest/core/records';
import { useDashboardSource } from '../../api/api-client-context.js';
import { diffQueryOptions } from '../../api/queries/runs.js';
import { formatCount, shortRunId } from '../../lib/format.js';

type CompareRunsProps = {
  projectKey: string;
  suiteName: string;
  runId: string;
  /** Earlier finished slices of this eval, newest first; the first complete one is the default. */
  earlier: readonly EvalSlice[];
};

/** The transitions worth a row, worst first. Unchanged cases only count. */
const LISTED = ['regressed', 'fixed', 'added', 'removed'] as const;

const KIND_WORDS = {
  regressed: 'Regressed',
  fixed: 'Fixed',
  added: 'New in this run',
  removed: 'Not in this run',
} as const satisfies Record<(typeof LISTED)[number], string>;

const COUNT_WORDS = {
  regressed: 'regressed',
  fixed: 'fixed',
  added: 'new',
  removed: 'dropped',
} as const satisfies Record<(typeof LISTED)[number], string>;

/** The comparison against one base run, filtered to this eval. Read only while the disclosure is open. */
const Comparison = ({
  projectKey,
  suiteName,
  runId,
  baseRunId,
}: Omit<CompareRunsProps, 'earlier'> & { baseRunId: string }) => {
  const source = useDashboardSource();
  const diff = useQuery(diffQueryOptions(source, projectKey, baseRunId, runId));

  if (diff.data === undefined)
    return (
      <p className="attest-loading" role="status">
        {diff.error?.message ?? `Comparing with ${shortRunId(baseRunId)}...`}
      </p>
    );

  const transitions = diff.data.transitions.filter(
    (transition) => transition.suiteName === suiteName,
  );

  const count = (kind: CaseTransition['kind']) =>
    transitions.filter((transition) => transition.kind === kind).length;

  const listed = LISTED.flatMap((kind) =>
    transitions.flatMap((transition) => (transition.kind === kind ? [{ kind, transition }] : [])),
  );

  const changed = LISTED.flatMap((kind) =>
    count(kind) > 0 ? [`${count(kind)} ${COUNT_WORDS[kind]}`] : [],
  );

  return (
    <>
      <p>
        {changed.length === 0
          ? `No case of ${suiteName} changed since ${shortRunId(baseRunId)}.`
          : `${changed.join(', ')} since ${shortRunId(baseRunId)}.`}{' '}
        {formatCount(count('still_failing'), 'case')} still failing, {count('still_passing')} still
        passing.
      </p>
      {listed.length > 0 && (
        <ul className="attest-alist">
          {listed.map(({ kind, transition }) => (
            <li key={transition.caseId}>
              {kind === 'removed' ? (
                <span className="attest-an">{transition.caseId}</span>
              ) : (
                <Link
                  className="attest-an"
                  to="/projects/$projectKey/evals/$suiteName/runs/$runId/cases/$caseId"
                  params={{ projectKey, suiteName, runId, caseId: transition.caseId }}
                >
                  {transition.caseId}
                </Link>
              )}
              <span className="attest-why">
                {transition.flakiness === 'suspected' ? 'Scores barely moved; may be flaky.' : ''}
              </span>
              <span className={kind === 'regressed' ? 'attest-hot' : 'attest-dim'}>
                {KIND_WORDS[kind]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

/**
 * "Compare with another run", closed by default. Nothing is fetched until it opens; then the
 * whole-run diff against the chosen base is filtered to this eval.
 */
const CompareRuns = ({ earlier, ...scope }: CompareRunsProps) => {
  const [open, setOpen] = useState(false);
  const fallback = earlier.find((slice) => slice.state === 'complete') ?? earlier[0];
  const [chosen, setChosen] = useState<string>();
  const baseRunId = chosen ?? fallback?.runId;

  return (
    <details className="attest-disc" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Compare with another run
        <span className="attest-dim">
          {baseRunId === undefined ? 'No earlier run' : shortRunId(baseRunId)}
        </span>
      </summary>
      {open && (
        <div className="attest-disc-b">
          {baseRunId === undefined ? (
            <p className="attest-dim">
              No earlier finished run of {scope.suiteName} to compare with.
            </p>
          ) : (
            <>
              <label className="attest-field-inline">
                Compare with{' '}
                <select value={baseRunId} onChange={(event) => setChosen(event.target.value)}>
                  {earlier.map((slice) => (
                    <option key={slice.runId} value={slice.runId}>
                      {shortRunId(slice.runId)},{' '}
                      {slice.state === 'complete'
                        ? `${slice.counts.passed} passed`
                        : slice.runStatus === 'cancelled'
                          ? 'cancelled'
                          : 'did not complete'}
                    </option>
                  ))}
                </select>
              </label>
              <Comparison {...scope} baseRunId={baseRunId} />
            </>
          )}
        </div>
      )}
    </details>
  );
};

export { CompareRuns };
