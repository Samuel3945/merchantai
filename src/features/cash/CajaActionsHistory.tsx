import type { CajaAdminAction } from '@/actions/cash';
import { Clock, User } from 'lucide-react';
import { cn } from '@/utils/Helpers';
import { stamp } from './cash-ui';

// Read-only audit feed of every admin/management action taken on this caja
// (rename, address, cashier, sweep destination, block, …). The owner can audit
// the device end to end — who did it, when, and the readable before → after of
// every critical config change. Sourced from the append-only audit_logs trail,
// which now freezes a human label (never a UUID) into each before/after blob.

// Pulls a string field out of an audit before/after JSON blob, safely.
function field(blob: unknown, key: string): string | undefined {
  if (blob && typeof blob === 'object' && key in blob) {
    const value = (blob as Record<string, unknown>)[key];
    return value == null ? undefined : String(value);
  }
  return undefined;
}

function boolLabel(value: string | undefined): string | undefined {
  if (value === 'true') {
    return 'Activado';
  }
  if (value === 'false') {
    return 'Desactivado';
  }
  return undefined;
}

// Tone drives the timeline dot color so each kind of change is scannable.
type Tone = 'name' | 'address' | 'cashier' | 'sweep' | 'config' | 'lifecycle';

type Described = {
  title: string;
  tone: Tone;
  before?: string;
  after?: string;
};

const DOT: Record<Tone, string> = {
  name: 'bg-sky-500',
  address: 'bg-violet-500',
  cashier: 'bg-amber-500',
  sweep: 'bg-teal-500',
  config: 'bg-orange-500',
  lifecycle: 'bg-primary/60',
};

// Maps a raw audit action to a plain-language title plus, when the trail stored
// readable values, the before → after pair. Legacy rows that only kept a UUID
// resolve to no before/after (we NEVER surface a raw id), degrading to a clean
// action + actor + time line. Unknown actions degrade to their raw key.
function describe(a: CajaAdminAction): Described {
  switch (a.action) {
    case 'pos_token.created':
      return { title: 'Caja creada', tone: 'lifecycle' };
    case 'pos_token.renamed':
      return {
        title: 'Nombre actualizado',
        tone: 'name',
        before: field(a.before, 'deviceName'),
        after: field(a.after, 'deviceName'),
      };
    case 'pos_token.blocked':
      return { title: 'Caja bloqueada', tone: 'lifecycle' };
    case 'pos_token.unblocked':
      return { title: 'Caja desbloqueada', tone: 'lifecycle' };
    case 'pos_token.address_changed':
      return {
        title: 'Dirección actualizada',
        tone: 'address',
        before: field(a.before, 'address'),
        after: field(a.after, 'address'),
      };
    case 'pos_token.oversell_changed':
      return {
        title:
          field(a.after, 'allowOversell') === 'true'
            ? 'Activó vender sin control de stock'
            : 'Desactivó vender sin control de stock',
        tone: 'config',
        before: boolLabel(field(a.before, 'allowOversell')),
        after: boolLabel(field(a.after, 'allowOversell')),
      };
    case 'pos_token.access_regenerated':
      return { title: 'Regeneró el código de acceso', tone: 'lifecycle' };
    case 'pos_token.session_closed':
      return { title: 'Cerró la sesión del cajero', tone: 'lifecycle' };
    case 'pos_token.sweep_destination_changed':
      return {
        title: 'Destino de barrido actualizado',
        tone: 'sweep',
        before: field(a.before, 'destination'),
        after: field(a.after, 'destination'),
      };
    case 'pos_token.admin_cashier_on':
    case 'pos_token.admin_cashier_off':
      return {
        title: 'Cajero de la caja actualizado',
        tone: 'cashier',
        before: field(a.before, 'cashier'),
        after: field(a.after, 'cashier'),
      };
    case 'pos_token.deleted':
      return { title: 'Caja eliminada', tone: 'lifecycle' };
    default:
      return { title: a.action, tone: 'lifecycle' };
  }
}

// A single before → after value pill pair. Only rendered when the trail kept a
// readable value for the change.
function BeforeAfter(props: { before?: string; after?: string }) {
  if (!props.before && !props.after) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {props.before && (
        <span className="
          rounded-md bg-muted px-2 py-1 text-muted-foreground line-through
          decoration-muted-foreground/40
        "
        >
          {props.before}
        </span>
      )}
      <span className="text-muted-foreground">→</span>
      {props.after && (
        <span className="
          rounded-md bg-success/10 px-2 py-1 font-medium text-success
        "
        >
          {props.after}
        </span>
      )}
    </div>
  );
}

export function CajaActionsHistory({
  actions,
}: {
  actions: CajaAdminAction[];
}) {
  if (actions.length === 0) {
    return (
      <div className="
        rounded-xl border border-border bg-card px-5 py-12 text-center text-sm
        text-muted-foreground shadow-xs
      "
      >
        Todavía no hay acciones registradas sobre esta caja.
      </div>
    );
  }

  return (
    <ol className="space-y-3">
      {actions.map((a) => {
        const { title, tone, before, after } = describe(a);
        return (
          <li
            key={a.id}
            className="
              flex items-start gap-3 rounded-xl border border-border bg-card p-4
              shadow-xs
            "
          >
            <span
              className={cn(
                'mt-1 size-2.5 shrink-0 rounded-full',
                DOT[tone],
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="
                flex flex-wrap items-center justify-between gap-x-3 gap-y-1
              "
              >
                <div className="text-sm font-medium">{title}</div>
                <div className="
                  flex items-center gap-1 text-xs whitespace-nowrap
                  text-muted-foreground tabular-nums
                "
                >
                  <Clock className="size-3" />
                  {stamp(a.createdAt)}
                </div>
              </div>

              <BeforeAfter before={before} after={after} />

              <div className="
                mt-2 flex items-center gap-1.5 text-xs text-muted-foreground
              "
              >
                <User className="size-3" />
                {a.actor}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
