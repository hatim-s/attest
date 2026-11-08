import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProjectOverviewEntry } from '@attest/api/contract';
import { useDashboardSource } from '../../api/api-client-context.js';
import type { DashboardSource } from '../../api/dashboard-source.js';
import { overviewsQueryOptions } from '../../api/queries/projects.js';
import { EmptyState } from '../../components/empty/empty-state.js';
import { formatCount } from '../../lib/format.js';
import { DirectoryRow } from './directory-row.js';
import '../../styles/compact/pages.css';

const WHERE = { local: 'on this machine', cloud: 'in this workspace', report: 'in this report' };

/** The commands that add a project differ by host; a report always has exactly one. */
const WELCOME = {
  local: {
    description:
      'A project shows up here once it is registered. Run attest init in a new project, or attest projects add <dir> for one that already has a manifest.',
    command: 'attest init',
  },
  cloud: {
    description: 'A project shows up here after its first revision is pushed from the CLI.',
    command: 'attest cloud push',
  },
} satisfies Record<
  Exclude<DashboardSource['kind'], 'report'>,
  { description: string; command: string }
>;

/** Matches the filter against what the row shows: name, key and local root. */
const matches = (entry: ProjectOverviewEntry, query: string) =>
  [entry.project.name, entry.project.key, entry.project.root ?? ''].some((value) =>
    value.toLowerCase().includes(query),
  );

/** All projects: find one and open it. Each row reads only the precomputed overview. */
const DirectoryPage = () => {
  const source = useDashboardSource();
  const overviews = useQuery(overviewsQueryOptions(source));
  const [filter, setFilter] = useState('');
  const filterId = useId();

  if (overviews.data === undefined) {
    return overviews.error === null ? (
      <p className="attest-loading" role="status">
        Loading projects...
      </p>
    ) : (
      <EmptyState
        title="Could not load projects"
        description={overviews.error.message}
        action={{ label: 'Try again', onAction: () => void overviews.refetch() }}
      />
    );
  }

  const entries = overviews.data.items;

  if (entries.length === 0 && source.kind !== 'report') {
    return <EmptyState title="No projects yet" {...WELCOME[source.kind]} />;
  }

  const query = filter.trim().toLowerCase();
  const visible = entries.filter((entry) => matches(entry, query));

  return (
    <>
      <div className="attest-page-head">
        <div className="attest-page-title">
          <h1>Projects</h1>
          <p className="attest-sub">
            {formatCount(entries.length, 'project')} {WHERE[source.kind]}
          </p>
        </div>
        <div className="attest-page-end">
          <label className="attest-sr-only" htmlFor={filterId}>
            Find a project
          </label>
          <input
            id={filterId}
            className="attest-search"
            type="search"
            placeholder="Find a project"
            autoComplete="off"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </div>
      <section className="attest-card" aria-label="Projects">
        <table className="attest-table">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col" className="attest-num attest-hide-narrow">
                Evals
              </th>
              <th scope="col">Latest results</th>
              <th scope="col" className="attest-hide-narrow">
                Last run
              </th>
              <th scope="col" className="attest-go">
                <span className="attest-sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => (
              <DirectoryRow key={entry.project.key} entry={entry} />
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <div className="attest-nores" role="status">
                    <span>No projects match</span>
                    <button
                      type="button"
                      className="attest-chip-x"
                      aria-label={`Remove filter "${filter.trim()}"`}
                      onClick={() => setFilter('')}
                    >
                      &quot;{filter.trim()}&quot;<span aria-hidden="true">&times;</span>
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
};

export { DirectoryPage };
