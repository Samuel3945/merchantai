ALTER TABLE "products" ADD COLUMN "size" jsonb;--> statement-breakpoint
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
      '(\d+(?:\.\d+)?)\s*(litros?|lts?|lt|mililitros?|ml|kilogramos?|kilos?|kgs?|kg|gramos?|grs?|gr|l|g)\y'
    ) AS mm
    FROM "products"
    WHERE "size" IS NULL
  ) matched
  WHERE mm IS NOT NULL
) v
WHERE p.id = v.id;
