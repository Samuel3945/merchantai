import type { OpenCaja } from '@/actions/cash';
import { Clock, DoorOpen, Scale, User } from 'lucide-react';
import { cn } from '@/utils/Helpers';
import { money, stamp } from './cash-ui';

// Top-of-screen supervision view: the Caja screen answers "what happened at each
// point of sale" — who is open, today's difference, and how many payments are
// still pending confirmation. It does NOT hold money (that's Tesorería) and does
// NOT confirm payments (that's the Pagos module).

type Tone = 'default' | 'success' | 'destructive';

function SummaryCard(props: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {props.icon}
        <span className="font-medium">{props.label}</span>
      </div>
      <div
        className={cn(
          'mt-2 font-display text-2xl font-semibold tabular-nums',
          props.tone === 'success' && 'text-success',
          props.tone === 'destructive' && 'text-destructive',
        )}
      >
        {props.value}
      </div>
    </div>
  );
}

function CajaCard({ caja }: { caja: OpenCaja }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
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

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <User className="size-3.5" />
          <span>{caja.openedBy}</span>
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
            {caja.movementCount}
            {' '}
            movimiento
            {caja.movementCount === 1 ? '' : 's'}
            {' · abierta '}
            {stamp(caja.openedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function CajasSupervision(props: {
  openCajas: OpenCaja[];
  diferenciasHoy: number;
  pendingCount: number;
}) {
  const diffTone: Tone
    = props.diferenciasHoy === 0
      ? 'default'
      : props.diferenciasHoy > 0
        ? 'success'
        : 'destructive';

  return (
    <section className="space-y-4">
      <div className="
        grid grid-cols-1 gap-4
        sm:grid-cols-3
      "
      >
        <SummaryCard
          icon={<DoorOpen className="size-4" />}
          label="Cajas abiertas"
          value={String(props.openCajas.length)}
        />
        <SummaryCard
          icon={<Scale className="size-4" />}
          label="Diferencias de hoy"
          value={`${props.diferenciasHoy > 0 ? '+' : ''}${money(props.diferenciasHoy)}`}
          tone={diffTone}
        />
        <SummaryCard
          icon={<Clock className="size-4" />}
          label="Pagos pendientes"
          value={String(props.pendingCount)}
        />
      </div>

      {props.openCajas.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Cajas activas
          </h2>
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
        </div>
      )}
    </section>
  );
}
