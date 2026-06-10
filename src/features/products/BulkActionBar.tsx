'use client';

import { Archive, ArchiveRestore, DollarSign, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Sticky toolbar shown only while one or more products are selected. Groups the
// bulk operations the owner asked for — raise price, publish, archive — plus a
// quick way to clear the selection. Bulk delete is intentionally absent (a later
// request); single-product delete still lives in the per-row menu.
export function BulkActionBar({
  count,
  pending,
  onRaisePrice,
  onPublish,
  onArchive,
  onClear,
}: {
  count: number;
  pending: boolean;
  onRaisePrice: () => void;
  onPublish: () => void;
  onArchive: () => void;
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
