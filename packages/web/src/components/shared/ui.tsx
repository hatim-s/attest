import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'primary' | 'secondary' | 'ghost';
};

/** Button with tone classes. Defaults to `type="button"` so it never submits a form. */
const Button = ({ className = '', tone = 'secondary', ...props }: ButtonProps) => (
  <button
    className={`button button-${tone} ${className}`}
    type={props.type ?? 'button'}
    {...props}
  />
);

type BadgeProps = { children: ReactNode; tone?: string };

/** Status label styled by the `badge-<tone>` class. */
const Badge = ({ children, tone = 'neutral' }: BadgeProps) => (
  <span className={`badge badge-${tone}`}>{children}</span>
);

/** Full-width alert for a failed query. */
const ErrorNotice = ({ error }: { error: unknown }) => (
  <div className="error-notice" role="alert">
    {error instanceof Error ? error.message : 'Something went wrong.'}
  </div>
);

/** Loading indicator announced as a status region. */
const Loading = ({ label = 'Loading' }: { label?: string }) => (
  <div className="loading" role="status">
    <span className="loading-dot" /> {label}
  </div>
);

export { Badge, Button, ErrorNotice, Loading };
