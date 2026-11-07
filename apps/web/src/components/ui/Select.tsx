import type { SelectHTMLAttributes } from 'react';

export interface SelectOption { value: string; label: string; }

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
}

export function Select({ label, error, options, placeholder, id, className = '', ...rest }: SelectProps) {
  const selectId = id ?? rest.name;
  return (
    <div className="nx-field">
      {label && <label className="nx-field__label" htmlFor={selectId}>{label}</label>}
      <select id={selectId} className={`nx-select ${error ? 'nx-select--error' : ''} ${className}`.trim()} {...rest}>
        {placeholder && <option value="" disabled>{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error && <span className="nx-field__error">{error}</span>}
    </div>
  );
}
