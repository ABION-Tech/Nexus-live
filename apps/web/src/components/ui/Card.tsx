import type { HTMLAttributes } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export function Card({ interactive, className = '', ...rest }: CardProps) {
  return <div className={`nx-card ${interactive ? 'nx-card--interactive' : ''} ${className}`.trim()} {...rest} />;
}
