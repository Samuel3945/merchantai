'use server';

import type { ActionResult } from '@/libs/action-result';
import type { WhatsAppSendResult } from '@/libs/delivery-whatsapp';
import { auth } from '@clerk/nextjs/server';
import { and, between, desc, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { logAction } from '@/libs/audit-log';
import { findAvailableReplacements, weekdayKey } from '@/libs/coverage';
import { db } from '@/libs/DB';
import { sendWhatsAppText } from '@/libs/delivery-whatsapp';
import { posUsersSchema, staffAbsencesSchema } from '@/models/Schema';

// ---------------------------------------------------------------------------
// Auth helper — mirrors employees.ts requireAdminContext() exactly.
// CRITICAL: `orgRole !== 'org:admin'` — never `orgRole && orgRole !== ...`
// ---------------------------------------------------------------------------
async function requireAdminContext() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    throw new Error('Not authenticated');
  }
  if (!orgId) {
    throw new Error('No active organization');
  }
  if (orgRole !== 'org:admin') {
    throw new Error('Only organization admins can manage staff coverage');
  }
  return { userId, orgId };
}

// ---------------------------------------------------------------------------
// Today's Bogota-local date as YYYY-MM-DD.
// ---------------------------------------------------------------------------
function todayBogota(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

// ---------------------------------------------------------------------------
// registerAbsence
// ---------------------------------------------------------------------------
export type RegisterAbsenceInput = {
  employeeId: string;
  date: string; // YYYY-MM-DD
  kind: 'absence' | 'break';
  reason?: string | null;
};

export type AbsenceRow = typeof staffAbsencesSchema.$inferSelect;

export async function registerAbsence(
  input: RegisterAbsenceInput,
): Promise<ActionResult<AbsenceRow>> {
  const { userId, orgId } = await requireAdminContext();

  const date = input.date?.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: 'La fecha no es válida (se espera AAAA-MM-DD)' };
  }
  if (input.kind !== 'absence' && input.kind !== 'break') {
    return { ok: false, error: 'El tipo debe ser "ausencia" o "descanso"' };
  }

  // Validate the employee belongs to this org.
  const [employee] = await db
    .select({ id: posUsersSchema.id })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.id, input.employeeId),
        eq(posUsersSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!employee) {
    return { ok: false, error: 'Empleado no encontrado en tu organización' };
  }

  const [inserted] = await db
    .insert(staffAbsencesSchema)
    .values({
      organizationId: orgId,
      employeeId: input.employeeId,
      date,
      kind: input.kind,
      reason: input.reason ?? null,
      status: 'open',
      createdBy: userId,
    })
    .returning();

  if (!inserted) {
    throw new Error('Failed to register absence');
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'absence.registered',
    entityType: 'staff_absence',
    entityId: inserted.id,
    after: {
      employeeId: inserted.employeeId,
      date: inserted.date,
      kind: inserted.kind,
      status: inserted.status,
    },
  });

  revalidatePath('/dashboard/turnos');
  return { ok: true, data: inserted };
}

// ---------------------------------------------------------------------------
// listAbsences
// ---------------------------------------------------------------------------
export type AbsenceListRow = {
  id: string;
  date: string;
  kind: string;
  reason: string | null;
  status: string;
  notifiedAt: Date | null;
  createdAt: Date;
  employeeId: string;
  employeeName: string;
  coveredBy: string | null;
  coveredByName: string | null;
};

export async function listAbsences(params: {
  start: string;
  end: string;
}): Promise<ActionResult<AbsenceListRow[]>> {
  const { orgId } = await requireAdminContext();

  const start = params.start?.trim();
  const end = params.end?.trim();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!start || !dateRe.test(start) || !end || !dateRe.test(end)) {
    return { ok: false, error: 'Las fechas no son válidas (se espera AAAA-MM-DD)' };
  }

  // Self-join pos_users twice: once for the absent employee, once for the cover.
  // Drizzle doesn't support self-join aliases directly, so we use aliasedTable.
  const absences = await db
    .select({
      id: staffAbsencesSchema.id,
      date: staffAbsencesSchema.date,
      kind: staffAbsencesSchema.kind,
      reason: staffAbsencesSchema.reason,
      status: staffAbsencesSchema.status,
      notifiedAt: staffAbsencesSchema.notifiedAt,
      createdAt: staffAbsencesSchema.createdAt,
      employeeId: staffAbsencesSchema.employeeId,
      coveredBy: staffAbsencesSchema.coveredBy,
    })
    .from(staffAbsencesSchema)
    .where(
      and(
        eq(staffAbsencesSchema.organizationId, orgId),
        between(staffAbsencesSchema.date, start, end),
      ),
    )
    .orderBy(desc(staffAbsencesSchema.createdAt));

  if (absences.length === 0) {
    return { ok: true, data: [] };
  }

  // Collect all employee IDs needed for name resolution.
  const empIds = [...new Set([
    ...absences.map(a => a.employeeId),
    ...absences.map(a => a.coveredBy).filter((id): id is string => id !== null),
  ])];

  const empRows = await db
    .select({ id: posUsersSchema.id, name: posUsersSchema.name })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, orgId),
        inArray(posUsersSchema.id, empIds),
      ),
    );

  const empMap = new Map(empRows.map(e => [e.id, e.name]));

  return {
    ok: true,
    data: absences.map(a => ({
      ...a,
      employeeName: empMap.get(a.employeeId) ?? a.employeeId,
      coveredByName: a.coveredBy ? (empMap.get(a.coveredBy) ?? a.coveredBy) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// getCoverageSuggestions
// ---------------------------------------------------------------------------
export type CoverageSuggestion = {
  id: string;
  name: string;
  phone: string | null;
  scheduledOff: boolean;
};

export async function getCoverageSuggestions(
  absenceId: string,
): Promise<ActionResult<CoverageSuggestion[]>> {
  const { orgId } = await requireAdminContext();

  const [absence] = await db
    .select()
    .from(staffAbsencesSchema)
    .where(
      and(
        eq(staffAbsencesSchema.id, absenceId),
        eq(staffAbsencesSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!absence) {
    return { ok: false, error: 'Ausencia no encontrada' };
  }

  const candidates = await findAvailableReplacements(
    orgId,
    absence.date,
    absence.employeeId,
  );

  return { ok: true, data: candidates };
}

// ---------------------------------------------------------------------------
// assignCoverage
// ---------------------------------------------------------------------------
export async function assignCoverage(
  absenceId: string,
  replacementEmployeeId: string,
): Promise<ActionResult<{ id: string }>> {
  const { userId, orgId } = await requireAdminContext();

  // Validate absence belongs to org.
  const [absence] = await db
    .select()
    .from(staffAbsencesSchema)
    .where(
      and(
        eq(staffAbsencesSchema.id, absenceId),
        eq(staffAbsencesSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!absence) {
    return { ok: false, error: 'Ausencia no encontrada' };
  }
  if (absence.status === 'cancelled') {
    return { ok: false, error: 'No se puede asignar cobertura a una ausencia cancelada' };
  }

  // Validate replacement belongs to org.
  const [replacement] = await db
    .select({ id: posUsersSchema.id })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.id, replacementEmployeeId),
        eq(posUsersSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!replacement) {
    return { ok: false, error: 'El empleado de reemplazo no pertenece a tu organización' };
  }

  if (replacementEmployeeId === absence.employeeId) {
    return { ok: false, error: 'No podés asignar al empleado ausente como su propio reemplazo' };
  }

  const [updated] = await db
    .update(staffAbsencesSchema)
    .set({ coveredBy: replacementEmployeeId, status: 'covered' })
    .where(
      and(
        eq(staffAbsencesSchema.id, absenceId),
        eq(staffAbsencesSchema.organizationId, orgId),
      ),
    )
    .returning({ id: staffAbsencesSchema.id });

  if (!updated) {
    return { ok: false, error: 'No se pudo actualizar la ausencia' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'absence.coverage_assigned',
    entityType: 'staff_absence',
    entityId: absenceId,
    before: { status: absence.status, coveredBy: absence.coveredBy },
    after: { status: 'covered', coveredBy: replacementEmployeeId },
  });

  revalidatePath('/dashboard/turnos');
  return { ok: true, data: updated };
}

// ---------------------------------------------------------------------------
// notifyReplacement
// ---------------------------------------------------------------------------
export type NotifyReplacementResult = {
  sendResult: WhatsAppSendResult;
  /** wa.me fallback link so the UI can offer a tap-to-send button. */
  waLink: string | null;
};

export async function notifyReplacement(
  absenceId: string,
  replacementEmployeeId: string,
): Promise<ActionResult<NotifyReplacementResult>> {
  const { userId, orgId } = await requireAdminContext();

  // Load absence (org-scoped).
  const [absence] = await db
    .select()
    .from(staffAbsencesSchema)
    .where(
      and(
        eq(staffAbsencesSchema.id, absenceId),
        eq(staffAbsencesSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!absence) {
    return { ok: false, error: 'Ausencia no encontrada' };
  }

  // Load absent employee.
  const [absentEmp] = await db
    .select({
      name: posUsersSchema.name,
      workSchedule: posUsersSchema.workSchedule,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.id, absence.employeeId),
        eq(posUsersSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  // Load replacement employee.
  const [replacementEmp] = await db
    .select({
      id: posUsersSchema.id,
      name: posUsersSchema.name,
      phone: posUsersSchema.phone,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.id, replacementEmployeeId),
        eq(posUsersSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!replacementEmp) {
    return { ok: false, error: 'El empleado de reemplazo no pertenece a tu organización' };
  }

  if (replacementEmployeeId === absence.employeeId) {
    return { ok: false, error: 'No podés notificar al empleado ausente como su propio reemplazo' };
  }

  // Build a human-readable date string in Spanish.
  const [y, m, d] = absence.date.split('-').map(Number);
  const readableDate = new Intl.DateTimeFormat('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)));

  // Build schedule hint for that day if the absent employee has one.
  let scheduleHint = '';
  if (absentEmp?.workSchedule) {
    const day = weekdayKey(absence.date);
    const sched = (absentEmp.workSchedule as Record<string, { start?: string; end?: string; off?: boolean } | undefined>)[day];
    if (sched && !sched.off && sched.start && sched.end) {
      scheduleHint = ` (turno de ${sched.start} a ${sched.end})`;
    }
  }

  const absentName = absentEmp?.name ?? 'Tu compañero/a';
  const message = `Hola ${replacementEmp.name}, ${absentName} no puede cubrir su turno el ${readableDate}${scheduleHint}. ¿Podés cubrirlo? Avisanos por favor.`;

  // Build wa.me fallback link.
  const digits = replacementEmp.phone ? replacementEmp.phone.replace(/\D/g, '') : null;
  const waLink = digits
    ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
    : null;

  const sendResult = await sendWhatsAppText(replacementEmp.phone, message);

  // If sent successfully, persist the notification timestamp.
  if (sendResult.sent) {
    await db
      .update(staffAbsencesSchema)
      .set({ notifiedAt: new Date() })
      .where(
        and(
          eq(staffAbsencesSchema.id, absenceId),
          eq(staffAbsencesSchema.organizationId, orgId),
        ),
      );

    await logAction({
      organizationId: orgId,
      actor: { type: 'user', id: userId },
      action: 'absence.replacement_notified',
      entityType: 'staff_absence',
      entityId: absenceId,
      after: {
        replacementId: replacementEmployeeId,
        replacementName: replacementEmp.name,
        date: absence.date,
      },
    });
  }

  revalidatePath('/dashboard/turnos');
  return { ok: true, data: { sendResult, waLink } };
}

// ---------------------------------------------------------------------------
// cancelAbsence
// ---------------------------------------------------------------------------
export async function cancelAbsence(
  absenceId: string,
): Promise<ActionResult<{ id: string }>> {
  const { userId, orgId } = await requireAdminContext();

  const [absence] = await db
    .select()
    .from(staffAbsencesSchema)
    .where(
      and(
        eq(staffAbsencesSchema.id, absenceId),
        eq(staffAbsencesSchema.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!absence) {
    return { ok: false, error: 'Ausencia no encontrada' };
  }

  const [updated] = await db
    .update(staffAbsencesSchema)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(staffAbsencesSchema.id, absenceId),
        eq(staffAbsencesSchema.organizationId, orgId),
      ),
    )
    .returning({ id: staffAbsencesSchema.id });

  if (!updated) {
    return { ok: false, error: 'No se pudo cancelar la ausencia' };
  }

  await logAction({
    organizationId: orgId,
    actor: { type: 'user', id: userId },
    action: 'absence.cancelled',
    entityType: 'staff_absence',
    entityId: absenceId,
    before: { status: absence.status },
    after: { status: 'cancelled' },
  });

  revalidatePath('/dashboard/turnos');
  return { ok: true, data: updated };
}

// ---------------------------------------------------------------------------
// getTodayRoster
// ---------------------------------------------------------------------------
export type RosterEntry = {
  id: string;
  name: string;
  phone: string | null;
  // 'working' | 'off' | 'absent'
  status: 'working' | 'off' | 'absent';
  // Scheduled start–end for working employees.
  start?: string;
  end?: string;
  // Who is covering (if absent and covered).
  coveredByName?: string | null;
  // Absence id so the UI can act on it.
  absenceId?: string;
};

export async function getTodayRoster(): Promise<RosterEntry[]> {
  const { orgId } = await requireAdminContext();

  const today = todayBogota();
  const day = weekdayKey(today);

  // Load all active employees.
  const employees = await db
    .select({
      id: posUsersSchema.id,
      name: posUsersSchema.name,
      phone: posUsersSchema.phone,
      workSchedule: posUsersSchema.workSchedule,
    })
    .from(posUsersSchema)
    .where(
      and(
        eq(posUsersSchema.organizationId, orgId),
        eq(posUsersSchema.active, true),
      ),
    );

  if (employees.length === 0) {
    return [];
  }

  // Load today's absences (open or covered).
  const absences = await db
    .select({
      id: staffAbsencesSchema.id,
      employeeId: staffAbsencesSchema.employeeId,
      status: staffAbsencesSchema.status,
      coveredBy: staffAbsencesSchema.coveredBy,
    })
    .from(staffAbsencesSchema)
    .where(
      and(
        eq(staffAbsencesSchema.organizationId, orgId),
        eq(staffAbsencesSchema.date, today),
        inArray(staffAbsencesSchema.status, ['open', 'covered']),
      ),
    );

  // Build a lookup: employeeId → absence row (take first if multiple somehow).
  const absenceByEmp = new Map(absences.map(a => [a.employeeId, a]));

  // Collect cover-employee IDs for name resolution.
  const coverIds = absences
    .map(a => a.coveredBy)
    .filter((id): id is string => id !== null);

  const coverEmpRows = coverIds.length > 0
    ? await db
        .select({ id: posUsersSchema.id, name: posUsersSchema.name })
        .from(posUsersSchema)
        .where(
          and(
            eq(posUsersSchema.organizationId, orgId),
            inArray(posUsersSchema.id, coverIds),
          ),
        )
    : [];

  const coverNameMap = new Map(coverEmpRows.map(e => [e.id, e.name]));

  type WorkDayEntry = { start?: string; end?: string; off?: boolean };

  return employees.map((emp): RosterEntry => {
    const schedule = (emp.workSchedule ?? {}) as Record<string, WorkDayEntry | undefined>;
    const dayEntry = schedule[day];
    const absence = absenceByEmp.get(emp.id);

    if (absence) {
      return {
        id: emp.id,
        name: emp.name,
        phone: emp.phone,
        status: 'absent',
        coveredByName: absence.coveredBy
          ? (coverNameMap.get(absence.coveredBy) ?? null)
          : null,
        absenceId: absence.id,
      };
    }

    if (dayEntry?.off === true) {
      return {
        id: emp.id,
        name: emp.name,
        phone: emp.phone,
        status: 'off',
      };
    }

    // No absence, not a rest day → working.
    return {
      id: emp.id,
      name: emp.name,
      phone: emp.phone,
      status: 'working',
      start: dayEntry?.start,
      end: dayEntry?.end,
    };
  });
}
