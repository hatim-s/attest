import type { ReactNode } from 'react';
import { ShellLink } from './shell-link.js';
import { visibleRecents } from './preferences.js';
import {
  targetKey,
  type RecentLabel,
  type RecentTarget,
  isProjectWide,
  type ShellProject,
  type ShellEval,
  type NavigationData,
  type ShellSource,
  type ShellTarget,
} from './navigation.js';

type NavigationProps = {
  source: ShellSource;
  sources: readonly ShellSource[];
  projects: { sourceId: string; state: NavigationData<ShellProject> };
  /** Retained query data must carry its owner; null when no project is expanded. */
  evals: {
    sourceId: string;
    projectKey: string;
    state: NavigationData<ShellEval>;
  } | null;

  hrefFor: (target: ShellTarget) => string;
  current: ShellTarget;
  recents: readonly RecentTarget[];
  resolveRecent: (target: RecentTarget) => RecentLabel | undefined;
  onNavigate: (target: ShellTarget) => void;
  onSourceChange: (sourceId: string) => void;
};

/** A square for a failing verdict, a ring while running; the word is for assistive technology. */
const NavMark = ({ mark }: { mark: 'failing' | 'running' }) => (
  <span className="attest-nav-mark" data-mark={mark}>
    <span className="attest-sr-only">, {mark}</span>
  </span>
);

/** The open project owns the eval list; only the open eval expands its two views. */
const ShellNavigation = ({
  source,
  sources,
  projects,
  evals,
  current,
  recents,
  resolveRecent,
  hrefFor,
  onNavigate,
  onSourceChange,
}: NavigationProps) => {
  const item = (target: ShellTarget, label: ReactNode, inPath = false) => (
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

  const dataNote = <T,>(data: NavigationData<T>, noun: string) => {
    if (data.status === 'ready')
      return data.items.length === 0 ? <p className="attest-nav-note">No {noun} yet</p> : null;

    return (
      <p className="attest-nav-note" role="status">
        {data.status === 'loading' ? `Loading ${noun}...` : data.message}
        {data.status === 'error' && data.retry && (
          <>
            {' '}
            <button type="button" onClick={data.retry}>
              Retry {noun}
            </button>
          </>
        )}
      </p>
    );
  };

  const projectData: NavigationData<ShellProject> =
    projects.sourceId === source.id ? projects.state : { status: 'loading' };

  const recentRows = visibleRecents(
    recents.filter((target) => target.sourceId === source.id),
    resolveRecent,
  );

  return (
    <>
      <nav className="attest-tree" aria-label="Projects">
        <ul>
          <li>{item({ kind: 'projects', sourceId: source.id }, 'All projects')}</li>
          {projectData.status === 'ready' &&
            projectData.items.map((project) => {
              const open =
                current.sourceId === source.id &&
                current.kind !== 'projects' &&
                current.projectKey === project.key;

              const projectEvals =
                evals?.sourceId === source.id && evals.projectKey === project.key
                  ? evals.state
                  : undefined;

              const evalNote = projectEvals && dataNote(projectEvals, 'evals');

              return (
                <li key={project.key}>
                  {item(
                    { kind: 'project', sourceId: source.id, projectKey: project.key },
                    <>
                      {project.name}
                      {!open && project.failing && <NavMark mark="failing" />}
                    </>,
                    open && current.kind !== 'project',
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
                      {evalNote && <li>{evalNote}</li>}
                      {projectEvals?.status === 'ready' &&
                        projectEvals.items.map((evaluation) => {
                          const selected =
                            !isProjectWide(current) &&
                            'evalId' in current &&
                            current.evalId === evaluation.id;

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
                                {evaluation.mark && <NavMark mark={evaluation.mark} />}
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
                    </ul>
                  )}
                </li>
              );
            })}
        </ul>
        {dataNote(projectData, 'projects')}
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
