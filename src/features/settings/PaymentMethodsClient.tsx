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
import { useConfirm } from '@/components/ui/confirm';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { FiadoTermField } from '@/features/settings/FiadoTermField';
import { ToggleRow } from './fields';
import { useSettingSave } from './useSettingSave';

// Transfer accounts carry banking details the bot shares with the customer at
// checkout. The cashier never sees them — it only shows a "Transferencia" button.
type TransferDetails = {
  bank?: string;
  account_number?: string;
  holder_name?: string;
  holder_id?: string;
  notes?: string;
};

// Cash and credit (fiado) are system-managed and never appear as editable rows.
function isEditable(type: PaymentMethodType): boolean {
  return type !== 'cash' && type !== 'credit';
}

// One-line account summary shown under a transfer row (bank · number · holder).
function transferSummary(details: unknown): string {
  const d = (details ?? {}) as TransferDetails;
  return [d.bank, d.account_number, d.holder_name].filter(Boolean).join(' · ');
}

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

// Cash and credit are system-managed (see banner + Fiado toggle), so they are
// not offered when creating a custom method.
const TYPE_OPTIONS: ReadonlyArray<{ value: PaymentMethodType; label: string }> = [
  { value: 'transfer', label: 'Transferencia' },
  { value: 'card', label: 'Tarjeta' },
  { value: 'other', label: 'Otro' },
];

export function PaymentMethodsClient({
  initialMethods,
  fiadoEnabled: initialFiado,
}: {
  initialMethods: PaymentMethodRow[];
  fiadoEnabled: boolean;
}) {
  const confirm = useConfirm();
  const [methods, setMethods] = useState(initialMethods);
  const [editing, setEditing] = useState<PaymentMethodRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [fiado, setFiado] = useState(initialFiado);
  const { save } = useSettingSave();

  const editableMethods = methods.filter(m => isEditable(m.type));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleToggleFiado = (next: boolean) => {
    setFiado(next);
    save('fiado-enabled', next ? 'true' : 'false', { notifyConfigChange: true })
      .catch(() => setFiado(!next));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const oldIndex = editableMethods.findIndex(m => m.id === active.id);
    const newIndex = editableMethods.findIndex(m => m.id === over.id);
    if (oldIndex === -1 || newIndex === -1) {
      return;
    }
    const newEditable = arrayMove(editableMethods, oldIndex, newIndex);
    const systemMethods = methods.filter(m => !isEditable(m.type));
    const prevMethods = methods;
    setMethods([...systemMethods, ...newEditable]);
    startTransition(async () => {
      try {
        await reorderPaymentMethods(newEditable.map(m => m.id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo reordenar');
        setMethods(prevMethods);
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

  const handleDelete = async (row: PaymentMethodRow) => {
    const ok = await confirm({
      title: `¿Eliminar «${row.name}»?`,
      description:
        'Esta acción no se puede deshacer. El historial de ventas no se ve afectado.',
      confirmText: 'Eliminar',
      tone: 'destructive',
    });
    if (!ok) {
      return;
    }
    const prevMethods = methods;
    setMethods(prev => prev.filter(m => m.id !== row.id));
    startTransition(async () => {
      try {
        await deletePaymentMethod(row.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo eliminar');
        setMethods(prevMethods);
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

      <div>
        <h2 className="text-lg font-semibold">Métodos del sistema</h2>
        <p className="text-sm text-muted-foreground">
          Efectivo siempre está disponible. El fiado se activa con un toque.
        </p>
      </div>

      <div className="space-y-3">
        <div className="
          flex items-center justify-between gap-4 rounded-md border
          border-border bg-muted/30 p-4
        "
        >
          <div>
            <div className="text-sm font-medium">Efectivo</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Método predeterminado del sistema · siempre activo
            </div>
          </div>
          <span className="
            shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-xs
            font-semibold text-primary
          "
          >
            Siempre activo
          </span>
        </div>

        <ToggleRow
          label="Fiado / Crédito"
          description="Permite registrar ventas a crédito con saldo pendiente del cliente."
          initial={fiado}
          onCommit={handleToggleFiado}
        />

        {fiado && <FiadoTermField />}
      </div>

      <div className="flex items-center justify-between pt-2">
        <div>
          <h2 className="text-lg font-semibold">Cuentas de transferencia</h2>
          <p className="text-sm text-muted-foreground">
            Agrega tus cuentas (Bancolombia, Nequi, Daviplata…). En la caja el
            cajero ve un solo botón «Transferencia»; el bot comparte los datos al
            cliente. Arrastra para reordenar.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={pending}>
          Nuevo método
        </Button>
      </div>

      <div className="overflow-hidden rounded-md border bg-background">
        <div className="
          grid grid-cols-[40px_1fr_120px_120px_180px] gap-2 border-b bg-muted/50
          px-3 py-2 text-xs font-medium text-muted-foreground uppercase
        "
        >
          <div />
          <div>Nombre</div>
          <div>Tipo</div>
          <div>Activo</div>
          <div className="text-right">Acciones</div>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={editableMethods.map(m => m.id)}
            strategy={verticalListSortingStrategy}
          >
            {editableMethods.length === 0 && (
              <div className="
                px-3 py-6 text-center text-sm text-muted-foreground
              "
              >
                Sin cuentas de transferencia. Agrega una con «Nuevo método».
              </div>
            )}
            {editableMethods.map(row => (
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
        grid grid-cols-[40px_1fr_120px_120px_180px] items-center gap-2 border-b
        px-3 py-2 text-sm
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
        <div className="min-w-0">
          <div className="font-medium">{row.name}</div>
          {row.type === 'transfer' && transferSummary(row.details) && (
            <div className="truncate text-xs text-muted-foreground">
              {transferSummary(row.details)}
            </div>
          )}
        </div>
      </div>
      <div className="text-xs text-muted-foreground uppercase">{row.type}</div>
      <div className="flex items-center gap-2">
        <Switch
          checked={row.active}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={row.active ? 'Activo' : 'Inactivo'}
        />
        <span className="text-xs">{row.active ? 'Activo' : 'Inactivo'}</span>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onEdit} disabled={disabled}>
          Editar
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={onDelete}
          disabled={disabled}
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
  const [type, setType] = useState<PaymentMethodType>(initial?.type ?? 'transfer');
  const [icon, setIcon] = useState(initial?.icon ?? '');
  const [details, setDetails] = useState<TransferDetails>(
    (initial?.details ?? {}) as TransferDetails,
  );
  const setDetail = (patch: Partial<TransferDetails>) =>
    setDetails(d => ({ ...d, ...patch }));
  const [description, setDescription] = useState(initial?.description ?? '');
  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(
      initial?.icon
      || initial?.description
      || (initial?.details as TransferDetails | undefined)?.holder_id,
    ),
  );
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      // Only persist banking details for transfer accounts; other types clear them.
      const cleanDetails: Record<string, unknown>
        = type === 'transfer'
          ? Object.fromEntries(
              Object.entries(details).filter(([, v]) => v != null && v !== ''),
            )
          : {};

      let saved: PaymentMethodRow;
      if (initial) {
        saved = await updatePaymentMethod({
          id: initial.id,
          name,
          type,
          icon: icon.trim() || null,
          description: description.trim() || null,
          details: cleanDetails,
        });
      } else {
        saved = await createPaymentMethod({
          name,
          type,
          icon: icon.trim() || null,
          description: description.trim() || null,
          details: cleanDetails,
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
      <div className="
        max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-lg bg-background
        p-6 shadow-lg
      "
      >
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
            <Select
              id="pm-type"
              value={type}
              onValueChange={v => setType(v as PaymentMethodType)}
              options={TYPE_OPTIONS.map(opt => ({
                value: opt.value,
                label: opt.label,
              }))}
            />
          </div>

          {type === 'transfer' && (
            <div className="
              space-y-3 rounded-md border border-border bg-muted/30 p-3
            "
            >
              <p className="text-xs font-medium text-muted-foreground">
                Datos que el bot comparte con el cliente (el cajero no los ve)
              </p>
              <div>
                <label htmlFor="pm-bank" className={labelCls}>
                  Banco o billetera
                </label>
                <input
                  id="pm-bank"
                  type="text"
                  value={details.bank ?? ''}
                  onChange={e => setDetail({ bank: e.target.value })}
                  placeholder="Bancolombia, Nequi, Daviplata…"
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor="pm-acct-num" className={labelCls}>
                  Número de cuenta o celular
                </label>
                <input
                  id="pm-acct-num"
                  type="text"
                  value={details.account_number ?? ''}
                  onChange={e => setDetail({ account_number: e.target.value })}
                  placeholder="Ej: 300 123 4567"
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor="pm-holder" className={labelCls}>
                  A nombre de
                </label>
                <input
                  id="pm-holder"
                  type="text"
                  value={details.holder_name ?? ''}
                  onChange={e => setDetail({ holder_name: e.target.value })}
                  placeholder="Ej: Juan García"
                  className={inputCls}
                />
              </div>
            </div>
          )}

          <div className="border-t pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(s => !s)}
              className="
                flex items-center gap-1 text-sm font-medium
                text-muted-foreground
                hover:text-foreground
              "
            >
              <span aria-hidden>{showAdvanced ? '▾' : '▸'}</span>
              Opciones avanzadas
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-4">
              {type === 'transfer' && (
                <div>
                  <label htmlFor="pm-holder-id" className={labelCls}>
                    Cédula del titular (opcional)
                  </label>
                  <input
                    id="pm-holder-id"
                    type="text"
                    value={details.holder_id ?? ''}
                    onChange={e => setDetail({ holder_id: e.target.value })}
                    placeholder="Algunos bancos la piden"
                    className={inputCls}
                  />
                </div>
              )}

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
            </div>
          )}

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
