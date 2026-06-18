/**
 * M1 — server-side validation for recordGasto.
 *
 * The 'otros' category demands a non-empty description. The legacy
 * createExpense action enforced this; when it was deleted (slice 3) the rule
 * had to be carried over to recordGasto so it is not only a client-side check.
 *
 * Strict TDD: RED test written before the server-side guard is added.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  orgId: 'org-gasto-test',
  userId: 'user_test',
}));

// recordGasto returns BEFORE any DB/auth side effect when the input is invalid,
// but requirePanelModule runs first — mock it so the action reaches validation.
vi.mock('@/libs/panel-session', () => ({
  requirePanelModule: vi.fn(async () => ({
    userId: h.userId,
    orgId: h.orgId,
  })),
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: h.userId, orgId: h.orgId, orgRole: 'org:admin' })),
  currentUser: vi.fn(async () => ({ fullName: 'Test User' })),
}));

vi.mock('@/libs/DB', () => ({
  db: {},
}));

vi.mock('@/libs/audit-log', () => ({
  logAction: vi.fn(async () => {}),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordGasto — \'otros\' requires a description (M1)', () => {
  it('rejects category \'otros\' with a blank description', async () => {
    const { recordGasto } = await import('./treasury');

    const result = await recordGasto({
      fromAccountId: '00000000-0000-0000-0000-000000000001',
      amount: 100,
      category: 'otros',
      description: '   ',
      incurredOn: '2026-06-18',
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toMatch(/descripción/i);
    }
  });

  it('rejects category \'otros\' with no description at all', async () => {
    const { recordGasto } = await import('./treasury');

    const result = await recordGasto({
      fromAccountId: '00000000-0000-0000-0000-000000000001',
      amount: 100,
      category: 'otros',
      incurredOn: '2026-06-18',
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error).toMatch(/descripción/i);
    }
  });
});
