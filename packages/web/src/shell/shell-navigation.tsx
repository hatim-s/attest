import { ShellLink } from './shell-link.js';
import { visibleRecents } from './preferences.js';
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
  /** Undefined while the source catalogue is loading. */
  projects: readonly ShellProject[] | undefined;
  hrefFor: (target: ShellTarget) => string;
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
  hrefFor,
  onNavigate,
  onSourceChange,
}: NavigationProps) => {
  const item = (target: ShellTarget, label: string, inPath = false) => (
    <ShellLink
      target={target}
      hrefFor={hrefFor}
      onNavigate={onNavigate}
      className="attest-nav-item"
      inPath={inPath}
      current={targetKey(target) === targetKey(current)}
    >
      {label}
    </ShellLink>
  );

  const recentRows = visibleRecents(recents, resolveRecent);

  return (
    <>
      <nav className="attest-tree" aria-label="Projects">
        <ul>
          <li>{item({ kind: 'projects', sourceId: source.id }, 'All projects')}</li>
          {projects?.map((project) => {
            const open = current.kind !== 'projects' && current.projectKey === project.key;

            return (
              <li key={project.key}>
                {item(
                  { kind: 'project', sourceId: source.id, projectKey: project.key },
                  project.name,
                  open,
                )}
                {open && (
                  <ul>
                    <li>
                      {item(
                        { kind: 'project-runs', sourceId: source.id, projectKey: project.key },
                        'All runs',
                        current.kind === 'project-run' || current.kind === 'project-run-case',
                      )}
                    </li>
                    {project.evals === undefined && (
                      <li className="attest-nav-note" role="status">
                        Loading evals...
                      </li>
                    )}
                    {project.evals?.map((evaluation) => {
                      const selected = 'evalId' in current && current.evalId === evaluation.id;

                      const scope = {
                        sourceId: source.id,
                        projectKey: project.key,
                        evalId: evaluation.id,
                      };

                      return (
                        <li key={evaluation.id}>
                          <ShellLink
                            target={{ ...scope, kind: 'runs' }}
                            hrefFor={hrefFor}
                            onNavigate={onNavigate}
                            className="attest-nav-item"
                            inPath={selected}
                          >
                            {evaluation.name}
                          </ShellLink>
                          {selected && (
                            <ul>
                              <li>
                                {item(
                                  { ...scope, kind: 'runs' },
                                  'Runs',
                                  current.kind === 'run' || current.kind === 'run-case',
                                )}
                              </li>
                              <li>
                                {item(
                                  { ...scope, kind: 'cases' },
                                  'Test cases',
                                  current.kind === 'case',
                                )}
                              </li>
                            </ul>
                          )}
                        </li>
                      );
                    })}
                    {project.evals?.length === 0 && (
                      <li className="attest-nav-note">No evals yet</li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {projects === undefined && (
          <p className="attest-nav-note" role="status">
            Loading projects...
          </p>
        )}
        {projects?.length === 0 && <p className="attest-nav-note">No projects yet</p>}
      </nav>
      <section className="attest-recents" aria-label="Recent pages">
        <h2>Recent</h2>
        <ul>
          {recentRows.map(({ target, text }) => (
            <li key={targetKey(target)}>
              <ShellLink
                target={target}
                hrefFor={hrefFor}
                onNavigate={onNavigate}
                className="attest-nav-item"
                title={text.context}
                label={`${text.label}, ${text.context}`}
              >
                {text.label}
              </ShellLink>
            </li>
          ))}
        </ul>
        {recentRows.length === 0 && (
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
