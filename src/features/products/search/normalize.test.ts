import { describe, expect, it } from 'vitest';
import { normalizeQuery, normalizeText, tokenize } from './normalize';

describe('normalizeQuery', () => {
  it('collapses unit spellings and spacing', () => {
    expect(normalizeQuery('Coca Cola 2 Litros')).toBe('coca cola 2l');
  });

  it('strips accents', () => {
    expect(normalizeQuery('Café')).toBe('cafe');
  });

  it('normalizes gramos to a compact g unit', () => {
    expect(normalizeQuery('500 gramos')).toBe('500g');
  });

  it('normalizes kilos/kg/k spellings to a compact kg unit', () => {
    expect(normalizeQuery('2 kilos')).toBe('2kg');
    expect(normalizeQuery('2kg')).toBe('2kg');
    expect(normalizeQuery('2 k')).toBe('2kg');
  });

  it('normalizes mililitros/ml spellings', () => {
    expect(normalizeQuery('750 mililitros')).toBe('750ml');
    expect(normalizeQuery('750ml')).toBe('750ml');
  });
});

describe('normalizeText', () => {
  it('lowercases and strips characters outside [a-z0-9\\s.]', () => {
    expect(normalizeText('Arroz Diana® 500g!!')).toBe('arroz diana 500g');
  });
});

describe('tokenize', () => {
  it('splits on whitespace and trims stray dots per token', () => {
    expect(tokenize('coca cola 2.5l')).toEqual(['coca', 'cola', '2.5l']);
  });

  it('filters empty tokens', () => {
    expect(tokenize('  pan   tajado  ')).toEqual(['pan', 'tajado']);
  });
});
