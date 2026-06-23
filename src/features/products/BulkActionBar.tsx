'use client';

import { Archive, ArchiveRestore, DollarSign, Scale, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Sticky toolbar shown only while one or more products are selected. Groups the
// bulk operations — raise price, change unit, publish, archive, delete — plus a
// quick way to clear the selection. Delete only ever removes virgin products (no
// sales/movements); `deletableCount` is how many of the selection qualify, so
// the button disables when none do.
//
// The unit-change button flips between unit <-> kg. It needs the whole selection
// to share one (non-digital) unit so the target is unambiguous: `selectedUnitType`
// is that shared type, or null when the selection is mixed (or contains digital
// products) — in which case the button is disabled with an explanatory tooltip.
// `convertibleCount` is how many of the selection can actually flip (no history),
// so the button also disables when none qualify even within a homogeneous group.
export function BulkActionBar({
  count,
  deletableCount,
  selectedUnitType,
  convertibleCount,
  pending,
  onRaisePrice,
  onConvertUnitType,
  onPublish,
  onArchive,
  onDelete,
  onClear,
}: {
  count: number;
  deletableCount: number;
  selectedUnitType: 'unit' | 'kg' | null;
  convertibleCount: number;
  pending: boolean;
  onRaisePrice: () => void;
  onConvertUnitType: () => void;
  onPublish: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  // Target of the flip, and why the button might be off.
  const unitDisabledReason
    = selectedUnitType === null
      ? 'Selecciona productos del mismo tipo (todos por unidad o todos por kg, sin digitales).'
      : convertibleCount === 0
        ? 'Ninguno se puede cambiar: tienen ventas o movimientos.'
        : undefined;
  const unitLabel = selectedUnitType === 'unit' ? 'Pasar a Kg' : 'Pasar a unidad';

  return (
    <div className="
      sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border
      border-primary/30 bg-primary/5 px-3 py-2 shadow-sm
    "
    >
      <span className="text-sm font-medium">
        {count}
        {' '}
        {count === 1 ? 'seleccionado' : 'seleccionados'}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={onRaisePrice}
        >
          <DollarSign className="size-4" />
          Subir precio
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || unitDisabledReason !== undefined}
          title={unitDisabledReason}
          onClick={onConvertUnitType}
        >
          <Scale className="size-4" />
          {unitLabel}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={onPublish}
        >
          <ArchiveRestore className="size-4" />
          Publicar
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={onArchive}
        >
          <Archive className="size-4" />
          Archivar
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={pending || deletableCount === 0}
          title={
            deletableCount === 0
              ? 'Ninguno se puede eliminar: tienen ventas o movimientos. Archívalos.'
              : undefined
          }
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
          Eliminar
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Limpiar selección"
          onClick={onClear}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
