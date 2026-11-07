import { useState, type FormEvent } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select, type SelectOption } from '../ui/Select';
import { Checkbox } from '../ui/Checkbox';
import { DatePicker } from '../ui/DatePicker';

export type FieldType = 'text' | 'email' | 'tel' | 'number' | 'date' | 'select' | 'checkbox' | 'textarea';

export interface FieldSchema<T> {
  key: keyof T & string;
  label: string;
  type: FieldType;
  options?: SelectOption[]; // required when type === 'select'
  required?: boolean;
  // Only sendable on create (e.g. NetworkCos.state — the table's natural
  // ID, not accepted by PATCH /network/cos/:id at all). Hidden entirely
  // in edit mode rather than shown-and-ignored, which would silently
  // mislead someone into thinking they changed it.
  createOnly?: boolean;
  // Matches a real backend restriction — e.g. routes/network.ts strips
  // `documentStatus`/`assignedToUserId` from a non-leader's own-record
  // Partnership update. Rendered disabled (visible, not editable) for a
  // non-leader rather than hidden, since it's still real information
  // about the record.
  leaderOnly?: boolean;
}

export interface RelationshipFormProps<T> {
  schema: FieldSchema<T>[];
  initialValues: Partial<T>;
  mode: 'create' | 'edit';
  isLeader: boolean;
  saving?: boolean;
  submitLabel?: string;
  onCancel: () => void;
  // Loose on purpose: the values collected here don't line up 1:1 with
  // T (T includes server-assigned fields like id/orgId/createdAt this
  // form never touches, and each entity's real *Input type — CosInput,
  // PartnershipInput, OrgContactInput, all in services/networkService.ts
  // — has its own required/optional split that doesn't match
  // Partial<T> either). Callers cast to whichever *Input type their
  // create/update call actually expects.
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
  // Rendered between the fields and the action row — e.g. Partnerships'
  // "Archive" button, which only makes sense in edit mode and isn't
  // itself a form field.
  extraActions?: React.ReactNode;
}

// PRD §8.3 — one form implementation for all three Network subsections'
// create/edit modals, driven by a field schema per entity rather than
// three hand-written forms. Values are tracked as loose
// Record<string, unknown> internally (not Partial<T> directly) because
// checkbox/number/date inputs all need their own onChange coercion
// before the value is shaped like T — the schema is what keeps this
// generic instead of needing a per-entity form component to encode that
// coercion.
export function RelationshipForm<T>({
  schema,
  initialValues,
  mode,
  isLeader,
  saving = false,
  submitLabel,
  onCancel,
  onSubmit,
  extraActions,
}: RelationshipFormProps<T>) {
  const [values, setValues] = useState<Record<string, unknown>>({ ...initialValues });

  const visibleFields = schema.filter((f) => !(f.createOnly && mode === 'edit'));

  function setField(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit(values);
  }

  return (
    <form className="nx-relationship-form" onSubmit={handleSubmit}>
      {visibleFields.map((field) => {
        const disabled = saving || (field.leaderOnly && !isLeader);
        const raw = values[field.key];

        if (field.type === 'checkbox') {
          return (
            <Checkbox
              key={field.key}
              label={field.label}
              checked={Boolean(raw)}
              disabled={disabled}
              onChange={(e) => setField(field.key, e.target.checked)}
            />
          );
        }

        if (field.type === 'select') {
          return (
            <Select
              key={field.key}
              label={field.label}
              options={field.options ?? []}
              value={(raw as string) ?? ''}
              required={field.required}
              disabled={disabled}
              onChange={(e) => setField(field.key, e.target.value)}
            />
          );
        }

        if (field.type === 'textarea') {
          return (
            <div className="nx-field" key={field.key}>
              <label className="nx-field__label" htmlFor={field.key}>{field.label}</label>
              <textarea
                id={field.key}
                className="nx-textarea"
                rows={3}
                value={(raw as string) ?? ''}
                disabled={disabled}
                onChange={(e) => setField(field.key, e.target.value)}
              />
            </div>
          );
        }

        if (field.type === 'date') {
          return (
            <DatePicker
              key={field.key}
              label={field.label}
              value={(raw as string)?.slice(0, 10) ?? ''}
              required={field.required}
              disabled={disabled}
              onChange={(e) => setField(field.key, e.target.value)}
            />
          );
        }

        return (
          <Input
            key={field.key}
            label={field.label}
            type={field.type === 'number' ? 'number' : field.type}
            value={(raw as string | number) ?? ''}
            required={field.required}
            disabled={disabled}
            onChange={(e) =>
              setField(field.key, field.type === 'number' ? e.target.valueAsNumber : e.target.value)
            }
          />
        );
      })}

      <div className="nx-relationship-form__actions">
        {extraActions}
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {submitLabel ?? (mode === 'create' ? 'Create' : 'Save changes')}
        </Button>
      </div>
    </form>
  );
}
