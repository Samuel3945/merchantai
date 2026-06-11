/**
 * Coverage-matching helpers for the Turnos (staff scheduling) module.
 *
 * A "replacement candidate" for a given absence date is an active employee
 * who is NOT already scheduled to work that day — specifically, one whose
 * work_schedule entry for that weekday is { off: true } OR is absent (missing
 * key = flexible / no fixed schedule for that day). Employees with an active
 * absence (open or covered) on that same date are excluded, as is the absent
 * employee themselves.
 */

import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { posUsersSchema, staffAbsencesSchema } from '@/models/Schema';

type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

type WorkDayEntry = {
  start?: string;
  end?: string;
  off?: boolean;
};

type WorkSchedule = Partial<Record<WeekdayKey, WorkDayEntry>>;

const UTC_DAY_TO_KEY: WeekdayKey[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];

/**
 * Derives the ISO weekday key from a plain YYYY-MM-DD date string.
 *
 * IMPORTANT — timezone contract: `date` MUST be a Bogota-local YYYY-MM-DD
 * string (e.g. the result of `todayBogota()` or a validated date input from
 * the UI). By appending `T00:00:00Z` we interpret it as UTC midnight, which
 * gives the correct weekday without any timezone shift — because the date
 * digits already represent the Bogota-local calendar day. If a caller ever
 * passes a UTC date that differs from the Bogota-local date (e.g. late-night
 * UTC where Bogota is still the previous day), the weekday will be wrong.
 * Do NOT change the `T00:00:00Z` suffix without updating all callers.
 */
export function weekdayKey(date: string): WeekdayKey {
  // Force UTC midnight so no timezone shift can change the weekday.
  const d = new Date(`${date}T00:00:00Z`);
  return UTC_DAY_TO_KEY[d.getUTCDay()] as WeekdayKey;
}

export type ReplacementCandidate = {
  id: string;
  name: string;
  phone: string | null;
  /** True when that day is explicitly marked as a rest day in their schedule. */
  scheduledOff: boolean;
};

/**
 * Returns the list of active employees in `orgId` who could cover an absence
 * on `date`, excluding `absentEmployeeId` and anyone already absent (open or
 * covered) on that same date.
 *
 * Availability rule:
 *  - The candidate's work_schedule for that weekday is { off: true } — it is
 *    their scheduled rest day, so they could be asked to cover.
 *  - OR the weekday key is absent from their schedule (flexible / no fixed
 *    schedule) — we don't know they're busy, so they're a candidate.
 *  — Employees who have an open or covered schedule entry for that day are
 *    excluded (they are already expected to work).
 *
 * Ranking: candidates with a phone number first (contactable), then alphabetically.
 */
export async function findAvailableReplacements(
  orgId: string,
  date: string,
  absentEmployeeId: string,
): Promise<ReplacementCandidate[]> {
  const day = weekdayKey(date);

  // 1. Load all active employees in the org, excluding the absent one.
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
        ne(posUsersSchema.id, absentEmployeeId),
      ),
    );

  if (employees.length === 0) {
    return [];
  }

  // 2. Find employee IDs who are already busy on that date — either:
  //    a) They have their own open/covered absence (they are the absent employee).
  //    b) They are already assigned as `covered_by` on someone else's absence that
  //       day (double-booking risk — they are already covering a shift).
  const busyAbsences = await db
    .select({
      employeeId: staffAbsencesSchema.employeeId,
      coveredBy: staffAbsencesSchema.coveredBy,
    })
    .from(staffAbsencesSchema)
    .where(
      and(
        eq(staffAbsencesSchema.organizationId, orgId),
        eq(staffAbsencesSchema.date, date),
        inArray(staffAbsencesSchema.status, ['open', 'covered']),
        notInArray(staffAbsencesSchema.employeeId, [absentEmployeeId]),
      ),
    );

  const busyIds = new Set<string>();
  for (const r of busyAbsences) {
    busyIds.add(r.employeeId);
    if (r.coveredBy) {
      busyIds.add(r.coveredBy);
    }
  }

  // 3. Filter to available candidates.
  //    Available = NOT already absent that day AND (schedule marks day as off OR
  //    day is missing from schedule).
  const candidates: ReplacementCandidate[] = [];

  for (const emp of employees) {
    if (busyIds.has(emp.id)) {
      continue;
    }

    const schedule = (emp.workSchedule ?? {}) as WorkSchedule;
    const dayEntry = schedule[day];

    if (dayEntry === undefined) {
      // No fixed schedule for this day — flexible, could be available.
      candidates.push({
        id: emp.id,
        name: emp.name,
        phone: emp.phone,
        scheduledOff: false,
      });
    } else if (dayEntry.off === true) {
      // Explicitly marked as rest day.
      candidates.push({
        id: emp.id,
        name: emp.name,
        phone: emp.phone,
        scheduledOff: true,
      });
    }
    // If dayEntry exists and off !== true, the employee is scheduled to work → skip.
  }

  // 4. Rank: scheduled-off first (they ARE free), then flexible, both sub-sorted
  //    by: has phone (contactable) first, then alphabetically.
  candidates.sort((a, b) => {
    // Scheduled-off before flexible.
    if (a.scheduledOff !== b.scheduledOff) {
      return a.scheduledOff ? -1 : 1;
    }
    // Within same scheduledOff tier: with phone before without.
    const aHasPhone = a.phone ? 1 : 0;
    const bHasPhone = b.phone ? 1 : 0;
    if (aHasPhone !== bHasPhone) {
      return bHasPhone - aHasPhone;
    }
    return a.name.localeCompare(b.name);
  });

  return candidates;
}
