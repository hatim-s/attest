import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ApiError } from '@attest/api/client';
import type { CliDiagnostics } from '@attest/core/records';

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

/** What the CLI or the project loader reported. Its message is already the notice's text. */
const DiagnosticsList = ({ diagnostics }: { diagnostics: CliDiagnostics }) => (
  <dl className="error-diagnostics">
    <dt>Code</dt>
    <dd>
      <code>{diagnostics.code}</code>
    </dd>
    {diagnostics.path !== undefined ? (
      <>
        <dt>Path</dt>
        <dd>
          <code>{diagnostics.path}</code>
        </dd>
      </>
    ) : null}
    {diagnostics.hint !== undefined ? (
      <>
        <dt>Hint</dt>
        <dd>{diagnostics.hint}</dd>
      </>
    ) : null}
    {diagnostics.retryable !== undefined ? (
      <>
        <dt>Retry</dt>
        <dd>
          {diagnostics.retryable
            ? 'Yes. A later attempt can succeed.'
            : 'Not until the cause is fixed.'}
        </dd>
      </>
    ) : null}
    {diagnostics.details !== undefined ? (
      <>
        <dt>Details</dt>
        <dd>
          <pre>{JSON.stringify(diagnostics.details, null, 2)}</pre>
        </dd>
      </>
    ) : null}
  </dl>
);

/** Full-width alert for a failed request, with diagnostics when the API sent them. */
const ErrorNotice = ({ error }: { error: unknown }) => (
  <div className="error-notice" role="alert">
    {error instanceof Error ? error.message : 'Something went wrong.'}
    {error instanceof ApiError && error.details !== undefined ? (
      <DiagnosticsList diagnostics={error.details} />
    ) : null}
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
