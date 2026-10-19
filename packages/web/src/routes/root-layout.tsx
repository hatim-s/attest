import { Link, Outlet, useLocation, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useApiClient } from '../api/api-client-context.js';
import { useProjects } from '../api/queries.js';
import { ProjectSwitcher } from '../components/projects/project-switcher.js';
import { Badge, Button } from '../components/shared/ui.js';

type Theme = 'light' | 'dark';

const getInitialTheme = (): Theme => {
  let stored: string | null = null;

  try {
    stored = localStorage.getItem('attest-theme');
  } catch {
    // Some browsers disable local storage for file:// reports; system preference remains safe.
  }

  if (stored === 'light' || stored === 'dark') return stored;

  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

/** Keeps theme state alive while navigation changes the selected evidence. */
const RootLayout = () => {
  const { mode } = useApiClient();
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const { projectKey } = useParams({ strict: false });
  const projects = useProjects().data ?? [];
  const project = projects.find((item) => item.key === projectKey);

  // Comparisons belong to Runs even though their URL sits outside /runs.
  const section = useLocation({
    select: (location) => (/^\/projects\/[^/]+\/evals/.test(location.pathname) ? 'evals' : 'runs'),
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;

    try {
      localStorage.setItem('attest-theme', theme);
    } catch {
      /* File reports can apply the theme even when storage is unavailable. */
    }
  }, [theme]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <div>
            <strong>attest</strong>
            <span>{projectKey === undefined ? 'evaluations' : project?.name}</span>
          </div>
        </div>
        <div className="topbar-actions">
          <ProjectSwitcher projects={projects} projectKey={projectKey} />
          {projectKey === undefined ? null : (
            <nav className="topbar-nav" aria-label="Dashboard">
              <Link
                to="/projects/$projectKey/runs"
                params={{ projectKey }}
                search={({ branch, label }) => ({ branch, label })}
                aria-current={section === 'runs' ? 'page' : undefined}
              >
                Runs
              </Link>
              <Link
                to="/projects/$projectKey/evals"
                params={{ projectKey }}
                search={({ branch, label }) => ({ branch, label })}
                aria-current={section === 'evals' ? 'page' : undefined}
              >
                Evals
              </Link>
            </nav>
          )}
          {mode.kind === 'snapshot' ? <Badge tone="local">Static report</Badge> : null}
          <Button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} tone="ghost">
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </Button>
        </div>
      </header>
      <Outlet />
    </div>
  );
};

export { RootLayout };
