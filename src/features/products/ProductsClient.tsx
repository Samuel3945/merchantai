'use client';

import type { BulkPriceMode, CategoryRow, ProductRow } from './actions';
import type { AttrRow } from './AttributesEditor';
import type { UITier } from './WholesaleTiersEditor';
import {
  Archive,
  ArchiveRestore,
  Boxes,
  CalendarClock,
  Copy,
  MoreVertical,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { DatePicker } from '@/components/DatePicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirm } from '@/components/ui/confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/utils/Helpers';
import {
  bulkAdjustPrice,
  bulkDeleteProducts,
  bulkSetProductStatus,
  createProduct,
  deleteProduct,
  listCategories,
  listProducts,
  setProductStatus,
  updateProduct,
} from './actions';
import { categorizeProduct } from './ai-categorize';
import { AttributesEditor } from './AttributesEditor';
import { BulkActionBar } from './BulkActionBar';
import { BulkPriceDialog } from './BulkPriceDialog';
import { ImportClient } from './ImportClient';
import { ProductTypeToggles } from './ProductTypeToggles';
import { WholesaleTiersEditor } from './WholesaleTiersEditor';

type ProductStatus = 'draft' | 'scheduled' | 'published' | 'archived';

const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: 'Borrador',
  scheduled: 'Programado',
  published: 'Publicado',
  archived: 'Archivado',
};

// Color language: published = live (green), archived = out of sale (amber/muted),
// draft = work in progress (neutral).
const STATUS_BADGE: Record<ProductStatus, string> = {
  draft: 'border-border bg-muted text-muted-foreground',
  scheduled: 'border-border bg-muted text-muted-foreground',
  published:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  archived:
    'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

type ProductFormState = {
  name: string;
  barcode: string;
  price: string;
  cost: string;
  category: string;
  unitType: 'unit' | 'kg';
  isPerishable: boolean;
  isWholesale: boolean;
  tiers: UITier[];
  attributes: AttrRow[];
  // Opening inventory — create-only.
  initialQty: string;
  initialCost: string;
  initialExpiresAt: string;
};

const emptyForm: ProductFormState = {
  name: '',
  barcode: '',
  price: '',
  cost: '0',
  category: '',
  unitType: 'unit',
  isPerishable: false,
  isWholesale: false,
  tiers: [],
  attributes: [],
  initialQty: '',
  initialCost: '',
  initialExpiresAt: '',
};

function toFormState(p: ProductRow): ProductFormState {
  const tiers = (p.wholesaleTiers as { minQty: number; price: string }[] | null) ?? [];
  const attrs = (p.attributes as Record<string, unknown> | null) ?? {};
  return {
    name: p.name,
    barcode: p.barcode ?? '',
    price: p.price,
    cost: p.cost,
    category: p.category ?? '',
    unitType: p.unitType,
    isPerishable: p.isPerishable,
    isWholesale: p.isWholesale,
    tiers: tiers.map(t => ({ minQty: String(t.minQty), price: String(t.price) })),
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: String(value ?? ''),
    })),
    initialQty: '',
    initialCost: '',
    initialExpiresAt: '',
  };
}

// A duplicate lands as a fresh draft-of-the-form: copies the commercial fields
// but clears the unique barcode and any opening stock so it's a clean new entry.
function toDuplicateForm(p: ProductRow): ProductFormState {
  return {
    ...toFormState(p),
    name: `${p.name} (copia)`,
    barcode: '',
  };
}

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

const labelCls = 'text-sm font-medium';

type AiState
  = | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'done'; remaining: number }
    | { status: 'no_credits' };

export type ProductFeatureFlags = {
  sellByWeight: boolean;
  wholesale: boolean;
  perishable: boolean;
};

export function ProductsClient({
  initial,
  features,
}: {
  initial: ProductRow[];
  features: ProductFeatureFlags;
}) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<ProductRow[]>(initial);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [form, setForm] = useState<ProductFormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [ai, setAi] = useState<AiState>({ status: 'idle' });
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  // Bulk-edit selection (set of product ids) and the raise-price dialog.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [priceDialogOpen, setPriceDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // The org's categories, for the form's autocomplete + learned suggestions.
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCategorizedRef = useRef<string>('');

  // One fetch path for the listing — reused by search, the archived toggle and
  // after every mutation so usage flags and status filters stay in sync.
  // useCallback keeps it stable per filter so the effect deps are honest and
  // direct callers (runMutation/onSubmit) never capture a stale filter.
  const fetchRows = useCallback(() => {
    startTransition(async () => {
      const data = await listProducts({ search, includeArchived: showArchived });
      setRows(data);
      // Drop the selection on every refetch: ids may no longer be visible after
      // a filter change, and after a bulk mutation the work is done.
      setSelected(new Set());
    });
  }, [search, showArchived]);

  useEffect(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = setTimeout(fetchRows, 250);
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, [fetchRows]);

  // Categories are loaded once and refreshed after a create/edit, since either
  // can introduce a new category or shift usage counts.
  const fetchCategories = useCallback(() => {
    startTransition(async () => {
      setCategories(await listCategories());
    });
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  const totalStock = useMemo(
    () => rows.reduce((acc, r) => acc + r.stock, 0),
    [rows],
  );

  // Selection is stored as a set of ids; everything the bulk bar needs is
  // derived from the currently visible rows so a stale id can never act.
  const selectedVisible = useMemo(
    () => rows.filter(r => selected.has(r.id)),
    [rows, selected],
  );
  const allVisibleSelected
    = rows.length > 0 && selectedVisible.length === rows.length;
  const someVisibleSelected
    = selectedVisible.length > 0 && !allVisibleSelected;
  // Only virgin products (no sales/movements) can be deleted — same rule as the
  // per-row delete, surfaced so the bulk button can disable when none qualify.
  const deletableSelectedCount = useMemo(
    () => selectedVisible.filter(r => !r.hasSales && !r.hasMovements).length,
    [selectedVisible],
  );

  const priceNum = Number.parseFloat(form.price) || 0;
  const initialQtyNum = Number.parseFloat(form.initialQty) || 0;
  const initialCostNum = Number.parseFloat(form.initialCost) || 0;

  // Characteristic suggestions learned for the typed category (matched by
  // normalized name), merged with any AI suggestions and deduped. This makes the
  // attribute_template useful even when the AI categorizer is unavailable.
  const attributeSuggestions = useMemo(() => {
    const slug = form.category.trim().toLowerCase();
    const match = slug
      ? categories.find(c => c.name.trim().toLowerCase() === slug)
      : undefined;
    const learned = match ? match.attributeTemplate.map(t => t.key) : [];
    return [...new Set([...learned, ...aiSuggestions])];
  }, [form.category, categories, aiSuggestions]);

  // Edit guards — derived from the product being edited. The server enforces
  // these too; the UI just explains why a field is locked.
  const inUse = editing ? editing.hasSales || editing.hasMovements : false;
  const unitLocked = inUse;
  const barcodeWarn = editing ? editing.hasSales : false;

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setAi({ status: 'idle' });
    setAiSuggestions([]);
    lastCategorizedRef.current = '';
    setOpen(true);
  }

  function openEdit(p: ProductRow) {
    setEditing(p);
    setForm(toFormState(p));
    setError(null);
    setAi({ status: 'idle' });
    setAiSuggestions([]);
    lastCategorizedRef.current = '';
    setOpen(true);
  }

  function openDuplicate(p: ProductRow) {
    setEditing(null);
    setForm(toDuplicateForm(p));
    setError(null);
    setAi({ status: 'idle' });
    setAiSuggestions([]);
    lastCategorizedRef.current = '';
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setEditing(null);
    setError(null);
  }

  // AI categorization — fires when the user finishes typing the name (create
  // mode only). Consumes one credit, so it's gated on a meaningful name and
  // never re-runs for the same value.
  function runCategorize() {
    const name = form.name.trim();
    if (editing || name.length < 3 || name === lastCategorizedRef.current) {
      return;
    }
    lastCategorizedRef.current = name;
    setAi({ status: 'loading' });
    startTransition(async () => {
      try {
        const res = await categorizeProduct(name, categories.map(c => c.name));
        if (!res.ok) {
          setAi(res.reason === 'no_credits' ? { status: 'no_credits' } : { status: 'idle' });
          return;
        }
        setAiSuggestions(res.attributes.map(a => a.key).filter(Boolean));
        setForm(f => ({
          ...f,
          category: f.category.trim() === '' ? res.category : f.category,
          attributes:
            f.attributes.length === 0
              ? res.attributes.filter(a => a.key.trim() !== '')
              : f.attributes,
        }));
        setAi({ status: 'done', remaining: res.remaining });
      } catch {
        setAi({ status: 'idle' });
      }
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const attributes = Object.fromEntries(
      form.attributes
        .map(a => [a.key.trim(), a.value.trim()] as const)
        .filter(([k]) => k !== ''),
    );

    const wholesaleTiers = form.isWholesale
      ? form.tiers
          .map(t => ({ minQty: Number.parseInt(t.minQty, 10), price: t.price.trim() }))
          .filter(t => Number.isFinite(t.minQty) && t.minQty >= 2 && t.price !== '')
      : null;

    const common = {
      name: form.name,
      barcode: form.barcode.trim() === '' ? null : form.barcode.trim(),
      price: form.price,
      cost: form.cost || '0',
      category: form.category.trim() === '' ? null : form.category.trim(),
      unitType: form.unitType,
      isPerishable: form.isPerishable,
      isWholesale: form.isWholesale,
      wholesaleTiers,
      attributes,
    };

    startTransition(async () => {
      try {
        if (editing) {
          await updateProduct(editing.id, common);
        } else {
          // No status field: a new product is created published and ready to
          // sell. Draft is reserved for future agent workflows, not the UI.
          await createProduct({
            ...common,
            initialQty: initialQtyNum,
            initialCost: form.initialCost.trim() === '' ? null : form.initialCost.trim(),
            initialExpiresAt:
              form.initialExpiresAt.trim() === '' ? null : form.initialExpiresAt.trim(),
          });
        }
        close();
        fetchRows();
        fetchCategories();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  function runMutation(fn: () => Promise<unknown>) {
    startTransition(async () => {
      try {
        await fn();
        fetchRows();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  function handlePublish(p: ProductRow) {
    runMutation(() => setProductStatus(p.id, 'published'));
  }

  async function handleArchive(p: ProductRow) {
    const ok = await confirm({
      title: `Quitar «${p.name}» de la venta`,
      description:
        'Dejará de venderse y no estará disponible para los agentes, pero conservas todo su historial. Puedes reactivarlo cuando quieras.',
      confirmText: 'Quitar de la venta',
    });
    if (!ok) {
      return;
    }
    runMutation(() => setProductStatus(p.id, 'archived'));
  }

  async function handleDelete(p: ProductRow) {
    const ok = await confirm({
      title: `¿Eliminar «${p.name}»?`,
      description:
        'Este producto nunca se vendió ni tuvo inventario, así que se borra por completo. Esta acción no se puede deshacer.',
      confirmText: 'Eliminar',
      tone: 'destructive',
    });
    if (!ok) {
      return;
    }
    runMutation(() => deleteProduct(p.id));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(rows.map(r => r.id)));
  }

  // Shared runner for bulk server actions: reports how many rows actually
  // changed (the server skips rows already in the target state), then refetches
  // — which also clears the selection.
  function runBulk(
    fn: () => Promise<{ updated: number }>,
    msg: (n: number) => string,
  ) {
    startTransition(async () => {
      try {
        const { updated } = await fn();
        if (updated > 0) {
          toast.success(msg(updated));
        } else {
          toast({ description: 'No hubo productos para actualizar.' });
        }
        fetchRows();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  function handleBulkPublish() {
    const ids = [...selected];
    runBulk(
      () => bulkSetProductStatus(ids, 'published'),
      n => `${n} ${n === 1 ? 'producto publicado' : 'productos publicados'}.`,
    );
  }

  async function handleBulkArchive() {
    const ids = [...selected];
    const ok = await confirm({
      title: `Quitar de la venta ${ids.length} ${
        ids.length === 1 ? 'producto' : 'productos'
      }`,
      description:
        'Dejarán de venderse pero conservas su historial. Puedes reactivarlos cuando quieras.',
      confirmText: 'Quitar de la venta',
    });
    if (!ok) {
      return;
    }
    runBulk(
      () => bulkSetProductStatus(ids, 'archived'),
      n => `${n} ${n === 1 ? 'producto archivado' : 'productos archivados'}.`,
    );
  }

  function handleBulkPrice(mode: BulkPriceMode, value: number) {
    const ids = [...selected];
    setPriceDialogOpen(false);
    runBulk(
      () => bulkAdjustPrice(ids, mode, value),
      n => `Precio actualizado en ${n} ${n === 1 ? 'producto' : 'productos'}.`,
    );
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    const deletable = selectedVisible.filter(
      r => !r.hasSales && !r.hasMovements,
    ).length;
    if (deletable === 0) {
      toast.error(
        'Ninguno se puede eliminar: todos tienen ventas o movimientos. Archívalos.',
      );
      return;
    }
    const blocked = selectedVisible.length - deletable;
    const ok = await confirm({
      title: `Eliminar ${deletable} ${deletable === 1 ? 'producto' : 'productos'} sin historial`,
      description: `${
        blocked > 0
          ? `${blocked} se omitirán porque tienen ventas o movimientos.\n\n`
          : ''
      }Esta acción no se puede deshacer.`,
      confirmText: 'Eliminar',
      tone: 'destructive',
    });
    if (!ok) {
      return;
    }
    startTransition(async () => {
      try {
        const { deleted, skipped } = await bulkDeleteProducts(ids);
        if (deleted > 0) {
          toast.success(
            `${deleted} ${deleted === 1 ? 'producto eliminado' : 'productos eliminados'}${
              skipped > 0 ? ` · ${skipped} omitidos` : ''
            }.`,
          );
        } else {
          toast({ description: 'No se eliminó ningún producto.' });
        }
        fetchRows();
        fetchCategories();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por nombre, código de barras o categoría"
          className={cn(inputCls, 'max-w-md')}
        />
        <button
          type="button"
          onClick={() => setShowArchived(v => !v)}
          aria-pressed={showArchived}
          className={cn(
            `
              flex items-center gap-2 rounded-md border px-3 py-2 text-sm
              font-medium transition-colors
            `,
            showArchived
              ? 'border-primary bg-primary/10 text-primary'
              : `
                border-input text-muted-foreground
                hover:bg-accent
              `,
          )}
        >
          <Archive className="size-4" />
          Ver archivados
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="
            inline-flex h-9 items-center justify-center rounded-md border
            border-input px-4 text-sm font-medium transition-colors
            hover:bg-accent
          "
        >
          Importar
        </button>
        <Button onClick={openCreate}>Nuevo artículo</Button>
        <div className="ml-auto text-sm text-muted-foreground">
          {rows.length}
          {' '}
          artículos · stock total
          {' '}
          {totalStock}
        </div>
      </div>

      {selectedVisible.length > 0 && (
        <BulkActionBar
          count={selectedVisible.length}
          deletableCount={deletableSelectedCount}
          pending={pending}
          onRaisePrice={() => setPriceDialogOpen(true)}
          onPublish={handleBulkPublish}
          onArchive={handleBulkArchive}
          onDelete={handleBulkDelete}
          onClear={() => setSelected(new Set())}
        />
      )}

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="w-10 px-3 py-2">
                <Checkbox
                  aria-label="Seleccionar todos"
                  checked={
                    allVisibleSelected
                      ? true
                      : someVisibleSelected
                        ? 'indeterminate'
                        : false
                  }
                  onCheckedChange={() => toggleAll()}
                  disabled={rows.length === 0}
                />
              </th>
              <th className="px-3 py-2">Nombre</th>
              <th className="px-3 py-2">Código de barras</th>
              <th className="px-3 py-2">Categoría</th>
              <th className="px-3 py-2 text-right">Precio</th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2">Unidad</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0
              ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      {pending ? 'Cargando…' : 'Aún no hay productos'}
                    </td>
                  </tr>
                )
              : (
                  rows.map((p) => {
                    const canDelete = !p.hasSales && !p.hasMovements;
                    const isArchived = p.status === 'archived';
                    return (
                      <tr
                        key={p.id}
                        className={cn(
                          'border-t',
                          isArchived && 'opacity-60',
                          selected.has(p.id) && 'bg-primary/5',
                        )}
                      >
                        <td className="px-3 py-2">
                          <Checkbox
                            aria-label={`Seleccionar ${p.name}`}
                            checked={selected.has(p.id)}
                            onCheckedChange={() => toggleOne(p.id)}
                          />
                        </td>
                        <td className="px-3 py-2 font-medium">{p.name}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {p.barcode ?? '—'}
                        </td>
                        <td className="px-3 py-2">{p.category ?? '—'}</td>
                        <td className="px-3 py-2 text-right">{p.price}</td>
                        <td className="px-3 py-2 text-right">{p.stock}</td>
                        <td className="px-3 py-2">{p.unitType}</td>
                        <td className="px-3 py-2">
                          <Badge
                            variant="outline"
                            className={STATUS_BADGE[p.status as ProductStatus]}
                          >
                            {STATUS_LABELS[p.status as ProductStatus]}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Acciones"
                              >
                                <MoreVertical className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openEdit(p)}>
                                <Pencil />
                                Editar
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openDuplicate(p)}>
                                <Copy />
                                Duplicar
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {p.status === 'published'
                                ? (
                                    <DropdownMenuItem onClick={() => handleArchive(p)}>
                                      <Archive />
                                      Quitar de la venta
                                    </DropdownMenuItem>
                                  )
                                : (
                                    <DropdownMenuItem onClick={() => handlePublish(p)}>
                                      <ArchiveRestore />
                                      Publicar
                                    </DropdownMenuItem>
                                  )}
                              {canDelete && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onClick={() => handleDelete(p)}
                                  >
                                    <Trash2 />
                                    Eliminar
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })
                )}
          </tbody>
        </table>
      </div>

      {error && !open && (
        <div className="
          rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive
        "
        >
          {error}
        </div>
      )}

      {open && (
        <div
          className="
            fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4
          "
          role="dialog"
          aria-modal="true"
          onClick={close}
        >
          <div
            className="
              max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border
              bg-background p-6 shadow-lg
            "
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editing ? 'Editar artículo' : 'Nuevo artículo'}
              </h2>
              <button
                type="button"
                onClick={close}
                className="
                  text-muted-foreground
                  hover:text-foreground
                "
                aria-label="Cerrar"
              >
                ✕
              </button>
            </div>

            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <label className={labelCls}>Nombre *</label>
                <input
                  required
                  autoFocus
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  onBlur={runCategorize}
                  className={cn(inputCls, 'mt-1')}
                />
              </div>

              <div>
                <label className={labelCls}>Código de barras</label>
                <input
                  value={form.barcode}
                  onChange={e => setForm({ ...form, barcode: e.target.value })}
                  className={cn(inputCls, 'mt-1')}
                />
                {barcodeWarn && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Este producto ya tiene ventas. Cambiar el código solo afecta
                    el escaneo futuro, no las ventas ya registradas.
                  </p>
                )}
              </div>

              <div>
                <label className={labelCls}>Categoría</label>
                <input
                  list="product-categories"
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  placeholder="Bebidas, Aseo, Lácteos…"
                  className={cn(inputCls, 'mt-1')}
                />
                <datalist id="product-categories">
                  {categories.map(c => (
                    <option key={c.id} value={c.name} />
                  ))}
                </datalist>
                {categories.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Elegí una existente o escribí una nueva.
                  </p>
                )}
              </div>

              {features.sellByWeight && (
                <div>
                  <label className={labelCls}>Se vende por</label>
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    {(['unit', 'kg'] as const).map(u => (
                      <button
                        key={u}
                        type="button"
                        disabled={unitLocked}
                        onClick={() => setForm({ ...form, unitType: u })}
                        className={cn(
                          `
                            h-10 rounded-md border text-sm font-medium
                            transition-colors
                          `,
                          form.unitType === u
                            ? 'border-primary bg-primary/10 text-primary'
                            : `
                              border-input text-muted-foreground
                              hover:bg-accent
                            `,
                          unitLocked && 'cursor-not-allowed opacity-50',
                        )}
                      >
                        {u === 'unit' ? 'Unidad' : 'Kg'}
                      </button>
                    ))}
                  </div>
                  {unitLocked && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      No se puede cambiar: el producto ya tiene inventario o
                      ventas. Cambiar la unidad dañaría el cálculo de stock.
                    </p>
                  )}
                </div>
              )}

              <ProductTypeToggles
                rows={[
                  ...(features.wholesale
                    ? [{
                        id: 'product-wholesale',
                        icon: Boxes,
                        label: 'Por mayor',
                        description: 'Precio especial por cantidad',
                        checked: form.isWholesale,
                        onCheckedChange: (v: boolean) =>
                          setForm(f => ({ ...f, isWholesale: v })),
                      }]
                    : []),
                  ...(features.perishable && !editing
                    ? [{
                        id: 'product-perishable',
                        icon: CalendarClock,
                        label: 'Se vence',
                        description: 'Controla la caducidad por lote',
                        checked: form.isPerishable,
                        onCheckedChange: (v: boolean) =>
                          setForm(f => ({ ...f, isPerishable: v })),
                      }]
                    : []),
                ]}
              />

              <div>
                <label className={labelCls}>
                  {form.unitType === 'kg' ? 'Precio por 1 kg *' : 'Precio por unidad *'}
                </label>
                <input
                  required
                  inputMode="decimal"
                  value={form.price}
                  onChange={e => setForm({ ...form, price: e.target.value })}
                  className={cn(inputCls, 'mt-1')}
                />
              </div>

              {features.wholesale && form.isWholesale && (
                <WholesaleTiersEditor
                  price={priceNum}
                  tiers={form.tiers}
                  onChange={tiers => setForm(f => ({ ...f, tiers }))}
                />
              )}

              {!editing && (
                <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                  <p className="
                    text-xs font-semibold tracking-wider text-muted-foreground
                    uppercase
                  "
                  >
                    Inventario inicial (opcional)
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Si ya tienes unidades, regístralas aquí — quedará como movimiento de entrada.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-muted-foreground">Cantidad</label>
                      <input
                        inputMode="numeric"
                        value={form.initialQty}
                        onChange={e => setForm({
                          ...form,
                          initialQty: e.target.value.replace(/\D/g, ''),
                        })}
                        placeholder="0"
                        className={cn(inputCls, 'mt-1')}
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground">
                        Costo unitario de ingreso
                      </label>
                      <input
                        inputMode="decimal"
                        value={form.initialCost}
                        onChange={e => setForm({ ...form, initialCost: e.target.value })}
                        placeholder="0"
                        className={cn(inputCls, 'mt-1')}
                      />
                    </div>
                  </div>
                  {features.perishable && form.isPerishable && (
                    <div>
                      <label className="
                        text-[11px] font-semibold tracking-wider
                        text-muted-foreground uppercase
                      "
                      >
                        Caducidad del lote inicial
                        {' '}
                        {initialQtyNum > 0 ? '*' : '(si registras stock inicial)'}
                      </label>
                      <div className="mt-1">
                        <DatePicker
                          value={form.initialExpiresAt}
                          min={new Date().toISOString().slice(0, 10)}
                          placeholder="¿Cuándo se vence este lote?"
                          onChange={iso => setForm({ ...form, initialExpiresAt: iso })}
                          triggerClassName="w-full"
                        />
                      </div>
                    </div>
                  )}
                  {initialQtyNum > 0 && initialCostNum > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Total entrada:
                      {' '}
                      <strong>
                        $
                        {Math.round(initialQtyNum * initialCostNum).toLocaleString('es-CO')}
                      </strong>
                      {priceNum > 0 && (
                        <>
                          {' '}
                          · Margen estimado:
                          {' '}
                          <strong>
                            {Math.round(((priceNum - initialCostNum) / priceNum) * 100)}
                            %
                          </strong>
                        </>
                      )}
                    </p>
                  )}
                </div>
              )}

              <AttributesEditor
                suggestions={attributeSuggestions}
                attributes={form.attributes}
                onChange={attributes => setForm(f => ({ ...f, attributes }))}
              />

              {!editing && (
                <div className="
                  rounded-md border bg-muted/30 px-3 py-2 text-xs
                  text-muted-foreground
                "
                >
                  {ai.status === 'loading'
                    ? 'La IA está categorizando este producto…'
                    : ai.status === 'done'
                      ? `Categoría sugerida por IA aplicada · ${ai.remaining} créditos restantes.`
                      : ai.status === 'no_credits'
                        ? 'Sin créditos de IA: completa la categoría manualmente.'
                        : 'La IA categorizará este producto al crearlo (consume 1 crédito).'}
                </div>
              )}

              {error && (
                <div className="
                  rounded-md bg-destructive/10 px-3 py-2 text-sm
                  text-destructive
                "
                >
                  {error}
                </div>
              )}

              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={close}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {priceDialogOpen && (
        <BulkPriceDialog
          count={selectedVisible.length}
          pending={pending}
          onApply={handleBulkPrice}
          onClose={() => setPriceDialogOpen(false)}
        />
      )}

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="
          max-h-[85vh] w-[95vw] max-w-5xl overflow-y-auto
        "
        >
          <DialogHeader>
            <DialogTitle>Importar productos</DialogTitle>
            <DialogDescription>
              Subí un CSV, Excel, foto o PDF; revisá y corregí cada fila antes de
              cargar el catálogo.
            </DialogDescription>
          </DialogHeader>
          <ImportClient
            categoryNames={categories.map(c => c.name)}
            onImported={() => {
              fetchRows();
              fetchCategories();
            }}
          />
        </DialogContent>
      </Dialog>

      <Toaster />
    </div>
  );
}
