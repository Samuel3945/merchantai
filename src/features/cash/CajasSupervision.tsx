import type { OpenCaja } from '@/actions/cash';
import { Clock, User } from 'lucide-react';
import Link from 'next/link';
import { money, relativeTime } from './cash-ui';

// THE main section of the Caja module: the list of active cajas. Each caja is a
// clickable card that drills into its own detail (movements + closures filtered
// to that caja). Cajas come first — movements, history and stats are secondary
// and live inside the detail, not here.

function CajaCard({ caja }: { caja: OpenCaja }) {
  return (
    <Link
      href={`/dashboard/cash/${caja.posTokenId}`}
      className="
        group block rounded-xl border border-border bg-card p-4 shadow-xs
        transition-colors
        hover:border-primary/50 hover:bg-accent/30
      "
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-display font-semibold">
          {caja.deviceName || 'Caja sin nombre'}
        </span>
        <span className="
          inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2
          py-0.5 text-xs font-medium text-success
        "
        >
          <span className="size-1.5 rounded-full bg-success" />
          Activa
        </span>
      </div>

      <div className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <User className="size-3.5" />
          <span>
            Responsable:
            {' '}
            <span className="text-foreground">{caja.openedBy}</span>
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Efectivo esperado</span>
          <span className="font-display font-semibold tabular-nums">
            {money(caja.expected)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3" />
          <span>
            Última actividad:
            {' '}
            {relativeTime(caja.lastActivityAt)}
          </span>
        </div>
      </div>

      <div className="
        mt-3 text-sm font-medium text-primary
        group-hover:underline
      "
      >
        Ver detalles →
      </div>
    </Link>
  );
}

export function CajasSupervision(props: { openCajas: OpenCaja[] }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Cajas activas</h2>
        <p className="text-sm text-muted-foreground">
          Cada caja opera por separado. Tocá una para ver su detalle, sus
          movimientos y sus cierres.
        </p>
      </div>

      {props.openCajas.length === 0
        ? (
            <div className="
              rounded-xl border border-dashed border-border p-8 text-center
              text-sm text-muted-foreground
            "
            >
              No hay cajas abiertas en este momento.
            </div>
          )
        : (
            <div className="
              grid grid-cols-1 gap-4
              sm:grid-cols-2
              lg:grid-cols-3
            "
            >
              {props.openCajas.map(caja => (
                <CajaCard key={caja.id} caja={caja} />
              ))}
            </div>
          )}
    </section>
  );
}
