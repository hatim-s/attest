import { ShellLink } from './shell-link.js';
import { useCallback, useEffect, useEffectEvent, useId, useState, type ReactNode } from 'react';
import { ShellNavigation, type NavigationProps } from './shell-navigation.js';
import { MobileNavigation } from './mobile-navigation.js';
import type { ShellBreadcrumb } from './navigation.js';
import { useRecents } from './use-recents.js';
import { useTheme } from './use-theme.js';
import '../styles/compact/tokens.css';
import '../styles/compact/shell.css';

type CompactShellProps = Omit<NavigationProps, 'recents'> & {
  /** Ordered ancestors followed by the current page, with human-readable domain names. */
  breadcrumbs: readonly ShellBreadcrumb[];
  children: ReactNode;
};

/** Callback-driven chrome shared by local, cloud and offline report hosts. */
const CompactShell = ({ breadcrumbs, children, ...navigation }: CompactShellProps) => {
  const { theme, cycleTheme } = useTheme();
  const recents = useRecents(navigation.current);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const mainId = useId();

  const props: NavigationProps = {
    ...navigation,
    recents,
    onNavigate: (target) => {
      closeDrawer();
      navigation.onNavigate(target);
    },
    onSourceChange: (id) => {
      closeDrawer();
      navigation.onSourceChange(id);
    },
  };

  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    // Single-key shortcuts leave editors, modifiers and composition alone.
    const editable =
      event.target instanceof Element &&
      event.target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
      );

    if (
      !event.defaultPrevented &&
      !event.repeat &&
      !editable &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.isComposing &&
      event.key === 't'
    ) {
      event.preventDefault();
      cycleTheme();
    }
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => shortcut(event);
    document.addEventListener('keydown', onKeyDown);

    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="attest-compact" data-theme={theme}>
      <a
        className="attest-skip"
        href={`#${mainId}`}
        onClick={(event) => {
          event.preventDefault();
          document.getElementById(mainId)?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="attest-sidebar" aria-label="Workspace navigation">
        <div className="attest-side-head">
          <ShellLink
            className="attest-wordmark"
            hrefFor={navigation.hrefFor}
            onNavigate={props.onNavigate}
            target={{ kind: 'projects', sourceId: navigation.source.id }}
          >
            attest
          </ShellLink>
        </div>
        <ShellNavigation {...props} />
      </aside>
      <div className="attest-workspace">
        <header className="attest-header">
          <button
            className="attest-menu"
            type="button"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            Menu
          </button>
          <nav className="attest-breadcrumbs" aria-label="Breadcrumb">
            <ol>
              {breadcrumbs.map((crumb, index) => (
                <li key={index}>
                  <ShellLink
                    target={crumb.target}
                    hrefFor={navigation.hrefFor}
                    onNavigate={props.onNavigate}
                    current={index === breadcrumbs.length - 1}
                  >
                    {crumb.label}
                  </ShellLink>
                </li>
              ))}
            </ol>
          </nav>
          <button
            type="button"
            className="attest-theme"
            title={`Theme: ${theme}. Switch theme (t)`}
            aria-label={`Theme: ${theme}. Switch theme`}
            onClick={cycleTheme}
          >
            {theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}
          </button>
        </header>
        <main id={mainId} tabIndex={-1} className="attest-content">
          {children}
        </main>
      </div>
      {drawerOpen && (
        <MobileNavigation
          onClose={closeDrawer}
          wordmark={
            <ShellLink
              className="attest-wordmark"
              hrefFor={navigation.hrefFor}
              onNavigate={props.onNavigate}
              target={{ kind: 'projects', sourceId: navigation.source.id }}
            >
              attest
            </ShellLink>
          }
        >
          <ShellNavigation {...props} />
        </MobileNavigation>
      )}
    </div>
  );
};

export { CompactShell, type CompactShellProps };
