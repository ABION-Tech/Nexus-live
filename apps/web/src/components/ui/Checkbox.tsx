import type { InputHTMLAttributes } from 'react';

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export function Checkbox({ label, id, className = '', ...rest }: CheckboxProps) {
  const checkId = id ?? rest.name;
  return (
    <label className={`nx-checkbox ${className}`.trim()} htmlFor={checkId}>
      <input id={checkId} type="checkbox" {...rest} />
      {label}
    </label>
  );
}
