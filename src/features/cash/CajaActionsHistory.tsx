import type { CajaAdminAction } from '@/actions/cash';
import { User } from 'lucide-react';
import { stamp } from './cash-ui';

// Read-only audit feed of every admin/management action taken on this caja
// (rename, block, access change, …). It lives inside "Ver todo lo que pasó" so
// the owner can audit the device end to end — down to the smallest action — with
// who did it and at what time. Sourced from the append-only audit_logs trail.

// Pulls a string field out of an audit before/after JSON blob, safely.
function field(blob: unknown, key: string): string | undefined {
  if (blob && typeof blob === 'object' && key in blob) {
    const value = (blob as Record<string, unknown>)[key];
    return value == null ? undefined : String(value);
  }
  return undefined;
}

// Maps a raw audit action to a plain-language title and an optional detail line.
// Unknown actions degrade gracefully to their raw key so nothing is ever hidden.
function describe(a: CajaAdminAction): { title: string; detail?: string } {
  switch (a.action) {
    case 'pos_token.created':
      return { title: 'Caja creada' };
    case 'pos_token.renamed': {
      const from = field(a.before, 'deviceName');
      const to = field(a.after, 'deviceName');
      return {
        title: 'Cambió de nombre',
        detail: from && to ? `${from} → ${to}` : to,
      };
    }
    case 'pos_token.blocked':
      return { title: 'Caja bloqueada' };
    case 'pos_token.unblocked':
      return { title: 'Caja desbloqueada' };
    case 'pos_token.address_changed':
      return { title: 'Cambió la sucursal' };
    case 'pos_token.oversell_changed':
      return {
        title:
          field(a.after, 'allowOversell') === 'true'
            ? 'Activó vender sin control de stock'
            : 'Desactivó vender sin control de stock',
      };
    case 'pos_token.access_regenerated':
      return { title: 'Regeneró el código de acceso' };
    case 'pos_token.session_closed':
      return { title: 'Cerró la sesión del cajero' };
    case 'pos_token.sweep_destination_changed':
      return { title: 'Cambió el destino del barrido de efectivo' };
    case 'pos_token.deleted':
      return { title: 'Caja eliminada' };
    default:
      return { title: a.action };
  }
}

export function CajaActionsHistory({
  actions,
}: {
  actions: CajaAdminAction[];
}) {
  return (
    <div className="rounded-xl border border-border bg-card shadow-xs">
      <div className="border-b border-border px-5 py-3">
        <div className="text-sm font-semibold">Acciones sobre la caja</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Todo lo que el administrador hizo con este dispositivo queda
          registrado: quién, qué y cuándo.
        </p>
      </div>

      {actions.length === 0
        ? (
            <div className="
              px-5 py-10 text-center text-sm text-muted-foreground
            "
            >
              Todavía no hay acciones registradas sobre esta caja.
            </div>
          )
        : (
            <ul className="divide-y divide-border">
              {actions.map((a) => {
                const { title, detail } = describe(a);
                return (
                  <li key={a.id} className="flex items-start gap-3 px-5 py-3">
                    <span className="
                      mt-1.5 size-2 shrink-0 rounded-full bg-primary/60
                    "
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{title}</div>
                      {detail && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {detail}
                        </div>
                      )}
                      <div className="
                        mt-1 flex items-center gap-1.5 text-xs
                        text-muted-foreground
                      "
                      >
                        <User className="size-3" />
                        {a.actor}
                      </div>
                    </div>
                    <div className="
                      shrink-0 text-xs whitespace-nowrap text-muted-foreground
                      tabular-nums
                    "
                    >
                      {stamp(a.createdAt)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
    </div>
  );
}
