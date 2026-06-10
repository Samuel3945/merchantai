'use client';

import type { DeliveryOrder } from './actions';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/utils/Helpers';
import { createDelivery } from './actions';

const fieldCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

type ItemRow = { name: string; qty: string; price: string };

const emptyItem: ItemRow = { name: '', qty: '1', price: '0' };

export function NewDeliveryModal({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (order: DeliveryOrder) => void;
}) {
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [address, setAddress] = useState('');
  const [addressNotes, setAddressNotes] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('0');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<ItemRow[]>([{ ...emptyItem }]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setCustomerName('');
    setCustomerPhone('');
    setAddress('');
    setAddressNotes('');
    setDeliveryFee('0');
    setNotes('');
    setItems([{ ...emptyItem }]);
    setError(null);
  }

  function updateItem(index: number, patch: Partial<ItemRow>) {
    setItems(prev => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  function submit() {
    setError(null);
    const cleanItems = items
      .filter(it => it.name.trim() !== '')
      .map(it => ({
        name: it.name.trim(),
        qty: Math.max(1, Math.round(Number(it.qty) || 0)),
        price: Math.max(0, Number(it.price) || 0),
      }));

    startTransition(async () => {
      try {
        const order = await createDelivery({
          customerName: customerName.trim() || null,
          customerPhone: customerPhone.trim() || null,
          address: address.trim(),
          addressNotes: addressNotes.trim() || null,
          items: cleanItems,
          deliveryFee: Math.max(0, Number(deliveryFee) || 0),
          notes: notes.trim() || null,
        });
        onSaved(order);
        reset();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error inesperado');
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo domicilio</DialogTitle>
          <DialogDescription>
            Registra un pedido para que el domiciliario lo vea y lo lleve.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="
            grid gap-3
            sm:grid-cols-2
          "
          >
            <Field label="Cliente">
              <input
                type="text"
                value={customerName}
                onChange={e => setCustomerName(e.target.value)}
                placeholder="Nombre del cliente"
                className={fieldCls}
              />
            </Field>
            <Field label="WhatsApp / teléfono">
              <input
                type="tel"
                value={customerPhone}
                onChange={e => setCustomerPhone(e.target.value)}
                placeholder="+57 300 123 4567"
                className={fieldCls}
              />
            </Field>
          </div>

          <Field label="Dirección" required>
            <input
              type="text"
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="Calle 1 # 2-3, barrio"
              className={fieldCls}
            />
          </Field>

          <Field label="Indicaciones de entrega" hint="Apto, referencias, portería…">
            <input
              type="text"
              value={addressNotes}
              onChange={e => setAddressNotes(e.target.value)}
              className={fieldCls}
            />
          </Field>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="
                text-xs font-semibold tracking-wider text-muted-foreground
                uppercase
              "
              >
                Productos
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setItems(prev => [...prev, { ...emptyItem }])}
              >
                <PlusIcon className="size-4" />
                Agregar
              </Button>
            </div>
            <div className="space-y-2">
              {items.map((it, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={it.name}
                    onChange={e => updateItem(i, { name: e.target.value })}
                    placeholder="Producto"
                    className={cn(fieldCls, 'flex-1')}
                  />
                  <input
                    type="number"
                    min="1"
                    value={it.qty}
                    onChange={e => updateItem(i, { qty: e.target.value })}
                    placeholder="Cant."
                    className={cn(fieldCls, 'w-16')}
                  />
                  <input
                    type="number"
                    min="0"
                    value={it.price}
                    onChange={e => updateItem(i, { price: e.target.value })}
                    placeholder="Precio"
                    className={cn(fieldCls, 'w-24')}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setItems(prev =>
                        prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i),
                      )}
                    className="
                      rounded-md p-1.5 text-muted-foreground
                      hover:bg-muted hover:text-destructive
                    "
                    aria-label="Quitar producto"
                  >
                    <Trash2Icon className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="
            grid gap-3
            sm:grid-cols-2
          "
          >
            <Field label="Costo de domicilio">
              <input
                type="number"
                min="0"
                value={deliveryFee}
                onChange={e => setDeliveryFee(e.target.value)}
                className={fieldCls}
              />
            </Field>
            <Field label="Notas para el domiciliario">
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className={fieldCls}
              />
            </Field>
          </div>

          {error && (
            <div className="
              rounded-md border border-destructive/30 bg-destructive/10 px-3
              py-2 text-sm text-destructive
            "
            >
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={pending || address.trim() === ''} onClick={submit}>
            {pending ? 'Guardando…' : 'Crear domicilio'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </p>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
