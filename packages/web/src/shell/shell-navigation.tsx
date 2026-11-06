import {
  targetKey,
  type RecentLabel,
  type RecentTarget,
  type ShellProject,
  type ShellSource,
  type ShellTarget,
} from './navigation.js';

type NavigationProps = {
  source: ShellSource;
  sources: readonly ShellSource[];
  projects: readonly ShellProject[];
  current: ShellTarget;
  recents: readonly RecentTarget[];
  resolveRecent: (target: RecentTarget) => RecentLabel | undefined;
  onNavigate: (target: ShellTarget) => void;
  onSourceChange: (sourceId: string) => void;
};

/** The open project owns the eval list; only the open eval expands its two views. */
const ShellNavigation = ({
  source,
  sources,
  projects,
  current,
  recents,
  resolveRecent,
  onNavigate,
  onSourceChange,
}: NavigationProps) => {
  const item = (target: ShellTarget, label: string) => (
    <button
      type="button"
      className="attest-nav-item"
      aria-current={targetKey(target) === targetKey(current) ? 'page' : undefined}
      onClick={() => onNavigate(target)}
    >
      {label}
    </button>
  );

  return (
    <>
      <nav className="attest-tree" aria-label="Projects">
        <ul>
          <li>{item({ kind: 'projects', sourceId: source.id }, 'All projects')}</li>
          {projects.map((project) => {
            const open = current.kind !== 'projects' && current.projectKey === project.key;

            return (
              <li key={project.key}>
                {item(
                  { kind: 'project', sourceId: source.id, projectKey: project.key },
                  project.name,
                )}
                {open && (
                  <ul>
                    {project.evals.map((evaluation) => {
                      const selected =
                        current.kind !== 'project' && current.evalId === evaluation.id;

                      const scope = {
                        sourceId: source.id,
                        projectKey: project.key,
                        evalId: evaluation.id,
                      };

                      return (
                        <li key={evaluation.id}>
                          <button
                            type="button"
                            className="attest-nav-item"
                            data-in-path={selected || undefined}
                            onClick={() => onNavigate({ ...scope, kind: 'runs' })}
                          >
                            {evaluation.name}
                          </button>
                          {selected && (
                            <ul>
                              <li>{item({ ...scope, kind: 'runs' }, 'Runs')}</li>
                              <li>{item({ ...scope, kind: 'cases' }, 'Test cases')}</li>
                            </ul>
                          )}
                        </li>
                      );
                    })}
                    {project.evals.length === 0 && (
                      <li className="attest-nav-note">No evals yet</li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {projects.length === 0 && <p className="attest-nav-note">No projects yet</p>}
      </nav>
      <section className="attest-recents" aria-label="Recent pages">
        <h2>Recent</h2>
        <ul>
          {recents.map((target) => {
            const text = resolveRecent(target);

            return (
              text && (
                <li key={targetKey(target)}>
                  <button
                    type="button"
                    className="attest-nav-item"
                    title={text.context}
                    aria-label={`${text.label}, ${text.context}`}
                    onClick={() => onNavigate(target)}
                  >
                    {text.label}
                  </button>
                </li>
              )
            );
          })}
        </ul>
        {!recents.some((target) => resolveRecent(target)) && (
          <p className="attest-nav-note">Runs and cases you open show up here.</p>
        )}
      </section>
      <footer className="attest-side-footer">
        {sources.length > 1 ? (
          <div className="attest-sources" role="group" aria-label="Data source">
            {sources.map((available) => (
              <button
                type="button"
                key={available.id}
                aria-pressed={available.id === source.id}
                title={available.capabilities.control ? 'Can start and cancel runs' : 'Read only'}
                aria-label={`${available.label}, ${available.capabilities.control ? 'can start and cancel runs' : 'read only'}`}
                onClick={() => onSourceChange(available.id)}
              >
                {available.label}
              </button>
            ))}
          </div>
        ) : (
          <span title={source.capabilities.control ? 'Can start and cancel runs' : 'Read only'}>
            {source.label}
            <span className="attest-sr-only">
              {source.capabilities.control ? ', can start and cancel runs' : ', read only'}
            </span>
          </span>
        )}
      </footer>
    </>
  );
};

export { ShellNavigation, type NavigationProps };
