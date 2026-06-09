'use client';

import type { InventoryProduct, InventoryView } from '@/actions/inventory';
import { useState, useTransition } from 'react';
import { getInventoryView } from '@/actions/inventory';
import { Toaster } from '@/components/ui/toast';
import { cn } from '@/utils/Helpers';
import { EntryModal } from './components/EntryModal';
import { ExitModal } from './components/ExitModal';
import { InventoryKpis } from './components/InventoryKpis';
import { MovementHistory } from './components/MovementHistory';
import { ProductLotsDrawer } from './components/ProductLotsDrawer';
import { StockTable } from './components/StockTable';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export function InventoryClient({ initialView }: { initialView: InventoryView }) {
  const [view, setView] = useState(initialView);
  const [tab, setTab] = useState<'stock' | 'history'>('stock');
  const [search, setSearch] = useState('');
  const [pending, startTransition] = useTransition();

  const [entryProduct, setEntryProduct] = useState<InventoryProduct | null>(null);
  const [exitProduct, setExitProduct] = useState<InventoryProduct | null>(null);
  const [drawerProduct, setDrawerProduct] = useState<InventoryProduct | null>(null);

  function reload() {
    startTransition(async () => {
      const data = await getInventoryView();
      setView(data);
    });
  }

  const filtered = search.trim()
    ? view.products.filter(
        p =>
          p.name.toLowerCase().includes(search.toLowerCase())
          || (p.category ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : view.products;

  return (
    <div className="space-y-4">
      <Toaster />

      <InventoryKpis
        products={view.products}
        inventoryValue={view.inventoryValue}
        expiringCount={view.expiringCount}
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {(['stock', 'history'] as const).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors',
              tab === t
                ? 'border-b-2 border-foreground text-foreground'
                : `
                  text-muted-foreground
                  hover:text-foreground
                `,
            )}
          >
            {t === 'stock' ? 'Stock' : 'Historial'}
          </button>
        ))}
      </div>

      {tab === 'stock' && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por nombre o categoría"
              className={cn(inputCls, 'max-w-md')}
            />
          </div>

          <StockTable
            products={filtered}
            pending={pending}
            onEntry={setEntryProduct}
            onExit={setExitProduct}
            onRowClick={setDrawerProduct}
            onMinSaved={reload}
          />
        </>
      )}

      {tab === 'history' && <MovementHistory products={view.products} />}

      {entryProduct && (
        <EntryModal
          product={entryProduct}
          onClose={() => setEntryProduct(null)}
          onSuccess={reload}
        />
      )}
      {exitProduct && (
        <ExitModal
          product={exitProduct}
          onClose={() => setExitProduct(null)}
          onSuccess={reload}
        />
      )}
      {drawerProduct && (
        <ProductLotsDrawer
          product={drawerProduct}
          onClose={() => setDrawerProduct(null)}
        />
      )}
    </div>
  );
}
