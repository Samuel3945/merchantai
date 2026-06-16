import type { OpenCaja } from '@/actions/cash';
import { AlertTriangle, CheckCircle2, ChevronRight, User } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/utils/Helpers';
import { money, relativeTime, stamp } from './cash-ui';

// THE main section of the Caja module: a read-only supervision view of the active
// points of sale. Each caja is a clickable card with a status semaphore, the cash
// it should hold, and a plain-language note — drilling into its own detail. A
// verdict banner on top answers "is everything ok?" at a glance. This screen never
// opens, closes or moves money; that happens at the point of sale.

type CajaStatus = 'ok' | 'review';

const PILL: Record<CajaStatus, string> = {
  ok: 'bg-success/10 text-success',
  review: 'bg-warn/10 text-warn',
};

const NOTE: Record<CajaStatus, string> = {
  ok: 'bg-success/5 text-foreground',
  review: 'bg-warn/5 text-foreground',
};

const BAR: Record<CajaStatus, string> = {
  ok: 'bg-success',
  review: 'bg-warn',
};

function hoursOpen(openedAt: string): number {
  return (Date.now() - new Date(openedAt).getTime()) / 3_600_000;
}

// A caja open for more than a day is the one supervision signal we can derive
// from the till alone — it usually means the cashier forgot to close the turn.
function cajaStatus(caja: OpenCaja): CajaStatus {
  return hoursOpen(caja.openedAt) >= 24 ? 'review' : 'ok';
}

function openDuration(openedAt: string): string {
  const h = Math.floor(hoursOpen(openedAt));
  if (h < 1) {
    return 'Menos de una hora';
  }
  if (h < 24) {
    return `${h} ${h === 1 ? 'hora' : 'horas'}`;
  }
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? 'día' : 'días'}`;
}

function cajaNote(caja: OpenCaja): string {
  return cajaStatus(caja) === 'review'
    ? `Lleva más de un día abierta. Pedile a ${caja.openedBy} que la cierre cuando termine el turno.`
    : 'Funcionando normal. No hay nada que hacer.';
}

function StatusPill({ status }: { status: CajaStatus }) {
  return (
    <span
      className={cn(
        `
          inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs
          font-semibold
        `,
        PILL[status],
      )}
    >
      <span className={cn('size-2 rounded-full', BAR[status])} />
      {status === 'ok' ? 'Todo en orden' : 'Para revisar'}
    </span>
  );
}

function Verdict({ issues }: { issues: string[] }) {
  const ok = issues.length === 0;
  return (
    <div
      className={cn(
        'flex items-center gap-5 rounded-2xl border p-5',
        ok ? 'border-success/20 bg-success/5' : 'border-warn/20 bg-warn/5',
      )}
    >
      <div
        className={cn(
          `
            flex size-12 shrink-0 items-center justify-center rounded-full
            text-white
          `,
          ok ? 'bg-success' : 'bg-warn',
        )}
      >
        {ok
          ? <CheckCircle2 className="size-6" />
          : <AlertTriangle className="size-6" />}
      </div>
      <div className="min-w-0">
        <div
          className={cn(
            'font-display text-xl font-semibold',
            ok ? 'text-success' : 'text-warn',
          )}
        >
          {ok
            ? 'Todo está en orden'
            : `Hay ${issues.length} ${issues.length === 1 ? 'cosa' : 'cosas'} para revisar`}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {ok
            ? 'Tus cajas y transferencias están al día.'
            : issues.join(' · ')}
        </p>
      </div>
    </div>
  );
}

function CajaCard({ caja }: { caja: OpenCaja }) {
  const status = cajaStatus(caja);
  return (
    <Link
      href={`/dashboard/cash/${caja.posTokenId}`}
      className="
        group flex flex-col overflow-hidden rounded-xl border border-border
        bg-card shadow-xs transition-colors
        hover:border-primary/50
      "
    >
      <div className={cn('h-1.5', BAR[status])} />
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-display text-lg font-semibold">
              {caja.deviceName || 'Caja sin nombre'}
            </div>
            <div className="
              mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground
            "
            >
              <User className="size-3.5" />
              A cargo de
              {' '}
              <span className="text-foreground">{caja.openedBy}</span>
            </div>
          </div>
          <StatusPill status={status} />
        </div>

        <div className="
          flex items-end justify-between rounded-xl bg-secondary px-4 py-3
        "
        >
          <div>
            <div className="text-xs font-semibold text-muted-foreground">
              Plata que debería tener
            </div>
            <div className="text-[11px] text-muted-foreground/80">
              según lo que vendió
            </div>
          </div>
          <span className="font-display text-2xl font-semibold tabular-nums">
            {money(caja.expected)}
          </span>
        </div>

        <dl className="text-sm">
          <div className="
            flex items-center justify-between border-b border-border py-2
          "
          >
            <dt className="text-muted-foreground">Abierta desde</dt>
            <dd className="font-medium">{stamp(caja.openedAt)}</dd>
          </div>
          <div className="
            flex items-center justify-between border-b border-border py-2
          "
          >
            <dt className="text-muted-foreground">Lleva abierta</dt>
            <dd className="font-medium">{openDuration(caja.openedAt)}</dd>
          </div>
          <div className="flex items-center justify-between py-2">
            <dt className="text-muted-foreground">Última actividad</dt>
            <dd className="font-medium">{relativeTime(caja.lastActivityAt)}</dd>
          </div>
        </dl>

        <div
          className={cn(
            'flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm',
            NOTE[status],
          )}
        >
          {status === 'ok'
            ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />}
          <span className="leading-snug">{cajaNote(caja)}</span>
        </div>

        <div className="
          mt-auto flex items-center justify-end gap-1 text-sm font-medium
          text-primary
          group-hover:underline
        "
        >
          Ver todo lo que pasó
          <ChevronRight className="size-4" />
        </div>
      </div>
    </Link>
  );
}

export function CajasSupervision(props: {
  openCajas: OpenCaja[];
  notArrivedCount: number;
}) {
  const issues: string[] = [];
  for (const caja of props.openCajas) {
    if (cajaStatus(caja) === 'review') {
      issues.push(`${caja.deviceName || 'Una caja'} lleva más de un día abierta`);
    }
  }
  if (props.notArrivedCount > 0) {
    issues.push(
      props.notArrivedCount === 1
        ? '1 transferencia no llegó'
        : `${props.notArrivedCount} transferencias no llegaron`,
    );
  }

  return (
    <section className="space-y-5">
      <Verdict issues={issues} />

      <div>
        <h2 className="font-display text-lg font-semibold">
          ¿Cómo van tus cajas?
        </h2>
        <p className="text-sm text-muted-foreground">
          Una caja = un punto donde cobran. Tocá una para ver todo lo que pasó
          adentro.
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
