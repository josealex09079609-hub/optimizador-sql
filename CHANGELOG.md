# Changelog

## 1.2.0
- **Un solo WITH (NOLOCK) por tabla física:** se unifican hints repetidos (`WITH (NOLOCK) WITH (NOLOCK)`,
  `(NOLOCK) WITH (NOLOCK)`, `WITH (NOLOCK, NOLOCK)`, `NOLOCK + READUNCOMMITTED`) y la forma antigua `(NOLOCK)` pasa a
  `WITH (NOLOCK)`. Regla R65. Las temporales y variables tabla nunca lo llevan (también se quita `(NOLOCK)` antiguo).
- **UPDATE / DELETE con JOIN:** la tabla que se modifica o elimina no lleva NOLOCK (se quita si lo tiene; SQL Server lo
  ignora ahí). Las tablas unidas y las de subconsultas sí lo llevan. Incluye `UPDATE dbo.T WITH (NOLOCK) SET …`. Regla R50.
- INSERT/MERGE hacia tabla física: sin cambios (no se agrega NOLOCK al origen; si lo tiene se reporta como R66).

## 1.1.0
- **NOLOCK sin duplicados:** se reconoce `WITH (NOLOCK)`, `WITH(NOLOCK)`, `(NOLOCK)` sin WITH, `READUNCOMMITTED`,
  alias con o sin `AS`, hint en la línea siguiente y nombres con corchetes. Si ya lo tiene, no se reporta (R09) ni se agrega.
  Si la tabla tiene otro hint sin bloqueo (p. ej. `WITH (INDEX(IX))`), se agrega dentro del mismo `WITH (…)`.
  Si tiene un hint de bloqueo (`UPDLOCK`, `HOLDLOCK`, …) no se toca.
- **R62 / corrección `countOne`:** `COUNT(*)` → `COUNT(1)` (no toca literales ni comentarios).
- **R63 / corrección `existsOne`:** `EXISTS (SELECT … )` → `EXISTS (SELECT 1 …)` en `IF EXISTS`, `IF NOT EXISTS` y `WHERE EXISTS`.
  No se aplica con `UNION/EXCEPT/INTERSECT`, `TOP 0` / `TOP (@var)` ni sin `FROM`.
- **R64:** `EXISTS (SELECT COUNT/SUM/MAX… )` sin `GROUP BY` siempre es verdadero: se reporta y no se cambia.

## 1.0.0
- Versión inicial: análisis, correcciones automáticas, comparación antes/después, diccionario, metadatos y reporte.
