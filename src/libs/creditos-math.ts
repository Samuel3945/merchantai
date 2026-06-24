import { Buffer } from 'node:buffer';

// Pure, dependency-free money + identity logic for creditos. No db, no clerk — so
// it can be unit-tested directly and reused by the server core (libs/creditos.ts).
// This is where the money-critical rules live (FIFO distribution, the credited
// amount, client grouping), isolated so they can be tested exhaustively.

// Rounds to 2 decimal places using integer arithmetic. Avoids IEEE 754 edge
// cases where toFixed can lose a cent (e.g. 10.005 → 10.004999... → "10.00").
// The epsilon correction guards against values that land just below the next
// cent due to floating-point representation.
export function round2(n: number): number {
  return Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100 * (n < 0 ? -1 : 1);
}

const NOTES_NAME_RE = /(?:Cliente|Nombre):\s*([^|]+)/i;
const NOTES_PHONE_RE = /Tel:\s*([^|]+)/i;

export function parseClient(notes: string | null): { name: string; phone: string } {
  if (!notes) {
    return { name: '', phone: '' };
  }
  return {
    name: notes.match(NOTES_NAME_RE)?.[1]?.trim() ?? '',
    phone: notes.match(NOTES_PHONE_RE)?.[1]?.trim() ?? '',
  };
}

// Stable grouping key for "this debt belongs to this client". Prefers the real
// customer FK; falls back to the notes-parsed name+phone for legacy/unlinked
// creditos so historical data still groups correctly during the migration.
export function clientKeyOf(row: {
  customerId: string | null;
  notes: string | null;
}): string {
  if (row.customerId) {
    return `c:${row.customerId}`;
  }
  const { name, phone } = parseClient(row.notes);
  return `n:${Buffer.from(`${name}||${phone}`, 'utf8').toString('base64url')}`;
}

// Accepts either a new-format key (c:/n:) or a legacy POS key (raw
// base64url(name||phone)) and returns the canonical new-format key. Keeps the
// cashier app working through the cutover.
export function normalizeClientKey(key: string): string {
  if (key.startsWith('c:') || key.startsWith('n:')) {
    return key;
  }
  return `n:${key}`;
}

export type AbonoPlanEntry = { creditoId: string; apply: number; settle: boolean };
export type AbonoPlan = {
  entries: AbonoPlanEntry[];
  appliedTotal: number;
  remaining: number;
};

// FIFO distribution of an abono across a client's creditos, which MUST already be
// ordered oldest-due-first. Each credito is paid down to zero before the next is
// touched; an over-payment leaves a positive `remaining`. A credito already at
// zero balance is settled (apply 0) so a stale "pending" row can self-heal.
// Pure and side-effect free: the caller does the DB writes from `entries`.
export function planAbono(
  creditos: { id: string; balance: number }[],
  amount: number,
): AbonoPlan {
  let remaining = round2(amount);
  const entries: AbonoPlanEntry[] = [];
  for (const f of creditos) {
    if (remaining <= 0) {
      break;
    }
    const balance = round2(f.balance);
    if (balance <= 0) {
      entries.push({ creditoId: f.id, apply: 0, settle: true });
      continue;
    }
    const apply = round2(Math.min(remaining, balance));
    remaining = round2(remaining - apply);
    entries.push({ creditoId: f.id, apply, settle: apply >= balance });
  }
  return {
    entries,
    appliedTotal: round2(amount - remaining),
    remaining: round2(remaining),
  };
}

// The credit a credito sale books: the total minus any upfront payment made with a
// non-credito method. A 100%-credito sale owes the full total; a split sale (part
// efectivo now, rest credito) owes only the remainder.
export function creditoAmountFor(
  total: number,
  payments: { method: string; amount: number | string }[],
): number {
  const nonCreditoPaid = payments
    .filter(p => !/credito/i.test(p.method))
    .reduce((acc, p) => acc + (Number.parseFloat(String(p.amount)) || 0), 0);
  return round2(total - nonCreditoPaid);
}
