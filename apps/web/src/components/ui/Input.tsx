import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, className = '', ...rest }: InputProps) {
  const inputId = id ?? rest.name;
  return (
    <div className="nx-field">
      {label && <label className="nx-field__label" htmlFor={inputId}>{label}</label>}
      <input id={inputId} className={`nx-input ${error ? 'nx-input--error' : ''} ${className}`.trim()} {...rest} />
      {error && <span className="nx-field__error">{error}</span>}
    </div>
  );
}
