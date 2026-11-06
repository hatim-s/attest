import { useId, type ReactNode } from 'react';
import '../../styles/compact/empty.css';

type EmptyStateProps = {
  title: string;
  description: string;
  /** Only supply an action when the current host supports it. */
  action?: { label: string; onAction: () => void };
  /** Optional authored CLI command, never constructed from an assumed endpoint. */
  command?: string;
  children?: ReactNode;
};

/** Explain the missing content and give the next available step without invented data. */
const EmptyState = ({ title, description, action, command, children }: EmptyStateProps) => {
  const titleId = useId();

  return (
    <section className="attest-empty" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <p>{description}</p>
      {command && (
        <pre>
          <code>{command}</code>
        </pre>
      )}
      {action && (
        <button type="button" onClick={action.onAction}>
          {action.label}
        </button>
      )}
      {children}
    </section>
  );
};

export { EmptyState, type EmptyStateProps };
