'use client';

import { Archive, ArchiveRestore, DollarSign, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Sticky toolbar shown only while one or more products are selected. Groups the
// bulk operations — raise price, publish, archive, delete — plus a quick way to
// clear the selection. Delete only ever removes virgin products (no sales/
// movements); `deletableCount` is how many of the selection qualify, so the
// button disables when none do.
export function BulkActionBar({
  count,
  deletableCount,
  pending,
  onRaisePrice,
  onPublish,
  onArchive,
  onDelete,
  onClear,
}: {
  count: number;
  deletableCount: number;
  pending: boolean;
  onRaisePrice: () => void;
  onPublish: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
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
