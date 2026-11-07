import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="nx-state">
      <div className="nx-state__title">{title}</div>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
