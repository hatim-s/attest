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

type HeadingProps = {
  level: 1 | 2;
  eyebrow: string;
  title: ReactNode;
  meta?: ReactNode;
  /** Status or controls, placed on the right of the title. */
  children?: ReactNode;
};

const Heading = ({ level, eyebrow, title, meta, children }: HeadingProps) => {
  const Title = level === 1 ? 'h1' : 'h2';

  return (
    <header className={`heading heading-${level}`}>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <Title>{title}</Title>
        {meta !== undefined ? <p className="heading-meta">{meta}</p> : null}
      </div>
      {children}
    </header>
  );
};

/** Full-width alert for a failed query. */
const ErrorNotice = ({ error }: { error: unknown }) => (
  <div className="error-notice" role="alert">
    {error instanceof Error ? error.message : 'Something went wrong.'}
  </div>
);

/** Loading indicator announced as a status region. */
const Loading = ({ label = 'Loading' }: { label?: string }) => (
  <div className="loading" role="status">
    <span className="loading-dot" />
    {label}
  </div>
);

export { Badge, Button, ErrorNotice, Heading, Loading };
