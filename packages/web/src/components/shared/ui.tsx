import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'primary' | 'secondary' | 'ghost';
};

/** Shared shadcn-style button primitive with consistent focus and disabled states. */
const Button = ({ className = '', tone = 'secondary', ...props }: ButtonProps) => (
  <button
    className={`button button-${tone} ${className}`}
    type={props.type ?? 'button'}
    {...props}
  />
);

/** Shared surface primitive used for summary and detail groupings. */
const Card = ({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={`card ${className}`} {...props} />
);

type BadgeProps = { children: ReactNode; tone?: string };

/** Renders compact semantic status labels without coupling callers to color classes. */
const Badge = ({ children, tone = 'neutral' }: BadgeProps) => (
  <span className={`badge badge-${tone}`}>{children}</span>
);

/** Provides a consistent full-width async failure state. */
const ErrorNotice = ({ error }: { error: unknown }) => (
  <div className="error-notice" role="alert">
    {error instanceof Error ? error.message : 'Something went wrong.'}
  </div>
);

/** Provides a compact loading state announced to assistive technologies. */
const Loading = ({ label = 'Loading' }: { label?: string }) => (
  <div className="loading" role="status">
    <span className="loading-dot" /> {label}
  </div>
);

export { Badge, Button, Card, ErrorNotice, Loading, type ButtonProps };
