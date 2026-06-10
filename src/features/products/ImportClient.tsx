'use client';

import type { ImportResult } from './actions';
import type { DraftRow } from './import-parse';
import Papa from 'papaparse';
import { useMemo, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/Helpers';
import { bulkImportProducts } from './actions';
import {
  extractProductsFromImage,
  extractProductsFromPdf,
  parseSpreadsheetRows,
} from './import-actions';
import { recordsToDrafts, validateDraft } from './import-parse';

const inputCls
  = 'h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const TEMPLATE = 'nombre,precio,costo,categoria,codigo de barras\nCoca-Cola 600ml,3000,2100,Bebidas,7702004001234\n';

export function ImportClient({ categoryNames }: { categoryNames: string[] }) {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const errorsById = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const d of drafts) {
      map.set(d.id, validateDraft(d));
    }
    return map;
  }, [drafts]);

  const validCount = useMemo(
    () => drafts.filter(d => (errorsById.get(d.id)?.length ?? 0) === 0).length,
    [drafts, errorsById],
  );
  const invalidCount = drafts.length - validCount;

  // Shared AI-extraction flow for photos and PDFs: both return the same result
  // shape and feed the same grid, differing only in the action and the copy.
  function runAiExtraction(file: File, kind: 'image' | 'pdf') {
    const fd = new FormData();
    fd.append('file', file);
    startTransition(async () => {
      setNotice(kind === 'pdf' ? 'Leyendo el PDF con IA…' : 'Analizando la imagen con IA…');
      try {
        const res
          = kind === 'pdf'
            ? await extractProductsFromPdf(fd)
            : await extractProductsFromImage(fd);
        if (res.ok) {
          setDrafts(recordsToDrafts(res.rows));
          setNotice(null);
        } else {
          setDrafts([]);
          setNotice(
            res.reason === 'no_key'
              ? 'La IA no está disponible: configura tu API key de OpenAI en Integraciones (o en el servidor).'
              : kind === 'pdf'
                ? 'No se detectaron productos en el PDF. Si es escaneado, probá con una foto.'
                : 'No se detectaron productos en la imagen.',
          );
        }
      } catch {
        setDrafts([]);
        setNotice('No se pudo procesar el archivo.');
      }
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    setResult(null);
    setNotice(null);
    setFileName(file.name);

    if (file.type.startsWith('image/')) {
      runAiExtraction(file, 'image');
    } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      runAiExtraction(file, 'pdf');
    } else if (/\.xlsx$/i.test(file.name)) {
      // Excel is parsed server-side (the parser stays out of the client bundle).
      const fd = new FormData();
      fd.append('file', file);
      startTransition(async () => {
        try {
          setDrafts(recordsToDrafts(await parseSpreadsheetRows(fd)));
        } catch {
          setDrafts([]);
        }
      });
    } else {
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: res => setDrafts(recordsToDrafts(res.data)),
      });
    }
    // Allow re-selecting the same file later.
    e.target.value = '';
  }

  function updateRow(id: string, field: keyof DraftRow, value: string) {
    setDrafts(prev =>
      prev.map(d => (d.id === id ? { ...d, [field]: value } : d)),
    );
  }
  function removeRow(id: string) {
    setDrafts(prev => prev.filter(d => d.id !== id));
  }

  function onImport() {
    const valid = drafts.filter(
      d => (errorsById.get(d.id)?.length ?? 0) === 0,
    );
    if (valid.length === 0) {
      return;
    }
    startTransition(async () => {
      const res = await bulkImportProducts(
        valid.map(d => ({
          name: d.name,
          barcode: d.barcode.trim() || null,
          price: d.price.trim(),
          cost: d.cost.trim() || null,
          category: d.category.trim() || null,
        })),
      );
      setResult(res);
      // Keep rows that still need attention: the invalid ones, plus any valid
      // rows the server rejected (e.g. duplicate barcode), matched by position.
      const invalid = drafts.filter(
        d => (errorsById.get(d.id)?.length ?? 0) > 0,
      );
      const failedIdx = new Set(res.failed.map(f => f.row - 1));
      const stillFailing = valid.filter((_, i) => failedIdx.has(i));
      setDrafts([...invalid, ...stillFailing]);
    });
  }

  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`;

  return (
    <div className="space-y-4">
      <datalist id="import-categories">
        {categoryNames.map(name => (
          <option key={name} value={name} />
        ))}
      </datalist>

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
          Elegir archivo, PDF o foto
          <input
            type="file"
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,application/pdf,image/*"
            onChange={onFile}
            className="hidden"
          />
        </label>
        {fileName && (
          <span className="text-sm text-muted-foreground">{fileName}</span>
        )}
        <a
          href={templateHref}
          download="plantilla-productos.csv"
          className="
            ml-auto text-sm font-medium text-primary
            hover:underline
          "
        >
          Descargar plantilla
        </a>
      </div>

      {notice && (
        <div className="
          rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground
        "
        >
          {notice}
        </div>
      )}

      {result && (
        <div className="space-y-2 rounded-lg border bg-background p-4">
          <p className="
            text-sm font-medium text-emerald-600
            dark:text-emerald-400
          "
          >
            Se importaron
            {' '}
            {result.created}
            {' '}
            {result.created === 1 ? 'producto' : 'productos'}
            .
          </p>
          {result.failed.length > 0 && (
            <div>
              <p className="text-sm font-medium text-destructive">
                {result.failed.length}
                {' '}
                no se pudieron importar:
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {result.failed.map(f => (
                  <li key={`${f.row}-${f.name}`}>
                    <strong>{f.name}</strong>
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

      {drafts.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-md border bg-background">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase">
                <tr>
                  <th className="px-3 py-2">Nombre *</th>
                  <th className="px-3 py-2">Precio *</th>
                  <th className="px-3 py-2">Costo</th>
                  <th className="px-3 py-2">Categoría</th>
                  <th className="px-3 py-2">Código de barras</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => {
                  const errs = errorsById.get(d.id) ?? [];
                  return (
                    <tr
                      key={d.id}
                      className={cn(
                        'border-t align-top',
                        errs.length > 0 && 'bg-destructive/5',
                      )}
                    >
                      <td className="px-3 py-2">
                        <input
                          value={d.name}
                          onChange={e => updateRow(d.id, 'name', e.target.value)}
                          className={cn(
                            inputCls,
                            errs.includes('Falta el nombre') && `
                              border-destructive
                            `,
                          )}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          inputMode="decimal"
                          value={d.price}
                          onChange={e => updateRow(d.id, 'price', e.target.value)}
                          className={cn(
                            inputCls,
                            errs.includes('Precio inválido') && `
                              border-destructive
                            `,
                          )}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          inputMode="decimal"
                          value={d.cost}
                          onChange={e => updateRow(d.id, 'cost', e.target.value)}
                          className={cn(
                            inputCls,
                            errs.includes('Costo inválido') && `
                              border-destructive
                            `,
                          )}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          list="import-categories"
                          value={d.category}
                          onChange={e => updateRow(d.id, 'category', e.target.value)}
                          className={inputCls}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={d.barcode}
                          onChange={e => updateRow(d.id, 'barcode', e.target.value)}
                          className={cn(inputCls, 'font-mono')}
                        />
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
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {validCount}
              {' '}
              {validCount === 1 ? 'listo' : 'listos'}
              {invalidCount > 0 && ` · ${invalidCount} con errores`}
            </span>
            <Button
              className="ml-auto"
              disabled={pending || validCount === 0}
              onClick={onImport}
            >
              {pending
                ? 'Importando…'
                : `Importar ${validCount} ${validCount === 1 ? 'producto' : 'productos'}`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
