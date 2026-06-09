'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

export function FieldShell({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className={labelCls}>
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function TextField({
  id,
  label,
  initial,
  placeholder,
  hint,
  type = 'text',
  onCommit,
}: {
  id: string;
  label: string;
  initial: string;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'tel' | 'number';
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);

  return (
    <FieldShell label={label} htmlFor={id} hint={hint}>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={e => setValue(e.target.value)}
        onBlur={() => {
          if (value !== initial) {
            onCommit(value);
          }
        }}
        className={inputCls}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  id,
  label,
  initial,
  placeholder,
  hint,
  rows = 3,
  onCommit,
}: {
  id: string;
  label: string;
  initial: string;
  placeholder?: string;
  hint?: string;
  rows?: number;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);

  return (
    <FieldShell label={label} htmlFor={id} hint={hint}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={e => setValue(e.target.value)}
        onBlur={() => {
          if (value !== initial) {
            onCommit(value);
          }
        }}
        className={`
          ${inputCls}
          h-auto py-2
        `}
      />
    </FieldShell>
  );
}

export function SelectField<T extends string>({
  id,
  label,
  initial,
  options,
  hint,
  onCommit,
}: {
  id: string;
  label: string;
  initial: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  hint?: string;
  onCommit: (value: T) => void;
}) {
  return (
    <FieldShell label={label} htmlFor={id} hint={hint}>
      <Select
        id={id}
        value={initial}
        onValueChange={v => onCommit(v as T)}
        options={options.map(opt => ({ value: opt.value, label: opt.label }))}
      />
    </FieldShell>
  );
}

export function ToggleRow({
  label,
  description,
  initial,
  disabled,
  onCommit,
}: {
  label: string;
  description?: string;
  initial: boolean;
  disabled?: boolean;
  onCommit: (value: boolean) => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);

  return (
    <div
      className={`
        flex items-start justify-between gap-4 rounded-md border border-border
        bg-background p-4
        ${disabled ? 'opacity-60' : ''}
      `}
    >
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="mt-1 text-xs text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <Switch
        checked={value}
        disabled={disabled}
        aria-label={label}
        className="mt-1"
        onCheckedChange={(next) => {
          setValue(next);
          onCommit(next);
        }}
      />
    </div>
  );
}

export function MaskedField({
  id,
  label,
  initial,
  placeholder,
  hint,
  onCommit,
}: {
  id: string;
  label: string;
  initial: string;
  placeholder?: string;
  hint?: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) {
      setValue('');
    }
  }, [initial, editing]);

  const masked = initial
    ? `${initial.slice(0, 6)}${'•'.repeat(Math.max(initial.length - 6, 4))}`
    : '';

  if (!editing) {
    return (
      <FieldShell label={label} htmlFor={id} hint={hint}>
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="text"
            readOnly
            value={masked || '— sin configurar —'}
            className={`
              ${inputCls}
              text-muted-foreground
            `}
          />
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="
              h-9 shrink-0 rounded-md border border-input bg-background px-3
              text-xs font-medium
              hover:bg-muted
            "
          >
            {initial ? 'Cambiar' : 'Agregar'}
          </button>
        </div>
      </FieldShell>
    );
  }

  return (
    <FieldShell label={label} htmlFor={id} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="password"
          value={value}
          placeholder={placeholder}
          onChange={e => setValue(e.target.value)}
          className={inputCls}
        />
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setValue('');
          }}
          className="
            h-9 shrink-0 rounded-md border border-input bg-background px-3
            text-xs
            hover:bg-muted
          "
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => {
            onCommit(value.trim());
            setEditing(false);
            setValue('');
          }}
          className="
            h-9 shrink-0 rounded-md bg-primary px-3 text-xs font-medium
            text-primary-foreground
            hover:bg-primary/90
          "
        >
          Guardar
        </button>
      </div>
    </FieldShell>
  );
}
