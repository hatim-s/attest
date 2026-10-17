import { useEffect, useState } from 'react';
import { useApiClient } from '../api/api-client-context.js';
import { Badge, Button } from '../components/shared/ui.js';
import { Outlet } from '@tanstack/react-router';

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
            <span>local evaluations</span>
          </div>
        </div>
        <div className="topbar-actions">
          <Badge tone="local">{mode.kind === 'live' ? '127.0.0.1' : 'static report'}</Badge>
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
