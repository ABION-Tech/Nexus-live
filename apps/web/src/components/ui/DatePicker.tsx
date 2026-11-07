import type { InputHTMLAttributes } from 'react';

// Native <input type="date"> wrapper — matches the Input field shell for
// visual consistency. A calendar-popover picker is a v2 upgrade if the
// native control proves too limited in practice; not worth building now.
export interface DatePickerProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  error?: string;
}

export function DatePicker({ label, error, id, className = '', ...rest }: DatePickerProps) {
  const inputId = id ?? rest.name;
  return (
    <div className="nx-field">
      {label && <label className="nx-field__label" htmlFor={inputId}>{label}</label>}
      <input id={inputId} type="date" className={`nx-input ${error ? 'nx-input--error' : ''} ${className}`.trim()} {...rest} />
      {error && <span className="nx-field__error">{error}</span>}
    </div>
  );
}
