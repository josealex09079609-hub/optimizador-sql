# Optimizador de Procedimientos Almacenados (SQL Server 2019)

Aplicación web en **Angular 18** que analiza y optimiza procedimientos almacenados con el estándar de BD de la Caja
(skill `pa-sqlserver-cajaica`: Manual de Buenas Prácticas UPBD + code review senior + observaciones DBA) y que,
además, analiza el **plan de ejecución** (`.sqlplan`) para detectar spills, conversiones implícitas y sobreestimación de memoria.

> **Regla de oro:** optimizar sin cambiar la lógica. Lo que no se puede demostrar equivalente no se aplica y se
> reporta como *observación no aplicada*.

El análisis se ejecuta **100 % en el navegador**: el código SQL y el plan no se envían a ningún servidor.

## Funcionalidades

La aplicación tiene **dos módulos independientes**; al seleccionar uno solo se muestra lo suyo.

| Módulo | Panel izquierdo | Subpestañas |
|---|---|---|
| **📄 Procedimiento** | Código del PA (pegar, abrir o arrastrar `.sql`) y correcciones del estándar | **Hallazgos** · **SQL optimizado** (antes/después) · **Diccionario** · **Metadatos** · **Reporte** |
| **📊 Plan de ejecución** | `.sqlplan` (subir, arrastrar o pegar XML) y correcciones del plan. No requiere el procedimiento | **Revisión principal** (spill, 5 indicadores, tabla por sentencia) · **Hallazgos y mejoras** · **Sentencias mejoradas** · **Reporte** |

### Qué revisa del plan

**Revisión principal** (en este orden; el spill es lo más importante):

| Orden | Id | Hallazgo | Criterio | Corrección / propuesta |
|---|---|---|---|---|
| 1 | P01 | **Spill a tempdb** (Sort, Hash, Exchange) | Alerta `SpillToTempDb` del plan real | Quita `ORDER BY` en `INSERT INTO #temporal`; `UPDATE STATISTICS` |
| 2 | P02/P03 | Conversión implícita **con alerta** | Solo `PlanAffectingConvert` (Seek Plan / Cardinality Estimate) | NVARCHAR vs VARCHAR: variable local, quitar `N''`, columna de #temporal a VARCHAR |
| 3 | P15 | **Table Scan** | Tabla física sin índice clustered, 1,000+ filas | Índice clustered con la columna del filtro (validar con DBA) |
| 4 | P04 | Sobreestimación de memoria **elevada** | Concedido ≥ 50 MB y usado < 10 % | Columnas necesarias, sin VARCHAR(MAX), filtrar antes de Sort/Hash |
| 5 | P08 | Lectura residual **elevada** | Seek/Scan lee ≥ 10x lo que devuelve (≥ 10,000 filas) | Filtro SARGable o índice con las columnas del predicado |

**Otras observaciones** (sección plegada): índice faltante (P06), Key/RID Lookup (P07), desvío de estimación (P09),
JOIN sin predicado (P10), timeout del optimizador (P11), columnas sin estadísticas (P12), espera por memoria (P13),
parameter sniffing (P14), memoria insuficiente (P05) y aviso de plan estimado (P00).

Cada hallazgo del plan incluye una **mejora propuesta** (explicación + script: variable local, UPDATE/CREATE STATISTICS, índice con INCLUDE, plantilla en dos pasos, etc.).
Sin procedimiento, las mejoras se aplican sobre el texto de cada sentencia del plan.

Para spills y memoria se necesita el **plan real**: en SSMS activar *Incluir plan de ejecución real* (Ctrl+M),
ejecutar el PA y usar *Guardar plan de ejecución como…*. En `samples/` hay un PA y un plan de ejemplo.

## Requisitos

- Node.js 20 LTS (o 18.19+) · npm 10+

## Desarrollo

```bash
npm install
npm start            # http://localhost:4200
npm test             # pruebas unitarias del motor (código y plan)
npm run build:prod   # salida en dist/sql-optimizer/browser
```

## Estructura

```
src/app/
├── core/
│   ├── engine/            # Lógica pura (sin Angular)
│   │   ├── sql-engine.ts  # reglas, correcciones y análisis del plan: analyze(), optimize(), analyzePlan(), combine()
│   │   ├── sql-engine.spec.ts
│   │   ├── diff.ts        # comparación línea a línea + por palabra
│   │   ├── options.ts     # correcciones automáticas y valores por defecto
│   │   └── report.ts      # reporte para el DBA (§8)
│   └── services/          # Estado (signals), tema, portapapeles/descargas
├── features/
│   ├── proc/              # Módulo Procedimiento: proc-page, proc-editor, findings, diff-viewer
│   ├── plan/              # Módulo Plan: plan-page, plan-panel, plan-main, plan-findings, plan-improved
│   └── code-panel/        # Visor reutilizable (diccionario, metadatos, reportes)
└── shared/sample.ts       # PA y plan de ejemplo
```

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
