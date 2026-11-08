import { Link } from '@tanstack/react-router';
import type { EvalPage, EvalSlice } from '@attest/core/records';
import { StatusMark, type StatusTone } from '../../components/marks/status-mark.js';
import { formatPercent, formatStarted } from '../../lib/format.js';

type LatestPhrase = { text: string; tone: StatusTone | 'none' };

/**
 * The latest slice in a few words. Lifecycle comes first: a running, failed or cancelled run has
 * no verdict to report. Only a finished slice reports failures.
 */
const latestPhrase = (latest: EvalSlice): LatestPhrase => {
  if (latest.state === 'running') return { text: 'Running', tone: 'running' };

  if (latest.runStatus === 'failed') return { text: 'Run failed', tone: 'run-failed' };

  if (latest.runStatus === 'cancelled') return { text: 'Cancelled', tone: 'stopped' };

  const { failed, errored } = latest.counts;

  if (failed + errored > 0)
    return {
      text: `${failed + errored} ${errored > 0 ? 'failed or errored' : 'failed'}`,
      tone: 'failing',
    };

  if (latest.state === 'incomplete') return { text: 'Incomplete', tone: 'none' };

  return { text: 'All passed', tone: 'passing' };
};

/**
 * One row per eval with a recorded run. Pass rate is from the newest complete slice; a project
 * whose only slices are partial shows none. Rows open the eval's Runs tab.
 */
const EvalsTable = ({ projectKey, evals }: { projectKey: string; evals: EvalPage }) => (
  <section className="attest-card" aria-label="Evals">
    <table className="attest-table">
      <thead>
        <tr>
          <th scope="col">Eval</th>
          <th scope="col">Latest run</th>
          <th scope="col" className="attest-num">
            Pass rate
          </th>
          <th scope="col" className="attest-hide-narrow">
            Started
          </th>
        </tr>
      </thead>
      <tbody>
        {evals.items.map(({ suiteName, latest, latestComplete }) => {
          const phrase = latestPhrase(latest);

          return (
            <tr key={suiteName}>
              <td>
                <Link
                  className="attest-rowlink"
                  to="/projects/$projectKey/evals/$suiteName/runs"
                  params={{ projectKey, suiteName }}
                >
                  {suiteName}
                </Link>
              </td>
              <td className="attest-nw">
                <span className="attest-status" data-tone={phrase.tone}>
                  {phrase.tone !== 'none' && <StatusMark tone={phrase.tone} />}
                  {phrase.text}
                </span>
              </td>
              <td className="attest-num">
                {latestComplete?.state === 'complete' ? formatPercent(latestComplete.passRate) : ''}
              </td>
              <td className="attest-nw attest-dim attest-hide-narrow">
                {formatStarted(latest.createdAt)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    {evals.nextCursor !== undefined && (
      <p className="attest-panel-note">Showing the first {evals.items.length} evals.</p>
    )}
  </section>
);

export { EvalsTable };
