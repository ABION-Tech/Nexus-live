import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
}

export function Button({ variant = 'primary', size = 'md', className = '', type = 'button', ...rest }: ButtonProps) {
  const cls = `nx-btn nx-btn--${variant} ${size === 'sm' ? 'nx-btn--sm' : ''} ${className}`.trim();
  // A native <button> with no `type` defaults to "submit" — harmless
  // outside a <form>, but Calendar.tsx and RelationshipForm.tsx both use
  // real <form> elements, and any secondary/ghost/Cancel-style Button
  // inside one that didn't explicitly pass type="button" would submit
  // the form instead of running its own onClick. Defaulting here once
  // instead of requiring every call site to remember it; callers that
  // genuinely want a submit button (the real "Save"/"Submit" action in
  // those two forms) still pass type="submit" explicitly and override
  // this default via `rest`/prop order.
  return <button type={type} className={cls} {...rest} />;
}
