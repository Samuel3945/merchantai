'use client';

import type { EntryDraftRow } from '../entry-import-parse';
import type { BulkEntryResult, EntryTarget } from '@/actions/inventory';
import { Plus, Trash2 } from 'lucide-react';
import Papa from 'papaparse';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { bulkRecordEntries, listEntryTargets } from '@/actions/inventory';
import { DatePicker } from '@/components/DatePicker';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Select } from '@/components/ui/select';
import { parseSpreadsheetRows } from '@/libs/spreadsheet-import';
import { cn } from '@/utils/Helpers';
import { recordsToEntryDrafts, validateEntryDraft } from '../entry-import-parse';
import { ENTRY_REASON_OPTIONS } from '../validation';
import { SupplierSelect } from './SupplierSelect';

const inputCls
  = 'h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const labelCls = 'text-sm font-medium';

const TEMPLATE
  = 'codigo de barras,nombre,cantidad,costo,vence\n7702004001234,Coca-Cola 600ml,24,2100,\n';

type EntryReason = 'purchase' | 'manual';

let manualRowSeq = 0;

export function EntryImportClient({ onImported }: { onImported: () => void }) {
  const [targets, setTargets] = useState<EntryTarget[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(true);

  const [reason, setReason] = useState<EntryReason>('purchase');
  const [supplierId, setSupplierId] = useState('');
  const [notes, setNotes] = useState('');

  const [drafts, setDrafts] = useState<EntryDraftRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<BulkEntryResult | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    listEntryTargets()
      .then((rows) => {
        if (active) {
          setTargets(rows);
        }
      })
      .finally(() => {
        if (active) {
          setLoadingTargets(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const targetById = useMemo(
    () => new Map(targets.map(t => [t.id, t])),
    [targets],
  );

  const productOptions = useMemo(
    () =>
      targets.map(t => ({
        value: t.id,
        label: t.barcode ? `${t.name} · ${t.barcode}` : t.name,
      })),
    [targets],
  );

  const errorsById = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const d of drafts) {
      map.set(
        d.id,
        validateEntryDraft(d, id => targetById.get(id)?.isPerishable ?? false),
      );
    }
    return map;
  }, [drafts, targetById]);

  const validRows = useMemo(
    () => drafts.filter(d => (errorsById.get(d.id)?.length ?? 0) === 0),
    [drafts, errorsById],
  );
  const invalidCount = drafts.length - validRows.length;

  // The batch-level reason gates whether a supplier or a note is required.
  const batchReady
    = reason === 'purchase'
      ? supplierId.trim().length > 0
      : notes.trim().length > 0;

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    setResult(null);
    setFileName(file.name);

    if (/\.xlsx$/i.test(file.name)) {
      const fd = new FormData();
      fd.append('file', file);
      startTransition(async () => {
        try {
          setDrafts(recordsToEntryDrafts(await parseSpreadsheetRows(fd), targets));
        } catch {
          setDrafts([]);
        }
      });
    } else {
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: res => setDrafts(recordsToEntryDrafts(res.data, targets)),
      });
    }
    e.target.value = '';
  }

  function updateRow(id: string, patch: Partial<EntryDraftRow>) {
    setDrafts(prev => prev.map(d => (d.id === id ? { ...d, ...patch } : d)));
  }

  function onSelectProduct(id: string, productId: string) {
    const target = targetById.get(productId);
    setDrafts(prev =>
      prev.map((d) => {
        if (d.id !== id) {
          return d;
        }
        // Pre-fill cost from the product when the row has none yet.
        const unitCost
          = d.unitCost.trim() || (target ? target.cost : '');
        return { ...d, productId, unitCost };
      }),
    );
  }

  function removeRow(id: string) {
    setDrafts(prev => prev.filter(d => d.id !== id));
  }

  function addRow() {
    manualRowSeq += 1;
    setDrafts(prev => [
      ...prev,
      {
        id: `manual-${manualRowSeq}`,
        productId: null,
        label: '',
        qty: '',
        unitCost: '',
        expiresAt: '',
      },
    ]);
  }

  function onImport() {
    if (validRows.length === 0 || !batchReady) {
      return;
    }
    startTransition(async () => {
      const res = await bulkRecordEntries({
        reason,
        supplierId: reason === 'purchase' ? supplierId : null,
        notes: reason === 'manual' ? notes : null,
        rows: validRows.map(d => ({
          productId: d.productId!,
          qty: Number(d.qty),
          unitCost: d.unitCost.trim(),
          expiresAt: d.expiresAt.trim() || null,
        })),
      });
      setResult(res);
      // Keep rows that still need attention: invalid ones plus any the server
      // rejected, matched by position among the rows we sent.
      const failedIdx = new Set(res.failed.map(f => f.row - 1));
      const stillFailing = validRows.filter((_, i) => failedIdx.has(i));
      const invalid = drafts.filter(
        d => (errorsById.get(d.id)?.length ?? 0) > 0,
      );
      setDrafts([...invalid, ...stillFailing]);
      if (res.created > 0) {
        onImported();
      }
    });
  }

  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`;

  return (
    <div className="space-y-4">
      {/* Batch-level: reason + supplier/notes apply to every row in the import. */}
      <div className="
        grid gap-3 rounded-lg border bg-muted/30 p-4
        sm:grid-cols-2
      "
      >
        <div>
          <label className={labelCls}>Motivo</label>
          <Select
            value={reason}
            onValueChange={v => setReason(v as EntryReason)}
            options={ENTRY_REASON_OPTIONS.map(o => ({
              value: o.value,
              label: o.label,
            }))}
          />
        </div>
        {reason === 'purchase'
          ? (
              <div>
                <label className={labelCls}>
                  Proveedor
                  {' '}
                  <span className="text-destructive">*</span>
                </label>
                <SupplierSelect value={supplierId} onChange={setSupplierId} />
              </div>
            )
          : (
              <div>
                <label className={labelCls}>
                  Describí el motivo
                  {' '}
                  <span className="text-destructive">*</span>
                </label>
                <input
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  className={cn(inputCls, 'h-9')}
                  placeholder="Ej. inventario inicial, sobrante de conteo"
                />
              </div>
            )}
      </div>

      {/* File source */}
      <div className="
        flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-4
      "
      >
        <label className="
          inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary
          px-4 py-2 text-sm font-medium text-primary-foreground
          hover:bg-primary/90
        "
        >
          Subir CSV o Excel
          <input
            type="file"
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={onFile}
            className="hidden"
            disabled={loadingTargets}
          />
        </label>
        {fileName && (
          <span className="text-sm text-muted-foreground">{fileName}</span>
        )}
        <a
          href={templateHref}
          download="plantilla-entradas.csv"
          className="
            ml-auto text-sm font-medium text-primary
            hover:underline
          "
        >
          Descargar plantilla
        </a>
      </div>

      {loadingTargets && (
        <div className="
          rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground
        "
        >
          Cargando productos…
        </div>
      )}

      {result && (
        <div className="space-y-2 rounded-lg border bg-background p-4">
          <p className="
            text-sm font-medium text-emerald-600
            dark:text-emerald-400
          "
          >
            Se cargaron
            {' '}
            {result.created}
            {' '}
            {result.created === 1 ? 'entrada' : 'entradas'}
            .
          </p>
          {result.failed.length > 0 && (
            <div>
              <p className="text-sm font-medium text-destructive">
                {result.failed.length}
                {' '}
                no se pudieron cargar:
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {result.failed.map(f => (
                  <li key={`${f.row}-${f.productId}`}>
                    <strong>
                      {targetById.get(f.productId)?.name ?? `Fila ${f.row}`}
                    </strong>
                    :
                    {' '}
                    {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Review grid */}
      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">Producto *</th>
              <th className="w-24 px-3 py-2">Cantidad *</th>
              <th className="w-28 px-3 py-2">Costo *</th>
              <th className="w-40 px-3 py-2">Vence</th>
              <th className="w-10 px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {drafts.length === 0
              ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      Subí un archivo o agregá filas a mano.
                    </td>
                  </tr>
                )
              : (
                  drafts.map((d) => {
                    const errs = errorsById.get(d.id) ?? [];
                    const target = d.productId
                      ? targetById.get(d.productId)
                      : undefined;
                    const needsExpiry = target?.isPerishable ?? false;
                    return (
                      <tr
                        key={d.id}
                        className={cn(
                          'border-t align-top',
                          errs.length > 0 && 'bg-destructive/5',
                        )}
                      >
                        <td className="px-3 py-2">
                          <Combobox
                            value={d.productId ?? ''}
                            onValueChange={v => onSelectProduct(d.id, v)}
                            options={productOptions}
                            placeholder={d.label || 'Elegí un producto'}
                            searchPlaceholder="Buscar por nombre o código…"
                            aria-label="Producto"
                            className={cn(
                              !d.productId && 'border-destructive',
                            )}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            inputMode="numeric"
                            value={d.qty}
                            onChange={e =>
                              updateRow(d.id, { qty: e.target.value })}
                            className={cn(
                              inputCls,
                              errs.includes('Cantidad inválida')
                              && 'border-destructive',
                            )}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            inputMode="decimal"
                            value={d.unitCost}
                            onChange={e =>
                              updateRow(d.id, { unitCost: e.target.value })}
                            className={cn(
                              inputCls,
                              errs.includes('Costo inválido')
                              && 'border-destructive',
                            )}
                          />
                        </td>
                        <td className="px-3 py-2">
                          {needsExpiry
                            ? (
                                <DatePicker
                                  value={d.expiresAt}
                                  min={new Date().toISOString().slice(0, 10)}
                                  placeholder="¿Cuándo vence?"
                                  onChange={v => updateRow(d.id, { expiresAt: v })}
                                  triggerClassName={cn(
                                    'h-8 w-full',
                                    errs.includes('Falta vencimiento')
                                    && 'border-destructive',
                                  )}
                                />
                              )
                            : (
                                <span className="text-muted-foreground">—</span>
                              )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => removeRow(d.id)}
                            className="
                              text-muted-foreground
                              hover:text-destructive
                            "
                            aria-label="Quitar fila"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={addRow}
          disabled={loadingTargets}
        >
          <Plus className="size-4" />
          Agregar fila
        </Button>
        <span className="text-sm text-muted-foreground">
          {validRows.length}
          {' '}
          {validRows.length === 1 ? 'lista' : 'listas'}
          {invalidCount > 0 && ` · ${invalidCount} con errores`}
        </span>
        <Button
          className="ml-auto"
          disabled={pending || validRows.length === 0 || !batchReady}
          onClick={onImport}
        >
          {pending
            ? 'Cargando…'
            : `Cargar ${validRows.length} ${validRows.length === 1 ? 'entrada' : 'entradas'}`}
        </Button>
      </div>
    </div>
  );
}
