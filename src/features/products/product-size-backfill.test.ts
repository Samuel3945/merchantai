import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

// Verifies the one-time backfill UPDATE in migrations/0078_product_size_column.sql
// against real Postgres regex/jsonb behavior (PGlite), not a mock: the grammar
// (unit words + abbreviations, longest-first so `l`/`g` don't prematurely match)
// must stay faithful to size.ts#sizeFromName's own SIZE_RE for the two to agree
// on every existing product name.

// Mirrors migrations/0077_product_search_trgm_fts.sql exactly (pure
// translate()+lower(), not the unaccent extension — IMMUTABLE, no extra deps).
const UNACCENT_FN = `
  CREATE OR REPLACE FUNCTION immutable_unaccent(text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    STRICT
  AS $$
    SELECT translate(
      lower($1),
      'áàäâãéèëêíìïîóòöôõúùüûñçºª',
      'aaaaaeeeeiiiiooooouuuuncoa'
    )
  $$;
`;

// Byte-identical to the UPDATE statement in migrations/0078_product_size_column.sql
// (everything after the ALTER TABLE / statement-breakpoint).
const BACKFILL_SQL = `
UPDATE "products" p
SET "size" = jsonb_build_object(
  'value', v.value,
  'unit', v.unit,
  'base', CASE WHEN v.unit IN ('l', 'kg') THEN v.value * 1000 ELSE v.value END,
  'family', CASE WHEN v.unit IN ('l', 'ml') THEN 'volume' ELSE 'weight' END
)
FROM (
  SELECT id,
    (mm[1])::numeric AS value,
    CASE
      WHEN mm[2] IN ('litro', 'litros', 'lt', 'lts', 'l') THEN 'l'
      WHEN mm[2] IN ('mililitro', 'mililitros', 'ml') THEN 'ml'
      WHEN mm[2] IN ('kilogramo', 'kilogramos', 'kilo', 'kilos', 'kgs', 'kg') THEN 'kg'
      WHEN mm[2] IN ('gramo', 'gramos', 'grs', 'gr', 'g') THEN 'g'
    END AS unit
  FROM (
    SELECT id, regexp_match(
      immutable_unaccent("name"),
      '(\\d+(?:\\.\\d+)?)\\s*(litros?|lts?|lt|mililitros?|ml|kilogramos?|kilos?|kgs?|kg|gramos?|grs?|gr|l|g)\\y'
    ) AS mm
    FROM "products"
    WHERE "size" IS NULL
  ) matched
  WHERE mm IS NOT NULL
) v
WHERE p.id = v.id;
`;

let pg: PGlite;

type Row = { name: string; size: unknown };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(UNACCENT_FN);
  await pg.exec(`
    CREATE TABLE products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      name text NOT NULL,
      size jsonb
    );
  `);
  await pg.query(`
    INSERT INTO products (name) VALUES
      ('Coca Cola 2L'),
      ('Coca Cola 1.5L'),
      ('Arroz 500g'),
      ('Azucar 1 kg'),
      ('Leche 2 litros'),
      ('Pan tajado');
  `);

  await pg.exec(BACKFILL_SQL);
});

async function sizeOf(name: string) {
  const { rows } = await pg.query<Row>('SELECT name, size FROM products WHERE name = $1', [name]);
  return rows[0]?.size;
}

describe('migrations/0078_product_size_column.sql backfill', () => {
  it('Coca Cola 2L -> {value:2, unit:l, base:2000, family:volume}', async () => {
    expect(await sizeOf('Coca Cola 2L')).toEqual({ value: 2, unit: 'l', base: 2000, family: 'volume' });
  });

  it('Coca Cola 1.5L -> {value:1.5, unit:l, base:1500, family:volume}', async () => {
    expect(await sizeOf('Coca Cola 1.5L')).toEqual({ value: 1.5, unit: 'l', base: 1500, family: 'volume' });
  });

  it('Arroz 500g -> {value:500, unit:g, base:500, family:weight}', async () => {
    expect(await sizeOf('Arroz 500g')).toEqual({ value: 500, unit: 'g', base: 500, family: 'weight' });
  });

  it('Azucar 1 kg -> {value:1, unit:kg, base:1000, family:weight}', async () => {
    expect(await sizeOf('Azucar 1 kg')).toEqual({ value: 1, unit: 'kg', base: 1000, family: 'weight' });
  });

  it('Leche 2 litros -> {value:2, unit:l, base:2000, family:volume}', async () => {
    expect(await sizeOf('Leche 2 litros')).toEqual({ value: 2, unit: 'l', base: 2000, family: 'volume' });
  });

  it('Pan tajado -> stays NULL (no size token)', async () => {
    expect(await sizeOf('Pan tajado')).toBeNull();
  });
});
