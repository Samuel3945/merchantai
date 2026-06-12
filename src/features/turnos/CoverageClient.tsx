'use client';

import type {
  AbsenceListRow,
  CoverageSuggestion,
  RosterEntry,
} from '@/actions/coverage';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  assignCoverage,
  cancelAbsence,
  getCoverageSuggestions,
  listAbsences,
  notifyReplacement,
  registerAbsence,
} from '@/actions/coverage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Select } from '@/components/ui/select';
import { cn } from '@/utils/Helpers';

const inputCls
  = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const labelCls = 'text-xs font-medium text-muted-foreground';

// ── Date helpers ────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) {
    return iso;
  }
  return new Intl.DateTimeFormat('es-CO', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

// ── Props ───────────────────────────────────────────────────────────────────

type Props = {
  initialRoster: RosterEntry[];
  initialAbsences: AbsenceListRow[];
  employees: { id: string; name: string }[];
  defaultDate: string;
};

// ── Roster section ──────────────────────────────────────────────────────────

function RosterGroup({
  title,
  dotCls,
  entries,
  trailing,
}: {
  title: string;
  dotCls: string;
  entries: RosterEntry[];
  trailing?: (e: RosterEntry) => React.ReactNode;
}) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <ul className="space-y-1">
        {entries.map(e => (
          <li
            key={e.id}
            className="
              flex items-center gap-2 rounded-md border bg-background px-3 py-2
              text-sm shadow-xs
            "
          >
            <span className={cn('size-2 shrink-0 rounded-full', dotCls)} />
            <span className="min-w-0 truncate font-medium">{e.name}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {trailing?.(e)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RosterSection({ roster }: { roster: RosterEntry[] }) {
  if (roster.length === 0) {
    return (
      <p className="
        rounded-md border border-dashed py-6 text-center text-sm
        text-muted-foreground
      "
      >
        No hay empleados activos registrados.
      </p>
    );
  }

  return (
    <div className="
      grid grid-cols-1 gap-4
      lg:grid-cols-3
    "
    >
      <RosterGroup
        title="Trabajando hoy"
        dotCls="bg-emerald-500"
        entries={roster.filter(e => e.status === 'working')}
        trailing={e => (e.start && e.end ? `${e.start} – ${e.end}` : null)}
      />
      <RosterGroup
        title="Descanso programado"
        dotCls="bg-blue-400"
        entries={roster.filter(e => e.status === 'off')}
      />
      <RosterGroup
        title="Ausentes hoy"
        dotCls="bg-red-400"
        entries={roster.filter(e => e.status === 'absent')}
        trailing={e =>
          e.coveredByName ? `Cubierto por ${e.coveredByName}` : 'Sin cubrir'}
      />
    </div>
  );
}

// ── Register form ───────────────────────────────────────────────────────────

function RegisterForm({
  employees,
  defaultDate,
  onRegistered,
}: {
  employees: { id: string; name: string }[];
  defaultDate: string;
  onRegistered: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [kind, setKind] = useState<'absence' | 'break'>('absence');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!employeeId) {
      setError('Selecciona un empleado');
      return;
    }
    startTransition(async () => {
      const res = await registerAbsence({ employeeId, date, kind, reason: reason || null });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setEmployeeId('');
      setReason('');
      setDate(defaultDate);
      onRegistered();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1">
        <span className={labelCls}>Empleado</span>
        <Select
          value={employeeId}
          onValueChange={setEmployeeId}
          disabled={pending}
          options={[
            { value: '', label: '— Selecciona un empleado —' },
            ...employees.map(emp => ({ value: emp.id, label: emp.name })),
          ]}
        />
        {employees.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No tienes empleados activos. Créalos en la sección Empleados.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="absence-date" className={labelCls}>
            Fecha
          </label>
          <input
            id="absence-date"
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className={inputCls}
            disabled={pending}
          />
        </div>
        <div className="space-y-1">
          <span className={labelCls}>Tipo</span>
          <Select
            value={kind}
            onValueChange={v => setKind(v as 'absence' | 'break')}
            disabled={pending}
            options={[
              { value: 'absence', label: 'Ausencia' },
              { value: 'break', label: 'Descanso' },
            ]}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="absence-reason" className={labelCls}>
          Motivo
          {' '}
          <span className="text-muted-foreground/60">(opcional)</span>
        </label>
        <input
          id="absence-reason"
          type="text"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Ej: enfermedad, cita médica…"
          className={inputCls}
          disabled={pending}
        />
      </div>

      {error && (
        <p className="
          rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2
          text-sm text-destructive
        "
        >
          {error}
        </p>
      )}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Registrando…' : 'Registrar'}
      </Button>
    </form>
  );
}

// ── Absence card ────────────────────────────────────────────────────────────

const STATUS_BADGE = {
  covered: {
    label: 'Cubierto',
    cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  cancelled: {
    label: 'Cancelado',
    cls: 'border-border bg-muted text-muted-foreground',
  },
  open: {
    label: 'Pendiente',
    cls: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
} as const;

function AbsenceCard({
  absence,
  onUpdate,
}: {
  absence: AbsenceListRow;
  onUpdate: () => void;
}) {
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [suggestions, setSuggestions] = useState<CoverageSuggestion[] | null>(null);
  const [loadingSugg, setLoadingSugg] = useState(false);
  const [notifyResult, setNotifyResult] = useState<{
    message: string;
    waLink: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isCovered = absence.status === 'covered';
  const isCancelled = absence.status === 'cancelled';
  const badge
    = STATUS_BADGE[isCovered ? 'covered' : isCancelled ? 'cancelled' : 'open'];

  function loadSuggestions() {
    setError(null);
    setLoadingSugg(true);
    startTransition(async () => {
      const res = await getCoverageSuggestions(absence.id);
      setLoadingSugg(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSuggestions(res.data);
    });
  }

  function handleAssign(replacementId: string) {
    setError(null);
    startTransition(async () => {
      const res = await assignCoverage(absence.id, replacementId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onUpdate();
    });
  }

  function handleNotify(replacementId: string) {
    setError(null);
    setNotifyResult(null);
    startTransition(async () => {
      const res = await notifyReplacement(absence.id, replacementId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const { sendResult, waLink } = res.data;
      if (sendResult.sent) {
        setNotifyResult({ message: 'Notificación enviada por WhatsApp.', waLink: null });
      } else if ('skipped' in sendResult && sendResult.skipped) {
        setNotifyResult({
          message: 'WhatsApp no está configurado.',
          waLink,
        });
      } else {
        setNotifyResult({
          message: `No se pudo enviar: ${'error' in sendResult ? sendResult.error : 'error desconocido'}.`,
          waLink,
        });
      }
      onUpdate();
    });
  }

  function handleCancel() {
    setError(null);
    startTransition(async () => {
      if (isCovered) {
        const ok = await confirm({
          title: '¿Cancelar esta ausencia?',
          description: 'Se perderá el reemplazo asignado.',
          confirmText: 'Cancelar ausencia',
          tone: 'destructive',
        });
        if (!ok) {
          return;
        }
      }
      const res = await cancelAbsence(absence.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onUpdate();
    });
  }

  const kindLabel = absence.kind === 'absence' ? 'Ausencia' : 'Descanso';

  return (
    <div
      className={cn(
        'rounded-lg border bg-background p-4 shadow-xs',
        isCancelled && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">{absence.employeeName}</p>
          <p className="text-sm text-muted-foreground">
            {formatDate(absence.date)}
            {' · '}
            {kindLabel}
            {absence.reason && ` · ${absence.reason}`}
          </p>
          {isCovered && absence.coveredByName && (
            <p className="
              mt-1 text-sm text-emerald-600
              dark:text-emerald-400
            "
            >
              Cubierto por
              {' '}
              {absence.coveredByName}
              {absence.notifiedAt && ' · Notificado'}
            </p>
          )}
        </div>
        <Badge variant="outline" className={badge.cls}>
          {badge.label}
        </Badge>
      </div>

      {!isCancelled && !isCovered && (
        <div className="mt-3 space-y-2">
          {!suggestions && (
            <Button
              variant="outline"
              size="sm"
              onClick={loadSuggestions}
              disabled={pending || loadingSugg}
              className="w-full"
            >
              {loadingSugg ? 'Buscando reemplazos…' : 'Ver reemplazos disponibles'}
            </Button>
          )}

          {suggestions !== null && suggestions.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No hay reemplazos disponibles para este día.
            </p>
          )}

          {suggestions !== null && suggestions.length > 0 && (
            <div className="space-y-2">
              <p className={labelCls}>Reemplazos sugeridos</p>
              {suggestions.map(s => (
                <div
                  key={s.id}
                  className="
                    flex items-center gap-2 rounded-md border bg-muted/30 px-3
                    py-2 text-sm
                  "
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{s.name}</span>
                    {s.phone && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {s.phone}
                      </span>
                    )}
                    {s.scheduledOff && (
                      <Badge
                        variant="outline"
                        className="
                          ml-2 border-blue-500/30 bg-blue-500/10 text-blue-600
                          dark:text-blue-400
                        "
                      >
                        Día libre
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleAssign(s.id)}
                    disabled={pending}
                  >
                    Asignar
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleNotify(s.id)}
                    disabled={pending || !s.phone}
                    title={
                      !s.phone
                        ? 'Este empleado no tiene teléfono registrado'
                        : 'Enviar WhatsApp'
                    }
                    className="
                      text-emerald-600
                      dark:text-emerald-400
                    "
                  >
                    Avisar
                  </Button>
                </div>
              ))}
            </div>
          )}

          {notifyResult && (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              {notifyResult.message}
              {notifyResult.waLink && (
                <>
                  {' '}
                  <a
                    href={notifyResult.waLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="
                      font-medium text-emerald-600 underline
                      dark:text-emerald-400
                    "
                  >
                    Abrir WhatsApp
                  </a>
                </>
              )}
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={handleCancel}
            disabled={pending}
            className="w-full text-destructive"
          >
            Cancelar ausencia
          </Button>
        </div>
      )}

      {isCovered && !isCancelled && (
        <div className="mt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancel}
            disabled={pending}
            className="w-full text-destructive"
          >
            Cancelar
          </Button>
        </div>
      )}

      {error && (
        <p className="
          mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3
          py-1.5 text-sm text-destructive
        "
        >
          {error}
        </p>
      )}
    </div>
  );
}

// ── Main client ─────────────────────────────────────────────────────────────

export function CoverageClient({ initialRoster, initialAbsences, employees, defaultDate }: Props) {
  const router = useRouter();
  const [absences, setAbsences] = useState<AbsenceListRow[]>(initialAbsences);
  const [pending, startTransition] = useTransition();

  // Date range for listing absences (default: rolling 30 days starting today).
  const today = defaultDate;
  const thirtyDaysAhead = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 30);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(d);
  })();

  function refresh() {
    // router.refresh() re-renders the server component tree, which re-fetches
    // both the roster (getTodayRoster) and absence list with fresh data.
    router.refresh();
    startTransition(async () => {
      const res = await listAbsences({ start: today, end: thirtyDaysAhead });
      if (res.ok) {
        setAbsences(res.data);
      }
    });
  }

  const openAbsences = absences.filter(a => a.status === 'open');
  const coveredAbsences = absences.filter(a => a.status === 'covered');

  return (
    <div className="
      grid grid-cols-1 items-start gap-6
      lg:grid-cols-3
    "
    >
      {/* Left: today roster + absence lists */}
      <div className="
        space-y-6
        lg:col-span-2
      "
      >
        <section className="rounded-lg border bg-background p-4 shadow-xs">
          <h2 className="mb-4 text-base font-semibold">Hoy</h2>
          <RosterSection roster={initialRoster} />
        </section>

        {openAbsences.length > 0 && (
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
              Ausencias pendientes de cobertura
              <Badge
                variant="outline"
                className="
                  border-amber-500/40 bg-amber-500/10 text-amber-700
                  dark:text-amber-400
                "
              >
                {openAbsences.length}
              </Badge>
            </h2>
            <div className="space-y-3">
              {openAbsences.map(a => (
                <AbsenceCard key={a.id} absence={a} onUpdate={refresh} />
              ))}
            </div>
          </section>
        )}

        {coveredAbsences.length > 0 && (
          <section>
            <h2 className="mb-3 text-base font-semibold">Ausencias cubiertas</h2>
            <div className="space-y-3">
              {coveredAbsences.map(a => (
                <AbsenceCard key={a.id} absence={a} onUpdate={refresh} />
              ))}
            </div>
          </section>
        )}

        {openAbsences.length === 0 && coveredAbsences.length === 0 && (
          <p className="
            rounded-md border border-dashed py-6 text-center text-sm
            text-muted-foreground
          "
          >
            No hay ausencias registradas para los próximos 30 días.
          </p>
        )}

        {pending && (
          <p className="text-xs text-muted-foreground">Actualizando…</p>
        )}
      </div>

      {/* Right: register form, always at hand */}
      <section className="
        rounded-lg border bg-background p-4 shadow-xs
        lg:sticky lg:top-4
      "
      >
        <h2 className="mb-4 text-base font-semibold">
          Registrar ausencia o descanso
        </h2>
        <RegisterForm
          employees={employees}
          defaultDate={defaultDate}
          onRegistered={refresh}
        />
      </section>
    </div>
  );
}
