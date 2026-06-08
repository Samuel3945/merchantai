import { describe, expect, it } from 'vitest';
import {
  clientKeyOf,
  fiadoAmountFor,
  normalizeClientKey,
  parseClient,
  planAbono,
  round2,
} from '@/libs/fiados-math';

// Money-critical pure logic for fiados. These are the rules that decide how much
// a customer owes and how an abono is distributed — exercised exhaustively here
// so a regression can never silently move money.

describe('planAbono (FIFO distribution)', () => {
  it('partial abono reduces one fiado without settling it', () => {
    const r = planAbono([{ id: 'a', balance: 100 }], 60);

    expect(r.entries).toEqual([{ fiadoId: 'a', apply: 60, settle: false }]);
    expect(r.appliedTotal).toBe(60);
    expect(r.remaining).toBe(0);
  });

  it('exact abono settles the fiado', () => {
    const r = planAbono([{ id: 'a', balance: 100 }], 100);

    expect(r.entries).toEqual([{ fiadoId: 'a', apply: 100, settle: true }]);
    expect(r.appliedTotal).toBe(100);
    expect(r.remaining).toBe(0);
  });

  it('overpaying one fiado leaves change as remaining', () => {
    const r = planAbono([{ id: 'a', balance: 100 }], 150);

    expect(r.entries).toEqual([{ fiadoId: 'a', apply: 100, settle: true }]);
    expect(r.appliedTotal).toBe(100);
    expect(r.remaining).toBe(50);
  });

  it('distributes oldest-first across multiple fiados', () => {
    const r = planAbono([{ id: 'a', balance: 100 }, { id: 'b', balance: 200 }], 250);

    expect(r.entries).toEqual([
      { fiadoId: 'a', apply: 100, settle: true },
      { fiadoId: 'b', apply: 150, settle: false },
    ]);
    expect(r.appliedTotal).toBe(250);
    expect(r.remaining).toBe(0);
  });

  it('stops once the amount is exhausted (does not touch later fiados)', () => {
    const r = planAbono([{ id: 'a', balance: 100 }, { id: 'b', balance: 200 }], 100);

    expect(r.entries).toEqual([{ fiadoId: 'a', apply: 100, settle: true }]);
    expect(r.remaining).toBe(0);
  });

  it('settles an already-zero-balance fiado and moves on', () => {
    const r = planAbono([{ id: 'a', balance: 0 }, { id: 'b', balance: 50 }], 30);

    expect(r.entries).toEqual([
      { fiadoId: 'a', apply: 0, settle: true },
      { fiadoId: 'b', apply: 30, settle: false },
    ]);
    expect(r.appliedTotal).toBe(30);
  });

  it('no fiados -> nothing applied, all remains', () => {
    const r = planAbono([], 50);

    expect(r.entries).toEqual([]);
    expect(r.appliedTotal).toBe(0);
    expect(r.remaining).toBe(50);
  });

  it('keeps cents exact (no float drift)', () => {
    const r = planAbono([{ id: 'a', balance: 33.33 }, { id: 'b', balance: 66.67 }], 100);

    expect(r.appliedTotal).toBe(100);
    expect(r.remaining).toBe(0);
    expect(r.entries[0]).toEqual({ fiadoId: 'a', apply: 33.33, settle: true });
    expect(r.entries[1]).toEqual({ fiadoId: 'b', apply: 66.67, settle: true });
  });
});

describe('fiadoAmountFor (credited amount of a sale)', () => {
  it('a 100%-fiado sale owes the full total', () => {
    expect(fiadoAmountFor(300, [{ method: 'fiado', amount: '300.00' }])).toBe(300);
  });

  it('a split sale owes only the part not paid upfront', () => {
    expect(
      fiadoAmountFor(300, [
        { method: 'efectivo', amount: '100' },
        { method: 'fiado', amount: '200' },
      ]),
    ).toBe(200);
  });

  it('a fully-paid sale owes nothing', () => {
    expect(fiadoAmountFor(300, [{ method: 'efectivo', amount: '300' }])).toBe(0);
  });

  it('digital upfront payment counts as paid', () => {
    expect(
      fiadoAmountFor(300, [
        { method: 'Nequi', amount: '50' },
        { method: 'fiado', amount: '250' },
      ]),
    ).toBe(250);
  });
});

describe('parseClient', () => {
  it('extracts name and phone from sale notes', () => {
    expect(parseClient('Cliente: Juan Perez | Tel: 3001234567')).toEqual({
      name: 'Juan Perez',
      phone: '3001234567',
    });
  });

  it('accepts "Nombre:" and a missing phone', () => {
    expect(parseClient('Nombre: Ana')).toEqual({ name: 'Ana', phone: '' });
  });

  it('returns blanks for null notes', () => {
    expect(parseClient(null)).toEqual({ name: '', phone: '' });
  });
});

describe('clientKeyOf', () => {
  it('prefers the customer FK', () => {
    expect(clientKeyOf({ customerId: 'cust-1', notes: 'Cliente: X' })).toBe('c:cust-1');
  });

  it('falls back to a stable notes-based key', () => {
    const a = clientKeyOf({ customerId: null, notes: 'Cliente: Juan | Tel: 300' });
    const b = clientKeyOf({ customerId: null, notes: 'Cliente: Juan | Tel: 300' });

    expect(a).toBe(b);
    expect(a.startsWith('n:')).toBe(true);
  });

  it('different clients get different keys', () => {
    const a = clientKeyOf({ customerId: null, notes: 'Cliente: Juan' });
    const b = clientKeyOf({ customerId: null, notes: 'Cliente: Pedro' });

    expect(a).not.toBe(b);
  });
});

describe('normalizeClientKey', () => {
  it('passes through new-format keys', () => {
    expect(normalizeClientKey('c:abc')).toBe('c:abc');
    expect(normalizeClientKey('n:abc')).toBe('n:abc');
  });

  it('prefixes a legacy base64 POS key', () => {
    expect(normalizeClientKey('YWJj')).toBe('n:YWJj');
  });
});

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(10.005)).toBe(10.01);
    expect(round2(10.1 + 0.2)).toBe(10.3);
  });
});
