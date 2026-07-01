-- Search infrastructure for the WhatsApp agent product lookup (/api/agent/products).
-- Adds accent-insensitive fuzzy (trigram) + full-text (spanish) search over products.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- Accent folding as a pure, IMMUTABLE translate() — deliberately NOT the unaccent
-- extension: unaccent() is only STABLE (rejected inside index expressions) and is
-- not guaranteed to be installed. translate()+lower() are core, so this also runs
-- under PGlite in tests. lower() is folded in here so callers pass raw text.
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
$$;--> statement-breakpoint

-- Trigram GIN index for typo-tolerant / fuzzy matching on the normalized name.
CREATE INDEX IF NOT EXISTS products_name_trgm_idx
  ON products
  USING gin (immutable_unaccent(name) gin_trgm_ops);--> statement-breakpoint

-- Full-text (spanish) GIN index over name + category for multi-word recall.
CREATE INDEX IF NOT EXISTS products_search_fts_idx
  ON products
  USING gin (to_tsvector('spanish', immutable_unaccent(name || ' ' || coalesce(category, ''))));
