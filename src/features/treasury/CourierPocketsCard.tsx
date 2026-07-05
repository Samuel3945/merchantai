import type { CourierWalletBalance } from '@/libs/courier-wallet';
import { Bike } from 'lucide-react';
import { money } from '@/features/cash/cash-ui';

// Bolsillo de domiciliarios en Tesorería: cuánto efectivo del negocio anda "en la
// calle" en manos de cada domiciliario. Solo se monta si hay domiciliarios
// activos (la página no lo renderiza con la lista vacía). El saldo se deriva del
// ledger courier_cash_movements. Ver docs/caja-domiciliario/ESPECIFICACION.md §8.3.
export function CourierPocketsCard({
  wallets,
}: {
  wallets: CourierWalletBalance[];
}) {
  const total = wallets.reduce((acc, w) => acc + w.balance, 0);

  return (
    <section className="
      rounded-xl border bg-background p-4
      sm:p-5
    "
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="
            grid size-8 place-items-center rounded-lg bg-amber-50 text-amber-600
          "
          >
            <Bike className="size-4" />
          </span>
          <div>
            <div className="text-sm font-semibold">En la calle</div>
            <div className="text-xs text-muted-foreground">
              Efectivo en manos de los domiciliarios
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums">
            {money(total)}
          </div>
          <div className="text-xs text-muted-foreground">
            {wallets.length}
            {' '}
            {wallets.length === 1 ? 'domiciliario' : 'domiciliarios'}
          </div>
        </div>
      </div>

      <ul className="mt-3 flex flex-col divide-y">
        {wallets.map(w => (
          <li
            key={w.courierId}
            className="flex items-center justify-between gap-3 py-2 text-sm"
          >
            <span className="truncate">{w.name}</span>
            <span
              className={`
                shrink-0 font-medium tabular-nums
                ${
          w.balance < 0 ? 'text-red-600' : 'text-foreground'
          }
              `}
            >
              {money(w.balance)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
