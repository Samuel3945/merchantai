import type { TreasuryAccount } from '@/libs/treasury';
import { money } from './cash-ui';
import { Consignar } from './Consignar';

const GROUPS: { type: TreasuryAccount['type']; label: string }[] = [
  { type: 'caja', label: 'Cajas' },
  { type: 'caja_fuerte', label: 'Caja fuerte' },
  { type: 'banco', label: 'Cuentas bancarias' },
];

// The owner's treasury overview: how much money is in each container, right now.
// Server component — read-only display of the derived position.
export function TreasuryConsole(props: { accounts: TreasuryAccount[] }) {
  if (props.accounts.length === 0) {
    return null;
  }

  const banks = props.accounts
    .filter(a => a.type === 'banco')
    .map(a => ({ value: a.name, label: a.name }));

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-xs">
      <div className="text-sm font-semibold">Dónde está la plata</div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Saldo de cada lugar donde tenés dinero.
      </p>
      <div className="mt-4 space-y-4">
        {GROUPS.map((g) => {
          const items = props.accounts.filter(a => a.type === g.type);
          if (items.length === 0) {
            return null;
          }
          return (
            <div key={g.type}>
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                {g.label}
              </div>
              <div className="
                grid grid-cols-2 gap-3
                lg:grid-cols-4
              "
              >
                {items.map(a => (
                  <div
                    key={a.key}
                    className="
                      rounded-lg border border-border bg-background p-3
                    "
                  >
                    <div className="truncate text-xs text-muted-foreground">
                      {a.name}
                    </div>
                    <div className="
                      mt-1 font-display text-lg font-medium tabular-nums
                    "
                    >
                      {money(a.balance)}
                    </div>
                    {a.note && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {a.note}
                      </div>
                    )}
                    {a.type === 'caja_fuerte' && <Consignar banks={banks} />}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
