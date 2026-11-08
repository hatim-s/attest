import { Link } from '@tanstack/react-router';
import type { EvalSlice } from '@attest/core/records';
import { RunLifecycle } from '../../components/marks/run-lifecycle.js';
import { ProportionMeter } from '../../components/meters/proportion-meter.js';
import { formatStarted, shortRunId } from '../../lib/format.js';

type EvalRunsTableProps = {
  projectKey: string;
  suiteName: string;
  runs: readonly EvalSlice[];
  /** Reads the hovered or focused row out in the chart above; undefined when none is. */
  onInspect: (runId: string | undefined) => void;
};

/**
 * One row per run of the eval, newest first. Rows use counts only: the meter shows proportions
 * and never implies which case failed. Lifecycle shows only when the run did not complete.
 */
const EvalRunsTable = ({ projectKey, suiteName, runs, onInspect }: EvalRunsTableProps) => (
  <table className="attest-table">
    <caption className="attest-sr-only">Runs of {suiteName}, newest first</caption>
    <thead>
      <tr>
        <th scope="col">Run</th>
        <th scope="col">Cases</th>
        <th scope="col" className="attest-num">
          Failed
        </th>
        <th scope="col" className="attest-hide-narrow">
          Started
        </th>
      </tr>
    </thead>
    <tbody onMouseLeave={() => onInspect(undefined)}>
      {runs.map((slice) => {
        const failed = slice.counts.failed + slice.counts.errored;

        return (
          <tr
            key={slice.runId}
            onMouseEnter={() => onInspect(slice.runId)}
            onFocus={() => onInspect(slice.runId)}
            onBlur={() => onInspect(undefined)}
          >
            <td className="attest-nw">
              <Link
                className="attest-rowlink attest-mono"
                to="/projects/$projectKey/evals/$suiteName/runs/$runId"
                params={{ projectKey, suiteName, runId: slice.runId }}
                title={slice.runId}
              >
                {shortRunId(slice.runId)}
              </Link>{' '}
              <RunLifecycle status={slice.runStatus} />
            </td>
            <td>
              <ProportionMeter counts={slice.counts} label={`Run ${shortRunId(slice.runId)}`} />
            </td>
            <td className={`attest-num ${failed > 0 ? 'attest-hot' : 'attest-dim'}`}>{failed}</td>
            <td className="attest-nw attest-dim attest-hide-narrow">
              {formatStarted(slice.createdAt)}
            </td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

export { EvalRunsTable };
