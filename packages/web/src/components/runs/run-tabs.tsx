import { Link } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { z } from 'zod';
import { useRuns } from '../../api/queries.js';

const runTabSchema = z.enum(['cases', 'distributions', 'suites']);

type RunTab = z.infer<typeof runTabSchema>;

const tabLabels = { cases: 'Cases', distributions: 'Distributions', suites: 'Suites' } as const;

/** Offers the newest other run as the comparison base, so Compare is one click from any tab. */
const RunTabs = ({ run, tab }: { run: RunRecord; tab: RunTab | 'compare' }) => {
  const runsQuery = useRuns();
  const baseRun = runsQuery.data?.find((item) => item.id !== run.id);

  return (
    <div className="tabs" role="tablist">
      {runTabSchema.options.map((id) => (
        <Link
          key={id}
          to="/runs/$runId"
          params={{ runId: run.id }}
          search={(previous) => ({ ...previous, tab: id })}
          role="tab"
          aria-selected={tab === id}
          className={`button button-${tab === id ? 'primary' : 'ghost'}`}
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
          role="tab"
          aria-selected={tab === 'compare'}
          className={`button button-${tab === 'compare' ? 'primary' : 'ghost'}`}
        >
          Compare
        </Link>
      ) : null}
    </div>
  );
};

export { RunTabs, runTabSchema };
