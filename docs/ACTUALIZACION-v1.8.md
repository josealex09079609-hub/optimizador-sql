# Actualización v1.8

## Qué cambia
1. **SQL optimizado aplica los hallazgos de "funciones sobre columnas" (R10)** cuando existe una reescritura
   **equivalente** (mismos registros). La función pasa de la columna al valor y el motor puede usar Index Seek.
   Opción nueva en Procedimiento: *Reescribir filtros no SARGables* (activada por defecto). También se aplica a las
   sentencias del plan si está marcado "Aplicar también el estándar de código".
2. **Transacciones y temporales:** los `INSERT/UPDATE/DELETE/MERGE` sobre `#temporales` o `@variables tabla`
   (incluido por alias: `UPDATE t … FROM #T t`) ya no cuentan para **R31** (DML sin transacción) ni **R30**
   (transacción sin TRY/CATCH), y la corrección "Cerrar transacciones" no envuelve una transacción que solo toca
   temporales. Una transacción **abierta** (BEGIN TRAN sin COMMIT) se sigue reportando (R46) porque deja bloqueos.

## Reescrituras (solo en WHERE / ON / HAVING, con la función a la izquierda)
| Antes | Después | Condición |
|---|---|---|
| `SUBSTRING(c.cCtaCod, 1, 3) = '109'` · `LEFT(c, 3) = '109'` | `c.cCtaCod LIKE '109%'` | literal de exactamente n caracteres, sin `%`, `_`, `[` ni espacio final |
| `SUBSTRING(m.cMovNro, 1, 8) BETWEEN '20261001' AND '20261031'` | `(m.cMovNro >= '20261001' AND m.cMovNro < '20261032')` | literales numéricos de n dígitos (también `>=`, `>`, `<=`, `<`) |
| `CONVERT(DATE, t.dFecha) = '20261031'` / `CAST(t.dFecha AS DATE) = @dCorte` | `(t.dFecha >= X AND t.dFecha < DATEADD(DAY, 1, X))` | X sin hora: literal, `CONVERT(DATE, …)`, `CAST(… AS DATE)` o variable **DATE** (no DATETIME) |
| `CONVERT(VARCHAR(8), t.dFecha, 112) = '20261231'` | `(t.dFecha >= '20261231' AND t.dFecha < '20270101')` | estilo 112 (8) o 23/120/121/126 (10) con literal |
| `YEAR(t.dFecha) = 2026` | `(t.dFecha >= '20260101' AND t.dFecha < '20270101')` | también `@nAnio` → `DATEADD(YEAR, @nAnio - 1900, 0)` y `YEAR(GETDATE())` → `DATEADD(YEAR, DATEDIFF(YEAR, 0, GETDATE()), 0)` |
| `YEAR(t.dFecha) = 2026 AND MONTH(t.dFecha) = 10` | `(t.dFecha >= '20261001' AND t.dFecha < '20261101')` | literales, variables o `YEAR(x)`/`MONTH(x)` de la misma expresión |
| `DATEDIFF(DAY, t.dFecha, GETDATE()) <= 30` | `t.dFecha >= DATEADD(DAY, DATEDIFF(DAY, 0, GETDATE()) - 30, 0)` | DAY/MONTH/YEAR con número entero; `=`, `<`, `<=`, `>`, `>=`; columna en cualquier lado |
| `DATEADD(DAY, 30, t.dVencimiento) < GETDATE()` | `t.dVencimiento < DATEADD(DAY, -30, GETDATE())` | DAY/HOUR/MINUTE/SECOND/WEEK (MONTH/YEAR no son reversibles) |

Las reescrituras de fechas solo se aplican a columnas con la nomenclatura de fecha del área (**prefijo `d`**: `dFecha`, `dVigencia`…).
No se tocan: `SELECT`/`CASE`/`IF`, `<>`, variables DATETIME contra `CONVERT(DATE, …)`, subconsultas ni funciones no deterministas.

## Instalación
```bash
# 1. Descomprimir el paquete sobre el proyecto (v1.6 o v1.7)
# 2. Verificar y aplicar
node scripts/actualizar-v1.8.mjs --check
node scripts/actualizar-v1.8.mjs          # deja copias .bak, sube la versión a 1.8.0 y actualiza CHANGELOG.md
npm test
```
El script es idempotente y, si no encuentra algún punto de anclaje, no modifica nada y muestra el cambio manual.

## Cambios manuales equivalentes (si el script lo pide)
- `models.ts` → en `OptimizeOptions`: `sargPlus?: boolean;`
- `options.ts` → después de `{ key: 'sarg', … }`: `{ key: 'sargPlus', label: '…', hint: '…', default: true },`
- `sql-engine.ts`:
  - `import { sargRewrite, dmlTargetIsTemp, tranOnlyTemp } from './sql-rewrites';`
  - R31: `.filter(m => !/^UPDATE\s+STATISTICS/i.test(m[0])).filter(m => !dmlTargetIsTemp(masked, m.index))`
  - R30: `else if (begins.length && !hasTry && !tranOnlyTemp(src))`
  - `fixes.closeTran`: `if (commits >= begins.length && tranOnlyTemp(src)) return { src, count: 0 };`
  - R10: último argumento de `add(...)`: `sargRewrite(src).count > 0`
  - `optimize()`: `if (opts.sargPlus) run('sargRewrite');` después de `run('sargLeft')`
  - al final: `fixes['sargRewrite'] = …` y `FIXMETA['sargRewrite'] = […]` (ver el script)

## Archivos
Nuevos: `src/app/core/engine/sql-rewrites.ts`, `sql-rewrites.spec.ts` (17 pruebas), `sql-rewrites.integration.spec.ts`,
`scripts/actualizar-v1.8.mjs`, `docs/ACTUALIZACION-v1.8.md`.
