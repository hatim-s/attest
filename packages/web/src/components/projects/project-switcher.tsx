import { useNavigate } from '@tanstack/react-router';
import type { ProjectRecord } from '@attest/core/records';

/** Project keys start with a letter or digit, so the empty value cannot name a project. */
const ALL_PROJECTS = '';

type ProjectSwitcherProps = {
  projects: ProjectRecord[];
  /** The open project, or `undefined` off project pages. */
  projectKey: string | undefined;
};

/**
 * Topbar project picker. Branch and label filters belong to the project being left, so switching
 * opens the other project's runs without them. A catalog with one project renders nothing.
 */
const ProjectSwitcher = ({ projects, projectKey }: ProjectSwitcherProps) => {
  const navigate = useNavigate();

  if (projects.length <= 1) return null;

  const selected = projects.some((project) => project.key === projectKey)
    ? projectKey
    : ALL_PROJECTS;

  return (
    <select
      aria-label="Project"
      className="project-switcher"
      value={selected}
      onChange={(event) => {
        const key = event.target.value;

        void navigate(
          key === ALL_PROJECTS
            ? { to: '/projects' }
            : { to: '/projects/$projectKey/runs', params: { projectKey: key }, search: {} },
        );
      }}
    >
      <option value={ALL_PROJECTS}>All projects</option>
      {projects.map((project) => (
        <option key={project.key} value={project.key}>
          {project.name}
        </option>
      ))}
    </select>
  );
};

export { ProjectSwitcher };
