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
import { useConfirm } from '@/components/ui/confirm';

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

function RosterSection({ roster }: { roster: RosterEntry[] }) {
  if (roster.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-gray-500">
        No hay empleados activos registrados.
      </p>
    );
  }

  const working = roster.filter(e => e.status === 'working');
  const off = roster.filter(e => e.status === 'off');
  const absent = roster.filter(e => e.status === 'absent');

  return (
    <div className="space-y-4">
      {working.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">Trabajando hoy</h3>
          <ul className="space-y-1">
            {working.map(e => (
              <li key={e.id} className="flex items-center gap-2 rounded border border-green-100 bg-green-50 px-3 py-2 text-sm">
                <span className="size-2 rounded-full bg-green-500" />
                <span className="font-medium">{e.name}</span>
                {e.start && e.end && (
                  <span className="ml-auto text-xs text-gray-500">
                    {e.start}
                    {' '}
                    –
                    {' '}
                    {e.end}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {off.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">Descanso programado</h3>
          <ul className="space-y-1">
            {off.map(e => (
              <li key={e.id} className="flex items-center gap-2 rounded border border-blue-100 bg-blue-50 px-3 py-2 text-sm">
                <span className="size-2 rounded-full bg-blue-400" />
                <span>{e.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {absent.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">Ausentes hoy</h3>
          <ul className="space-y-1">
            {absent.map(e => (
              <li key={e.id} className="flex items-center gap-2 rounded border border-red-100 bg-red-50 px-3 py-2 text-sm">
                <span className="size-2 rounded-full bg-red-400" />
                <span>{e.name}</span>
                <span className="ml-auto text-xs text-gray-500">
                  {e.coveredByName
                    ? `Cubierto por ${e.coveredByName}`
                    : 'Sin cubrir'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
      setError('Seleccioná un empleado');
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
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Empleado
        </label>
        <select
          value={employeeId}
          onChange={e => setEmployeeId(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={pending}
        >
          <option value="">— Seleccioná un empleado —</option>
          {employees.map(emp => (
            <option key={emp.id} value={emp.id}>
              {emp.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Fecha
          </label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={pending}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Tipo
          </label>
          <select
            value={kind}
            onChange={e => setKind(e.target.value as 'absence' | 'break')}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={pending}
          >
            <option value="absence">Ausencia</option>
            <option value="break">Descanso</option>
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Motivo
          {' '}
          <span className="text-gray-400">(opcional)</span>
        </label>
        <input
          type="text"
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Ej: enfermedad, cita médica…"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={pending}
        />
      </div>

      {error && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? 'Registrando…' : 'Registrar'}
      </button>
    </form>
  );
}

// ── Absence card ────────────────────────────────────────────────────────────

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
    <div className={`rounded border p-4 ${isCancelled ? 'border-gray-200 bg-gray-50 opacity-60' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-gray-900">{absence.employeeName}</p>
          <p className="text-sm text-gray-500">
            {formatDate(absence.date)}
            {' '}
            ·
            {' '}
            {kindLabel}
            {absence.reason && ` · ${absence.reason}`}
          </p>
          {isCovered && absence.coveredByName && (
            <p className="mt-1 text-sm text-green-700">
              Cubierto por
              {' '}
              {absence.coveredByName}
              {absence.notifiedAt && ' · Notificado'}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              isCovered
                ? 'bg-green-100 text-green-700'
                : isCancelled
                  ? 'bg-gray-100 text-gray-500'
                  : 'bg-yellow-100 text-yellow-700'
            }`}
          >
            {isCovered ? 'Cubierto' : isCancelled ? 'Cancelado' : 'Pendiente'}
          </span>
        </div>
      </div>

      {!isCancelled && !isCovered && (
        <div className="mt-3 space-y-2">
          {!suggestions && (
            <button
              type="button"
              onClick={loadSuggestions}
              disabled={pending || loadingSugg}
              className="w-full rounded border border-blue-300 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-50"
            >
              {loadingSugg ? 'Buscando reemplazos…' : 'Ver reemplazos disponibles'}
            </button>
          )}

          {suggestions !== null && suggestions.length === 0 && (
            <p className="text-sm text-gray-500">No hay reemplazos disponibles para este día.</p>
          )}

          {suggestions !== null && suggestions.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Reemplazos sugeridos</p>
              {suggestions.map(s => (
                <div key={s.id} className="flex items-center gap-2 rounded border border-gray-100 bg-gray-50 px-3 py-2 text-sm">
                  <div className="flex-1">
                    <span className="font-medium">{s.name}</span>
                    {s.phone && <span className="ml-2 text-xs text-gray-500">{s.phone}</span>}
                    {s.scheduledOff && (
                      <span className="ml-2 rounded-full bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">
                        Día libre
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleAssign(s.id)}
                    disabled={pending}
                    className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-white disabled:opacity-50"
                  >
                    Asignar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleNotify(s.id)}
                    disabled={pending || !s.phone}
                    className="rounded border border-green-300 px-2 py-1 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50"
                    title={!s.phone ? 'Este empleado no tiene teléfono registrado' : 'Enviar WhatsApp'}
                  >
                    Avisar
                  </button>
                </div>
              ))}
            </div>
          )}

          {notifyResult && (
            <div className="rounded bg-gray-50 px-3 py-2 text-sm text-gray-700">
              {notifyResult.message}
              {notifyResult.waLink && (
                <>
                  {' '}
                  <a
                    href={notifyResult.waLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-green-700 underline"
                  >
                    Abrir WhatsApp
                  </a>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            className="w-full rounded border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Cancelar ausencia
          </button>
        </div>
      )}

      {isCovered && !isCancelled && (
        <div className="mt-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            className="w-full rounded border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Cancelar
          </button>
        </div>
      )}

      {error && (
        <p className="mt-2 rounded bg-red-50 px-3 py-1.5 text-sm text-red-600">{error}</p>
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
    <div className="space-y-8">
      {/* ── Hoy ── */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Hoy</h2>
        <RosterSection roster={initialRoster} />
      </section>

      {/* ── Registrar ausencia ── */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          Registrar ausencia o descanso
        </h2>
        <div className="max-w-md rounded border border-gray-200 bg-white p-4">
          <RegisterForm
            employees={employees}
            defaultDate={defaultDate}
            onRegistered={() => {
              refresh();
            }}
          />
        </div>
      </section>

      {/* ── Ausencias abiertas ── */}
      {openAbsences.length > 0 && (
        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-900">
            Ausencias pendientes de cobertura
            <span className="ml-2 inline-flex size-5 items-center justify-center rounded-full bg-yellow-100 text-xs font-bold text-yellow-700">
              {openAbsences.length}
            </span>
          </h2>
          <div className="space-y-3">
            {openAbsences.map(a => (
              <AbsenceCard key={a.id} absence={a} onUpdate={refresh} />
            ))}
          </div>
        </section>
      )}

      {/* ── Ausencias cubiertas ── */}
      {coveredAbsences.length > 0 && (
        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-900">
            Ausencias cubiertas
          </h2>
          <div className="space-y-3">
            {coveredAbsences.map(a => (
              <AbsenceCard key={a.id} absence={a} onUpdate={refresh} />
            ))}
          </div>
        </section>
      )}

      {openAbsences.length === 0 && coveredAbsences.length === 0 && (
        <p className="text-sm text-gray-500">
          No hay ausencias registradas para los próximos 30 días.
        </p>
      )}

      {pending && (
        <p className="text-xs text-gray-400">Actualizando…</p>
      )}
    </div>
  );
}
