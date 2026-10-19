import { Link } from '@tanstack/react-router';
import { useProjects } from '../api/queries.js';
import { ErrorNotice, Heading, Loading } from '../components/shared/ui.js';

/** Lists every project the catalog serves, each linking to its runs. */
const ProjectsPage = () => {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data;

  return (
    <main className="main-content">
      <section className="stack" aria-label="Projects">
        <Heading level={1} eyebrow="Projects" title="Projects" />
        {projectsQuery.isLoading ? <Loading label="Loading projects" /> : null}
        {projectsQuery.error !== null ? <ErrorNotice error={projectsQuery.error} /> : null}
        {projects?.length === 0 ? (
          <div className="empty-compact">
            No projects yet. Run <code>attest projects add &lt;dir&gt;</code> to register one.
          </div>
        ) : null}
        {projects !== undefined && projects.length > 0 ? (
          <ul>
            {projects.map((project) => (
              <li key={project.key}>
                <Link to="/projects/$projectKey/runs" params={{ projectKey: project.key }}>
                  {project.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
};

export { ProjectsPage };
