import { Link } from '@tanstack/react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ProjectRecord, RunPage } from '@attest/core/records';
import { useProjects, useRunsForProjects } from '../api/queries.js';
import { Badge, ErrorNotice, Heading, Loading } from '../components/shared/ui.js';
import { formatCount, formatDateTime, formatShortDateTime } from '../lib/format.js';
import { formatPageRunCount, sortByLatestRun } from './project-rows.js';

type ProjectRowProps = { project: ProjectRecord; runs: UseQueryResult<RunPage> };

/** The run columns of one project; its loading and error states stay inside the row. */
const ProjectRunCells = ({ runs }: Pick<ProjectRowProps, 'runs'>) => {
  const page = runs.data;

  if (page === undefined) {
    return (
      <td colSpan={3} className="projects-table-state">
        {runs.error === null ? (
          <Loading label="Loading runs" />
        ) : (
          <ErrorNotice error={runs.error} />
        )}
      </td>
    );
  }

  const latest = page.items[0];
  const summary = page.items.find((run) => run.status !== 'running')?.summary;

  return (
    <>
      <td>{formatPageRunCount(page)}</td>
      <td>
        {latest === undefined ? (
          <span className="projects-table-muted">No runs yet</span>
        ) : (
          <span className="projects-table-latest" title={formatDateTime(latest.createdAt)}>
            {formatShortDateTime(latest.createdAt)}
            <Badge tone={latest.status}>{latest.status}</Badge>
          </span>
        )}
      </td>
      <td>
        {summary === undefined ? (
          <span className="projects-table-muted">—</span>
        ) : (
          `${summary.passedCases} passed · ${summary.failedCases} failed · ${formatCount(summary.errorCases, 'error')}`
        )}
      </td>
    </>
  );
};

const ProjectRow = ({ project, runs }: ProjectRowProps) => (
  <tr>
    <th scope="row">
      <Link to="/projects/$projectKey/runs" params={{ projectKey: project.key }}>
        {project.name}
      </Link>
    </th>
    <td className="projects-table-root" title={project.root}>
      {project.root ?? '—'}
    </td>
    <ProjectRunCells runs={runs} />
  </tr>
);

/** One row per project from its newest runs page, so a slow or failing store holds up only its row. */
const ProjectsTable = ({ projects }: { projects: ProjectRecord[] }) => {
  const runQueries = useRunsForProjects(projects.map((project) => project.key));

  const rows = sortByLatestRun(
    projects.map((project, index) => {
      const runs = runQueries[index];

      if (runs === undefined) throw new Error(`Runs query for project ${project.key} is missing.`);

      return { project, runs, page: runs.data };
    }),
  );

  return (
    <div className="case-table-frame analytics-table-scroll">
      <table className="analytics-table projects-table" aria-label="Projects">
        <thead>
          <tr>
            {['Project', 'Root', 'Runs', 'Latest run', 'Latest finished run'].map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ project, runs }) => (
            <ProjectRow key={project.key} project={project} runs={runs} />
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** Lists every project the catalog serves, newest activity first, each linking to its runs. */
const ProjectsPage = () => {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data;

  return (
    <main className="main-content">
      <section className="stack" aria-label="Projects">
        <Heading
          level={1}
          eyebrow="Dashboard"
          title="Projects"
          meta={projects === undefined ? undefined : formatCount(projects.length, 'project')}
        />
        {projectsQuery.isLoading ? <Loading label="Loading projects" /> : null}
        {projectsQuery.error !== null ? <ErrorNotice error={projectsQuery.error} /> : null}
        {projects?.length === 0 ? (
          <div className="empty-compact">
            No projects yet. Run <code>attest projects add &lt;dir&gt;</code> to register one.
          </div>
        ) : null}
        {projects !== undefined && projects.length > 0 ? (
          <ProjectsTable projects={projects} />
        ) : null}
      </section>
    </main>
  );
};

export { ProjectsPage };
