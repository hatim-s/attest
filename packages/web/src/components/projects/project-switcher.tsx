import type { ProjectRecord } from '@attest/core/records';

/** Project keys start with a letter or digit, so the empty value cannot name a project. */
const ALL_PROJECTS = '';

type ProjectSwitcherProps = {
  projects: ProjectRecord[];
  /** The open project, or `undefined` off project pages. */
  projectKey: string | undefined;
  /** Receives the chosen project key, or `undefined` for "All projects". */
  onSelect: (projectKey: string | undefined) => void;
};

/** Topbar project picker. A catalog with one project has nothing to switch to, so it renders nothing. */
const ProjectSwitcher = ({ projects, projectKey, onSelect }: ProjectSwitcherProps) => {
  if (projects.length <= 1) return null;

  const selected = projects.some((project) => project.key === projectKey)
    ? projectKey
    : ALL_PROJECTS;

  return (
    <select
      aria-label="Project"
      className="project-switcher"
      value={selected}
      onChange={(event) =>
        onSelect(event.target.value === ALL_PROJECTS ? undefined : event.target.value)
      }
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
