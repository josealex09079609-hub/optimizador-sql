# Optimizador de Procedimientos Almacenados (SQL Server 2019)

Aplicación web en **Angular 18** que analiza y optimiza procedimientos almacenados con el estándar de BD de la Caja
(skill `pa-sqlserver-cajaica`: Manual de Buenas Prácticas UPBD + code review senior + observaciones DBA).

> **Regla de oro:** optimizar sin cambiar la lógica. Lo que no se puede demostrar equivalente no se aplica y se
> reporta como *observación no aplicada*.

El análisis se ejecuta **100 % en el navegador**: el código SQL no se envía a ningún servidor.

## Funcionalidades

| Pestaña | Contenido |
|---|---|
| **Hallazgos** | Observaciones por prioridad (Alta/Media/Baja/Info), línea, recomendación y referencia a la regla. Puntaje 0–100. |
| **SQL optimizado** | Comparación **Antes / Después** (lado a lado o unificada) con resaltado por palabra, plegado de líneas sin cambios y vista "solo resultado". |
| **Diccionario** | Script idempotente `sp_addextendedproperty` del PA y sus parámetros. |
| **Metadatos** | Scripts §0.1 (dependencias y columnas) para obtener tipos exactos. |
| **Reporte** | Formato de entrega §8: tabla de cambios, observaciones no aplicadas, contexto faltante, validación. |

Correcciones automáticas (configurables): `WITH (NOLOCK)` según la política del área, `COLLATE` en temporales,
`DROP TABLE IF EXISTS`, `IN (x)` → `= x`, `;` antes de `THROW`, cierre de transacciones abiertas con TRY/CATCH,
`SELECT … INTO #` → `CREATE TABLE` + `INSERT INTO`, `JOIN` → `INNER JOIN`, `TRIM`, predicados SARGables,
eliminación de código comentado (conservando la cabecera), entre otras. Modo claro/oscuro.

## Requisitos

- Node.js 20 LTS (o 18.19+)
- npm 10+

## Desarrollo

```bash
npm install
npm start            # http://localhost:4200
npm test             # pruebas unitarias del motor
npm run build:prod   # salida en dist/sql-optimizer/browser
```

## Estructura

```
src/app/
├── core/
│   ├── engine/            # Lógica pura (sin Angular): reglas, correcciones, diff, resaltado, reporte
│   │   ├── sql-engine.ts  # analyze(), optimize(), dictionary(), metadataScripts()
│   │   ├── diff.ts        # comparación línea a línea + por palabra
│   │   ├── options.ts     # correcciones automáticas y valores por defecto
│   │   └── report.ts      # reporte para el DBA (§8)
│   └── services/          # Estado (signals), tema, portapapeles/descargas
├── features/
│   ├── editor/            # Entrada SQL, opciones, abrir/arrastrar .sql
│   ├── findings/          # Hallazgos y filtros
│   ├── diff-viewer/       # Comparación antes/después
│   └── code-panel/        # Visor reutilizable (diccionario, metadatos, reporte)
└── shared/sample.ts       # Procedimiento de ejemplo
```

**Agregar una regla:** en `sql-engine.ts` dentro de `analyze()` usar `add('Rxx', SEV.X, categoría, título, detalle, recomendación, índices, referencia, autofix)`.
Si tiene corrección automática, agregarla en `fixes`, su metadato en `FIXMETA` y la opción en `options.ts`.
Toda regla nueva debe respetar la regla de oro y venir de la skill (o ser confirmada).

## Publicación

- **IIS:** `npm run build:prod` y copiar `dist/sql-optimizer/browser/*` + `web.config` al sitio (módulo URL Rewrite).
  Si se publica en una subcarpeta: `ng build --base-href /optimizador-sql/`.
- **Docker / Nginx:** `docker build -t sql-optimizer .` y `docker run -p 8080:80 sql-optimizer`.

## Subir a Bitbucket

```bash
git init
git add .
git commit -m "feat: optimizador de procedimientos almacenados (Angular 18)"
git branch -M main
git remote add origin https://bitbucket.org/<workspace>/sql-optimizer.git
git push -u origin main
```
