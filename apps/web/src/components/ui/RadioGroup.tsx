export interface RadioOption { value: string; label: string; }

export interface RadioGroupProps {
  name: string;
  options: RadioOption[];
  value?: string;
  onChange?: (value: string) => void;
  label?: string;
}

export function RadioGroup({ name, options, value, onChange, label }: RadioGroupProps) {
  return (
    <div className="nx-field">
      {label && <span className="nx-field__label">{label}</span>}
      <div className="nx-radio-group">
        {options.map((o) => (
          <label key={o.value} className="nx-radio">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange?.(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}
