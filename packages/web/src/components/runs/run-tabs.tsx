import { Link } from '@tanstack/react-router';
import type { RunRecord } from '@attest/core/records';
import { z } from 'zod';
import { useRuns } from '../../api/queries.js';
import { useProjectKey } from '../../routes/use-project-key.js';

const runTabSchema = z.enum(['cases', 'distributions', 'suites']);

type RunTab = z.infer<typeof runTabSchema>;

const tabLabels = { cases: 'Cases', distributions: 'Distributions', suites: 'Suites' } as const;

/**
 * Navigation links styled as tabs: each view has its own URL, so tab semantics would promise
 * in-page panels that do not exist. Offers the newest other run as the comparison base.
 */
const RunTabs = ({ run, tab }: { run: RunRecord; tab: RunTab | 'compare' }) => {
  const projectKey = useProjectKey();
  const runsQuery = useRuns(projectKey);
  const baseRun = runsQuery.data?.items.find((item) => item.id !== run.id);

  return (
    <nav className="tabs" aria-label="Run views">
      {runTabSchema.options.map((id) => (
        <Link
          key={id}
          to="/projects/$projectKey/runs/$runId"
          params={{ projectKey, runId: run.id }}
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
          to="/projects/$projectKey/compare/$baseRunId/$candidateRunId"
          params={{ projectKey, baseRunId: baseRun.id, candidateRunId: run.id }}
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
