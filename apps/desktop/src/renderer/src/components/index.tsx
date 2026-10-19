// Small shared UI primitives. No UI library; styled by classes in styles/app.css.
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost';
}
export function Button({ variant = 'default', className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`btn btn-${variant} ${className}`} {...rest} />;
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** required: icon-only buttons need an accessible name (also used as tooltip) */
  label: string;
  active?: boolean;
}
export function IconButton({ label, active, className = '', type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={`icon-btn ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      title={label}
      {...rest}
    />
  );
}

/** Colored dot for a node/symbol kind, using --k-<kind> (falls back to muted). */
export function KindDot({ kind }: { kind: string }) {
  return <span className="kind-dot" style={{ background: `var(--k-${kind}, var(--fg-2))` }} aria-hidden />;
}

export interface BadgeProps {
  /** node kind → kind color */
  kind?: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
  children: ReactNode;
}
export function Badge({ kind, tone = 'neutral', children }: BadgeProps) {
  return (
    <span className={`badge badge-${tone}`}>
      {kind && <KindDot kind={kind} />}
      {children}
    </span>
  );
}

export interface TabsProps<T extends string> {
  tabs: { id: T; label: string }[];
  value: T;
  onChange(id: T): void;
}
export function Tabs<T extends string>({ tabs, value, onChange }: TabsProps<T>) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          className={`tab ${t.id === value ? 'is-active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

export interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: ReactNode;
}
export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action}
    </div>
  );
}

/** Small inline error for failed IPC calls. */
export function InlineError({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="inline-error" role="alert">{msg}</div>;
}
