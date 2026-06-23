import { describe, expect, it } from 'vitest';
import { resolveSessionResponsable } from './cash-helpers';

// Regression for the caja-rename bug: renaming a caja used to split its closure
// history across the old and new name in the "Responsable" filter, because the
// frozen opened_by/closed_by label (the caja's deviceName at that moment) was
// used as the identifier. resolveSessionResponsable resolves from the STABLE
// identity instead; a person-less turn collapses onto ONE "Sin identificar"
// option — never the caja name (a caja is not a responsable).
describe('resolveSessionResponsable', () => {
  // Every name the caja has ever had (current + rename audit trail).
  const cajaNames = new Set(['Local Principal 1', 'caja']);
  const actorNames = new Map([['user_pos_1', 'Juan Pérez']]);

  function resolve(actorId: string | null, label: string | null) {
    return resolveSessionResponsable({
      actorId,
      label,
      cajaNames,
      actorNames,
    });
  }

  it('collapses old and new caja names onto ONE person-less responsable (the bug)', () => {
    // A close recorded BEFORE the rename (frozen old name) and one recorded after.
    const beforeRename = resolve(null, 'caja');
    const afterRename = resolve(null, 'Local Principal 1');

    // Same stable key → one filter option, never the caja name.
    expect(beforeRename.key).toBe('device');
    expect(afterRename.key).toBe('device');
    expect(beforeRename.key).toBe(afterRename.key);
    expect(beforeRename.label).toBe('Sin identificar');
    expect(afterRename.label).toBe('Sin identificar');
  });

  it('a null label (device-only, no operator) resolves to "Sin identificar"', () => {
    expect(resolve(null, null)).toEqual({ key: 'device', label: 'Sin identificar' });
  });

  it('resolves a known actor id to the LIVE person name, keyed by the id', () => {
    expect(resolve('user_pos_1', 'caja')).toEqual({
      key: 'user_pos_1',
      label: 'Juan Pérez',
    });
  });

  it('keeps a legacy person label we cannot tie to an id, distinct from the caja', () => {
    const r = resolve(null, 'María (dueña)');

    expect(r.label).toBe('María (dueña)');
    expect(r.key).toBe('legacy:María (dueña)');
    // It must NOT collapse into the caja's device bucket.
    expect(r.key).not.toBe('device');
  });

  it('falls back to "Sin identificar" when the actor id is unknown and the label is a caja name', () => {
    // Stale/unresolvable id (e.g. a deactivated employee) + a caja-name label →
    // no identified person, rather than leaking a raw id or the caja name.
    expect(resolve('user_missing', 'caja')).toEqual({
      key: 'device',
      label: 'Sin identificar',
    });
  });

  // Movement history feeds createdBy as BOTH actorId and label (cash_movements has
  // no separate id column); the resolver must still classify each createdBy shape.
  describe('movement createdBy (actorId === label)', () => {
    function fromCreatedBy(createdBy: string) {
      return resolve(createdBy, createdBy);
    }

    it('resolves a sale movement that stored the cashier id to the live name', () => {
      // Pre-existing bug: this used to render the raw UUID. Now it shows the name.
      expect(fromCreatedBy('user_pos_1')).toEqual({
        key: 'user_pos_1',
        label: 'Juan Pérez',
      });
    });

    it('collapses a device-only movement (createdBy = old caja name) to "Sin identificar"', () => {
      expect(fromCreatedBy('caja')).toEqual({ key: 'device', label: 'Sin identificar' });
    });

    it('keeps a plain person name (manual movement by a named cashier) verbatim', () => {
      expect(fromCreatedBy('Ana')).toEqual({ key: 'legacy:Ana', label: 'Ana' });
    });
  });
});
