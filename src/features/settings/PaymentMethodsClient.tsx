'use client';

import type { DragEndEvent } from '@dnd-kit/core';
import type { PaymentMethodRow, PaymentMethodType } from '@/actions/payment-methods';
import {
  closestCenter,
  DndContext,

  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState, useTransition } from 'react';
import {
  createPaymentMethod,
  deletePaymentMethod,

  reorderPaymentMethods,
  updatePaymentMethod,
} from '@/actions/payment-methods';
import { Button } from '@/components/ui/button';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

const TYPE_OPTIONS: ReadonlyArray<{ value: PaymentMethodType; label: string }> = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'card', label: 'Tarjeta' },
  { value: 'credit', label: 'Fiado / Crédito' },
  { value: 'other', label: 'Otro' },
];

function formatHour(h: number | null): string {
  if (h === null || h === undefined) {
    return '';
  }
  return h.toString().padStart(2, '0');
}

function formatSchedule(start: number | null, end: number | null): string {
  if (start === null && end === null) {
    return 'Sin horario';
  }
  return `${formatHour(start ?? 0)}:00 – ${formatHour(end ?? 23)}:00`;
}

export function PaymentMethodsClient({
  initialMethods,
}: {
  initialMethods: PaymentMethodRow[];
}) {
  const [methods, setMethods] = useState(initialMethods);
  const [editing, setEditing] = useState<PaymentMethodRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const oldIndex = methods.findIndex(m => m.id === active.id);
    const newIndex = methods.findIndex(m => m.id === over.id);
    if (oldIndex === -1 || newIndex === -1) {
      return;
    }
    const next = arrayMove(methods, oldIndex, newIndex);
    setMethods(next);
    startTransition(async () => {
      try {
        await reorderPaymentMethods(next.map(m => m.id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo reordenar');
        setMethods(methods);
      }
    });
  };

  const handleToggleActive = (row: PaymentMethodRow) => {
    const nextActive = !row.active;
    setMethods(prev =>
      prev.map(m => (m.id === row.id ? { ...m, active: nextActive } : m)),
    );
    startTransition(async () => {
      try {
        await updatePaymentMethod({ id: row.id, active: nextActive });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo actualizar');
        setMethods(prev =>
          prev.map(m => (m.id === row.id ? { ...m, active: row.active } : m)),
        );
      }
    });
  };

  const handleDelete = (row: PaymentMethodRow) => {
    // eslint-disable-next-line no-alert
    if (!globalThis.confirm(`¿Eliminar "${row.name}"?`)) {
      return;
    }
    startTransition(async () => {
      try {
        await deletePaymentMethod(row.id);
        setMethods(prev =>
          prev.map(m => (m.id === row.id ? { ...m, active: false } : m)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo eliminar');
      }
    });
  };

  const handleSaved = (saved: PaymentMethodRow) => {
    setMethods((prev) => {
      const idx = prev.findIndex(m => m.id === saved.id);
      if (idx === -1) {
        return [...prev, saved];
      }
      const next = [...prev];
      next[idx] = saved;
      return next;
    });
    setEditing(null);
    setCreating(false);
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="
          rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2
          text-sm text-destructive
        "
        >
          {error}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => setError(null)}
          >
            Cerrar
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Métodos de pago</h2>
          <p className="text-sm text-muted-foreground">
            Arrastra para reordenar. Desactiva los que no uses sin perder el
            historial.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={pending}>
          Nuevo método
        </Button>
      </div>

      <div className="overflow-hidden rounded-md border bg-background">
        <div className="
          grid grid-cols-[40px_1fr_120px_140px_120px_180px] gap-2 border-b
          bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground
          uppercase
        "
        >
          <div />
          <div>Nombre</div>
          <div>Tipo</div>
          <div>Horario</div>
          <div>Activo</div>
          <div className="text-right">Acciones</div>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={methods.map(m => m.id)}
            strategy={verticalListSortingStrategy}
          >
            {methods.length === 0 && (
              <div className="
                px-3 py-6 text-center text-sm text-muted-foreground
              "
              >
                Sin métodos de pago
              </div>
            )}
            {methods.map(row => (
              <SortableRow
                key={row.id}
                row={row}
                disabled={pending}
                onEdit={() => setEditing(row)}
                onToggle={() => handleToggleActive(row)}
                onDelete={() => handleDelete(row)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {(editing || creating) && (
        <EditModal
          initial={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={handleSaved}
          onError={err =>
            setError(err instanceof Error ? err.message : String(err))}
        />
      )}
    </div>
  );
}

function SortableRow({
  row,
  disabled,
  onEdit,
  onToggle,
  onDelete,
}: {
  row: PaymentMethodRow;
  disabled: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        grid grid-cols-[40px_1fr_120px_140px_120px_180px] items-center gap-2
        border-b px-3 py-2 text-sm
        last:border-b-0
        ${row.active ? '' : 'opacity-60'}
      `}
    >
      <button
        type="button"
        className="
          cursor-grab touch-none text-muted-foreground
          hover:text-foreground
          active:cursor-grabbing
        "
        aria-label="Reordenar"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <div className="flex items-center gap-2">
        {row.icon && <span className="text-base">{row.icon}</span>}
        <span className="font-medium">{row.name}</span>
      </div>
      <div className="text-xs text-muted-foreground uppercase">{row.type}</div>
      <div className="text-xs text-muted-foreground">
        {formatSchedule(row.startHour, row.endHour)}
      </div>
      <div>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={row.active}
            disabled={disabled}
            onChange={onToggle}
          />
          <span className="text-xs">{row.active ? 'Activo' : 'Inactivo'}</span>
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onEdit} disabled={disabled}>
          Editar
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={onDelete}
          disabled={disabled || !row.active}
        >
          Eliminar
        </Button>
      </div>
    </div>
  );
}

function EditModal({
  initial,
  onClose,
  onSaved,
  onError,
}: {
  initial: PaymentMethodRow | null;
  onClose: () => void;
  onSaved: (row: PaymentMethodRow) => void;
  onError: (err: unknown) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<PaymentMethodType>(initial?.type ?? 'other');
  const [icon, setIcon] = useState(initial?.icon ?? '');
  const [hasSchedule, setHasSchedule] = useState(
    initial?.startHour !== null && initial?.startHour !== undefined,
  );
  const [startHour, setStartHour] = useState<string>(
    initial?.startHour !== null && initial?.startHour !== undefined
      ? String(initial.startHour)
      : '8',
  );
  const [endHour, setEndHour] = useState<string>(
    initial?.endHour !== null && initial?.endHour !== undefined
      ? String(initial.endHour)
      : '20',
  );
  const [description, setDescription] = useState(initial?.description ?? '');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const parsedStart = hasSchedule ? Number(startHour) : null;
      const parsedEnd = hasSchedule ? Number(endHour) : null;

      let saved: PaymentMethodRow;
      if (initial) {
        saved = await updatePaymentMethod({
          id: initial.id,
          name,
          type,
          icon: icon.trim() || null,
          startHour: parsedStart,
          endHour: parsedEnd,
          description: description.trim() || null,
        });
      } else {
        saved = await createPaymentMethod({
          name,
          type,
          icon: icon.trim() || null,
          startHour: parsedStart,
          endHour: parsedEnd,
          description: description.trim() || null,
        });
      }
      onSaved(saved);
    } catch (err) {
      onError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="
      fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4
    "
    >
      <div className="w-full max-w-lg rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {initial ? 'Editar método de pago' : 'Nuevo método de pago'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="
              text-muted-foreground
              hover:text-foreground
            "
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="pm-name" className={labelCls}>
              Nombre
            </label>
            <input
              id="pm-name"
              type="text"
              required
              value={name}
              onChange={e => setName(e.target.value)}
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="pm-type" className={labelCls}>
              Tipo
            </label>
            <select
              id="pm-type"
              value={type}
              onChange={e => setType(e.target.value as PaymentMethodType)}
              className={inputCls}
            >
              {TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="pm-icon" className={labelCls}>
              Ícono (emoji o texto)
            </label>
            <input
              id="pm-icon"
              type="text"
              maxLength={4}
              value={icon}
              onChange={e => setIcon(e.target.value)}
              placeholder="💸"
              className={inputCls}
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasSchedule}
                onChange={() => setHasSchedule(v => !v)}
              />
              Restringir por horario
            </label>
            {hasSchedule && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="pm-start" className={labelCls}>
                    Desde (0–23)
                  </label>
                  <input
                    id="pm-start"
                    type="number"
                    min={0}
                    max={23}
                    value={startHour}
                    onChange={e => setStartHour(e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label htmlFor="pm-end" className={labelCls}>
                    Hasta (0–23)
                  </label>
                  <input
                    id="pm-end"
                    type="number"
                    min={0}
                    max={23}
                    value={endHour}
                    onChange={e => setEndHour(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>
            )}
          </div>

          <div>
            <label htmlFor="pm-desc" className={labelCls}>
              Descripción
            </label>
            <textarea
              id="pm-desc"
              rows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
              className={`
                ${inputCls}
                h-auto py-2
              `}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
