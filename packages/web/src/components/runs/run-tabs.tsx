import { Link } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { z } from 'zod';
import { useRuns } from '../../api/queries.js';

const runTabSchema = z.enum(['cases', 'distributions', 'suites']);

type RunTab = z.infer<typeof runTabSchema>;

const tabLabels = { cases: 'Cases', distributions: 'Distributions', suites: 'Suites' } as const;

/**
 * Navigation links styled as tabs: each view has its own URL, so tab semantics would promise
 * in-page panels that do not exist. Offers the newest other run as the comparison base.
 */
const RunTabs = ({ run, tab }: { run: RunRecord; tab: RunTab | 'compare' }) => {
  const runsQuery = useRuns();
  const baseRun = runsQuery.data?.find((item) => item.id !== run.id);

  return (
    <nav className="tabs" aria-label="Run views">
      {runTabSchema.options.map((id) => (
        <Link
          key={id}
          to="/runs/$runId"
          params={{ runId: run.id }}
          search={(previous) => ({ ...previous, tab: id })}
          aria-current={tab === id ? 'page' : undefined}
          className="tab"
        >
          {tabLabels[id]}
          {id === 'cases' ? <span>{run.summary?.totalCases ?? 0}</span> : null}
        </Link>
      ))}
      {baseRun !== undefined ? (
        <Link
          to="/compare/$baseRunId/$candidateRunId"
          params={{ baseRunId: baseRun.id, candidateRunId: run.id }}
          search={(previous) => previous}
          aria-current={tab === 'compare' ? 'page' : undefined}
          className="tab"
        >
          Compare
        </Link>
      ) : null}
    </nav>
  );
};

export { RunTabs, runTabSchema };
