import type { ArchivedCaja } from '@/actions/cajas';
import type { CajaSummary } from '@/actions/cash';
import { AlertTriangle, Archive, ChevronRight, Lock, Monitor, User } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/utils/Helpers';
import { money, relativeTime, stamp } from './cash-ui';

// THE main section of the Caja module: a read-only supervision view of every
// point of sale — open AND closed. A caja never disappears when its turn closes;
// it stays on the board marked "Cerrada" so the owner can still drill into it and
// review everything that happened. Each caja is a clickable card with a status
// semaphore, the cash it should hold (while open), and a plain-language note. A
// verdict banner surfaces only when something needs review. This screen never
// opens, closes or moves money; that happens at the point of sale.

type CajaStatus = 'ok' | 'review' | 'closed';

const PILL: Record<CajaStatus, string> = {
  ok: 'bg-success/10 text-success',
  review: 'bg-warn/10 text-warn',
  closed: 'bg-muted text-muted-foreground',
};

const PILL_LABEL: Record<CajaStatus, string> = {
  ok: 'Todo en orden',
  review: 'Para revisar',
  closed: 'Cerrada',
};

// Only a caja that needs review shows a note; "all good" cajas stay quiet.
const REVIEW_NOTE_CLS = 'bg-warn/5 text-foreground';

const BAR: Record<CajaStatus, string> = {
  ok: 'bg-success',
  review: 'bg-warn',
  closed: 'bg-muted-foreground/30',
};

function hoursOpen(openedAt: string): number {
  return (Date.now() - new Date(openedAt).getTime()) / 3_600_000;
}

// A caja open for more than a day is the one supervision signal we can derive
// from the till alone — it usually means the cashier forgot to close the turn.
// A closed caja is never "for review": its turn already ended.
function cajaStatus(caja: CajaSummary): CajaStatus {
  if (caja.status === 'closed') {
    return 'closed';
  }
  return caja.openedAt && hoursOpen(caja.openedAt) >= 24 ? 'review' : 'ok';
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

function reviewNote(caja: CajaSummary): string {
  const who = caja.responsable ?? 'el cajero';
  return `Lleva más de un día abierta. Pedile a ${who} que la cierre cuando termine el turno.`;
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
      {PILL_LABEL[status]}
    </span>
  );
}

function Verdict({ issues }: { issues: string[] }) {
  // Nothing to flag — skip the banner entirely to keep the view quiet.
  if (issues.length === 0) {
    return null;
  }
  return (
    <div
      className={cn(
        'flex items-center gap-5 rounded-2xl border p-5',
        'border-warn/20 bg-warn/5',
      )}
    >
      <div
        className={cn(
          `
            flex size-12 shrink-0 items-center justify-center rounded-full
            text-white
          `,
          'bg-warn',
        )}
      >
        <AlertTriangle className="size-6" />
      </div>
      <div className="min-w-0">
        <div
          className={cn(
            'font-display text-xl font-semibold',
            'text-warn',
          )}
        >
          {`Hay ${issues.length} ${issues.length === 1 ? 'cosa' : 'cosas'} para revisar`}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {issues.join(' · ')}
        </p>
      </div>
    </div>
  );
}

// The devices working in this bolsa — a chip row under the caja title. The caja
// NAME ("Caja N") is the title; the device names live here, never as the title.
function DeviceChips({ devices }: { devices: CajaSummary['devices'] }) {
  if (devices.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Dispositivos:</span>
      {devices.map(d => (
        <span
          key={d.id}
          className="
            inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5
            text-xs font-medium text-foreground
          "
        >
          <Monitor className="size-3" />
          {d.deviceName || 'Sin nombre'}
        </span>
      ))}
    </div>
  );
}

function CajaCardShell(props: {
  caja: CajaSummary;
  status: CajaStatus;
  children: React.ReactNode;
}) {
  const { caja, status, children } = props;
  return (
    <Link
      href={`/dashboard/cash/${caja.cajaId}`}
      className="
        group flex flex-col overflow-hidden rounded-xl border border-border
        bg-card shadow-xs transition-colors
        hover:border-primary/50
      "
    >
      <div className={cn('h-1.5', BAR[status])} />
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-display text-lg font-semibold">
                {caja.name || 'Caja sin nombre'}
              </div>
              <div className="
                mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground
              "
              >
                <User className="size-3.5" />
                {status === 'closed' ? 'Último a cargo' : 'A cargo de'}
                {' '}
                <span className="text-foreground">
                  {caja.responsable ?? '—'}
                </span>
              </div>
            </div>
            <StatusPill status={status} />
          </div>
          <DeviceChips devices={caja.devices} />
        </div>

        {children}

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

function OpenCajaCard({
  caja,
  status,
}: {
  caja: CajaSummary;
  status: CajaStatus;
}) {
  const openedAt = caja.openedAt;
  return (
    <CajaCardShell caja={caja} status={status}>
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
          <dd className="font-medium">{openedAt ? stamp(openedAt) : '—'}</dd>
        </div>
        <div className="
          flex items-center justify-between border-b border-border py-2
        "
        >
          <dt className="text-muted-foreground">Lleva abierta</dt>
          <dd className="font-medium">
            {openedAt ? openDuration(openedAt) : '—'}
          </dd>
        </div>
        <div className="flex items-center justify-between py-2">
          <dt className="text-muted-foreground">Última actividad</dt>
          <dd className="font-medium">{relativeTime(caja.lastActivityAt)}</dd>
        </div>
      </dl>

      {status === 'review' && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm',
            REVIEW_NOTE_CLS,
          )}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
          <span className="leading-snug">{reviewNote(caja)}</span>
        </div>
      )}
    </CajaCardShell>
  );
}

function ClosedCajaCard({ caja }: { caja: CajaSummary }) {
  const neverUsed = !caja.closedAt;
  return (
    <CajaCardShell caja={caja} status="closed">
      <div className="flex items-center gap-3 rounded-xl bg-secondary px-4 py-3">
        <div className="
          flex size-9 shrink-0 items-center justify-center rounded-full bg-muted
          text-muted-foreground
        "
        >
          <Lock className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {neverUsed ? 'Sin abrir todavía' : 'Turno cerrado'}
          </div>
          <div className="text-xs text-muted-foreground">
            {neverUsed
              ? 'Esta caja nunca registró un turno.'
              : 'Entrá para ver todo lo que pasó adentro.'}
          </div>
        </div>
      </div>

      {!neverUsed && (
        <dl className="text-sm">
          <div className="flex items-center justify-between py-2">
            <dt className="text-muted-foreground">Cerrada</dt>
            <dd className="font-medium">{relativeTime(caja.closedAt)}</dd>
          </div>
        </dl>
      )}
    </CajaCardShell>
  );
}

function CajaCard({ caja }: { caja: CajaSummary }) {
  const status = cajaStatus(caja);
  if (status === 'closed') {
    return <ClosedCajaCard caja={caja} />;
  }
  return <OpenCajaCard caja={caja} status={status} />;
}

// Historial de cajas archivadas (quedaron sin dispositivos). Se archiva la caja,
// no el dispositivo POS. Cada una con su ventana "del {creación} al {archivado}".
// Vive aquí (vista de Caja), no en pos-cajeros. Oculto si no hay ninguna.
const archivedDayFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium',
  timeZone: 'America/Bogota',
});

function formatArchivedDay(date: Date | string | null | undefined): string {
  return date ? archivedDayFmt.format(new Date(date)) : '—';
}

function ArchivedCajasSection({ cajas }: { cajas: ArchivedCaja[] }) {
  if (cajas.length === 0) {
    return null;
  }
  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-display text-lg font-semibold">Cajas archivadas</h2>
        <p className="text-sm text-muted-foreground">
          Cajas que quedaron sin dispositivos. Se archiva la caja, no el
          dispositivo POS.
        </p>
      </div>
      <ul className="divide-y rounded-xl border border-border bg-card text-sm">
        {cajas.map(c => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-2 px-4 py-3"
          >
            <span className="flex items-center gap-2">
              <Archive className="size-4 text-muted-foreground" />
              <span className="font-medium">{c.name}</span>
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              del
              {' '}
              {formatArchivedDay(c.createdAt)}
              {' '}
              al
              {' '}
              {formatArchivedDay(c.archivedAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CajasSupervision(props: {
  cajas: CajaSummary[];
  archivedCajas: ArchivedCaja[];
  notArrivedCount: number;
}) {
  const issues: string[] = [];
  for (const caja of props.cajas) {
    if (cajaStatus(caja) === 'review') {
      issues.push(`${caja.name || 'Una caja'} lleva más de un día abierta`);
    }
  }
  if (props.notArrivedCount > 0) {
    issues.push(
      props.notArrivedCount === 1
        ? '1 transferencia no llegó'
        : `${props.notArrivedCount} transferencias no llegaron`,
    );
  }

  // Open cajas come first (what needs watching now), then the closed ones.
  const cajas = [...props.cajas].sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === 'open' ? -1 : 1;
    }
    return 0;
  });

  return (
    <div className="space-y-8">
      <section className="space-y-5">
        <Verdict issues={issues} />

        <div>
          <h2 className="font-display text-lg font-semibold">
            ¿Cómo van tus cajas?
          </h2>
          <p className="text-sm text-muted-foreground">
            Una caja = una bolsa de dinero. Tocá una para ver todo lo que pasó
            adentro, esté abierta o cerrada.
          </p>
        </div>

        {cajas.length === 0
          ? (
              <div className="
                rounded-xl border border-dashed border-border p-8 text-center
                text-sm text-muted-foreground
              "
              >
                No hay cajas registradas todavía.
              </div>
            )
          : (
              <div className="
                grid grid-cols-1 gap-4
                sm:grid-cols-2
                lg:grid-cols-3
              "
              >
                {cajas.map(caja => (
                  <CajaCard key={caja.cajaId} caja={caja} />
                ))}
              </div>
            )}
      </section>

      <ArchivedCajasSection cajas={props.archivedCajas} />
    </div>
  );
}
