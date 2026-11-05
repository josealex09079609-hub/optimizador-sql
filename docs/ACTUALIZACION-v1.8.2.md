# Actualización v1.8.2

Reemplaza a la v1.8 y v1.8.1 (si ya las aplicaste, no hace falta deshacerla: la v1.8.1 es compatible y no duplica cambios).

## Por qué no salía en "SQL optimizado"
La v1.8 dependía de modificar `sql-engine.ts` con un script; si un punto no coincidía o el cambio no se subía al
repositorio que compila Netlify, la app seguía igual. La v1.8.1 **no toca `sql-engine.ts`**: agrega un adaptador
(`sql-engine-v18.ts`) y solo cambia las rutas de `import` en `optimizer.store.ts` (y `pwa.service.ts` si existe).

## Instalación
```bash
# 1. Descomprimir el paquete sobre el proyecto (aceptar reemplazar sql-rewrites.ts)
node scripts/actualizar-v1.8.2.mjs --check
node scripts/actualizar-v1.8.2.mjs
npm test
npm start            # debe verse la casilla "Reescribir filtros no SARGables…"
# 2. Publicar: subir al repositorio que usa Netlify (git add/commit/push) o volver a desplegar dist/
```
Cambio manual equivalente (`src/app/core/services/optimizer.store.ts`):
```ts
import * as Engine from '../engine/sql-engine-v18';
import { OPTIMIZE_OPTIONS } from '../engine/options-v18';
```

## SUBSTRING / LEFT (comparado con texto)
| Antes | Después | Nota |
|---|---|---|
| `SUBSTRING(c.cCtaCod, 1, 3) = '109'` · `LEFT(c.cCtaCod, 3) = '109'` | `c.cCtaCod LIKE '109%'` | permite Index Seek |
| `SUBSTRING(cs.cCtaCod, 6, 3) = '305'` | `cs.cCtaCod LIKE '_____305%'` | sin función sobre la columna (no habilita Seek: empieza con `_`) |
| `SUBSTRING(cs.cCtaCod, 6, 3) IN ('305', '302')` | `(cs.cCtaCod LIKE '_____305%' OR cs.cCtaCod LIKE '_____302%')` | todos los valores deben ser texto de n caracteres |
| `SUBSTRING(cs.cCtaCod, 6, 3) = 305` (número de 3 dígitos, sin cero inicial) | `cs.cCtaCod LIKE '_____305%'` | evita además la conversión implícita a INT |
| `'305' = SUBSTRING(cs.cCtaCod, 6, 3)` | `cs.cCtaCod LIKE '_____305%'` | literal a la izquierda |
| `SUBSTRING(m.cMovNro, 1, 8) BETWEEN '20261001' AND '20261031'` | `(m.cMovNro >= '20261001' AND m.cMovNro < '20261032')` | también `>=`, `>`, `<=`, `<` |

**No se reescriben** (quedan en Hallazgos para revisión manual): comparación con **variable** (`= @cProducto`) u **otra
columna** (`= b.cMovNro`), texto de distinto largo que n, con `%` `_` `[` o espacio final, `<>`, `NOT IN`, y funciones
fuera de filtros (`SELECT`, `CASE`, `SET`). R10 indica en su detalle cuántos filtros se reescribieron y, para cada pendiente, la línea y el motivo (variable, otra columna, negación…).

## Fechas (columnas con prefijo d)
`CONVERT(DATE, …)`/`CAST(… AS DATE)` contra literal o variable DATE, `CONVERT(VARCHAR(8), dCol, 112)`, `YEAR`,
`YEAR + MONTH`, `DATEDIFF(DAY|MONTH|YEAR, …)`, `DATEADD(DAY|HOUR|MINUTE|SECOND|WEEK, …)` → rangos con DATEADD/DATEDIFF.
También con el valor a la izquierda (`@dCorte = CONVERT(DATE, t.dFecha)`).

## Transacciones con temporales
`INSERT/UPDATE/DELETE` sobre `#temporales` o `@variables tabla` (también por alias: `UPDATE t … FROM #T t`) no cuentan
para R31 ni R30, y "Cerrar transacciones" no envuelve una transacción (con COMMIT) que solo toca temporales.

## Archivos
`src/app/core/engine/sql-rewrites.ts` (actualizado), `sql-engine-v18.ts`, `options-v18.ts`, `sql-rewrites.spec.ts`,
`sql-engine-v18.spec.ts` (20 pruebas), `scripts/actualizar-v1.8.2.mjs`. Si existe `sql-rewrites.integration.spec.ts`
de la v1.8, puede quedarse (sigue siendo válido si aplicaste esa versión) o eliminarse.
