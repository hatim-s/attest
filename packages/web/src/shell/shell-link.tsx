import type { ReactNode } from 'react';
import type { ShellTarget } from './navigation.js';

type ShellLinkProps = {
  target: ShellTarget;
  hrefFor: (target: ShellTarget) => string;
  onNavigate: (target: ShellTarget) => void;
  children: ReactNode;
  className?: string;
  inPath?: boolean;
  current?: boolean;
  title?: string;
  label?: string;
};

/** Keep native link actions; the host router handles only ordinary primary activation. */
const ShellLink = ({
  target,
  hrefFor,
  onNavigate,
  children,
  className,
  inPath,
  current,
  title,
  label,
}: ShellLinkProps) => (
  <a
    href={hrefFor(target)}
    className={className}
    data-in-path={inPath || undefined}
    aria-current={current ? 'page' : undefined}
    title={title}
    aria-label={label}
    onClick={(event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      onNavigate(target);
    }}
  >
    {children}
  </a>
);

export { ShellLink };
