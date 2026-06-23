import { describe, expect, it } from 'vitest';
import { resolveSessionResponsable } from './cash-helpers';

// Regression for the caja-rename bug: renaming a caja used to split its closure
// history across the old and new name in the "Responsable" filter, because the
// frozen opened_by/closed_by label (the caja's deviceName at that moment) was
// used as the identifier. resolveSessionResponsable resolves from the STABLE
// identity instead, so every device turn collapses onto the caja's CURRENT name.
describe('resolveSessionResponsable', () => {
  const liveCajaName = 'Local Principal 1';
  // Every name the caja has ever had (current + rename audit trail).
  const cajaNames = new Set(['Local Principal 1', 'caja']);
  const actorNames = new Map([['user_pos_1', 'Juan Pérez']]);

  function resolve(actorId: string | null, label: string | null) {
    return resolveSessionResponsable({
      actorId,
      label,
      liveCajaName,
      cajaNames,
      actorNames,
    });
  }

  it('collapses old and new caja names onto ONE device responsable (the bug)', () => {
    // A close recorded BEFORE the rename (frozen old name) and one recorded after.
    const beforeRename = resolve(null, 'caja');
    const afterRename = resolve(null, 'Local Principal 1');

    // Same stable key → one filter option, both labelled with the current name.
    expect(beforeRename.key).toBe('device');
    expect(afterRename.key).toBe('device');
    expect(beforeRename.key).toBe(afterRename.key);
    expect(beforeRename.label).toBe('Local Principal 1');
    expect(afterRename.label).toBe('Local Principal 1');
  });

  it('a null label (device-only, no operator) resolves to the live caja name', () => {
    expect(resolve(null, null)).toEqual({ key: 'device', label: 'Local Principal 1' });
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

  it('falls back to the caja when the actor id is unknown but the label is a caja name', () => {
    // Stale/unresolvable id (e.g. a deactivated employee) + a caja-name label →
    // treat as the caja rather than leaking a raw id into the UI.
    expect(resolve('user_missing', 'caja')).toEqual({
      key: 'device',
      label: 'Local Principal 1',
    });
  });
});
