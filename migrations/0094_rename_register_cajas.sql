-- Renumbra las cajas 'register' a "Caja N" por organización, ordenadas por
-- fecha de creación (incluyendo archivadas, para que los números sean estables
-- y nunca se reutilicen). Antes se nombraban con el nombre del dispositivo
-- (migración 0089 + ensureCajaForDevice viejo); ahora la supervisión muestra
-- "Caja N" como título y los dispositivos como lista aparte. Las cajas 'courier'
-- conservan su nombre (el del domiciliario).
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY created_at, id) AS n
  FROM cajas WHERE type = 'register'
)
UPDATE cajas SET name = 'Caja ' || numbered.n FROM numbered WHERE cajas.id = numbered.id;
