# Changelog

## 1.6.0
- **Navegación en 2 módulos independientes**, cada uno con su entrada, sus opciones y sus subpestañas:
  - **Procedimiento:** código + opciones del estándar → *Hallazgos · SQL optimizado · Diccionario · Metadatos · Reporte*.
  - **Plan de ejecución:** `.sqlplan` + opciones del plan → *Revisión principal · Hallazgos y mejoras · Sentencias mejoradas · Reporte*.
- Al seleccionar un módulo solo se muestra lo suyo: el reporte del procedimiento ya no incluye el plan y el plan se analiza
  siempre solo (no depende del procedimiento). Cada módulo conserva su estado al cambiar de pestaña.
- Indicador en la pestaña del plan (⚠ N spill en rojo) y opción para aplicar también el estándar de código a las sentencias del plan.

## 1.5.0
- **Revisión principal del plan** (primero en la pestaña y en el reporte), en este orden:
  1. **Spill a tempdb (crítico):** recuadro de alerta destacado, siempre el primer hallazgo y con mayor peso en el puntaje.
  2. **Conversiones implícitas con alerta:** solo las que el plan marca como advertencia (`PlanAffectingConvert`:
     *Seek Plan* = Alta, *Cardinality Estimate* = Media). Las `CONVERT_IMPLICIT` sin alerta ya no se reportan.
  3. **Table Scan (nuevo P15):** tabla física sin índice clustered (heap) con 1,000+ filas; propone índice clustered con la
     columna del filtro del plan.
  4. **Sobreestimación de memoria elevada:** solo concesiones de 50 MB o más con menos del 10 % usado (Alta desde 100 MB).
  5. **Lectura residual elevada (P08):** Seek o Scan que lee 10 veces o más de lo que devuelve (10,000+ filas leídas);
     muestra el % útil y las filas leídas de más.
- Tarjetas con los cinco indicadores (clic para ir al hallazgo) y alertas por sentencia (spill, CONVERT, Table Scan,
  memoria, residual). El resto de hallazgos queda en "Otras observaciones del plan" (plegado).

## 1.4.0
- **Mejoras propuestas en cada hallazgo del plan**, con explicación y script/fragmento SQL listo para copiar:
  conversión implícita (variable local del tipo de la columna, columna de la #temporal con el tipo correcto o literal sin N),
  spill en Sort (quitar ORDER BY del INSERT a temporal), spill en Hash y desvío de estimación (`UPDATE STATISTICS` de las
  tablas del operador; #temporal en vez de variable tabla), sobreestimación de memoria (operadores Sort/Hash con filas ×
  tamaño de fila y columnas que pasan por ellos), Key Lookup (índice con INCLUDE de las columnas leídas), scan con predicado
  (predicado del plan + índice o reescritura SARGable), columnas sin estadísticas (`CREATE STATISTICS`), timeout del
  optimizador (plantilla en dos pasos con la tabla de mayor volumen), índice faltante y nuevo **P14 parameter sniffing**.
- **Hallazgos del plan en una pestaña aparte** (*Plan de ejecución* en el panel derecho) con su propio puntaje, filtros,
  tabla por sentencia, mejoras propuestas y **sentencias mejoradas** (comparación actual vs mejorada).
- **El plan se analiza sin el procedimiento**: las mejoras (conversiones con los tipos de `ParameterList`, Sort y reglas de
  código como NOLOCK, COUNT(1), INNER JOIN…) se aplican sobre el texto de cada sentencia del plan. Si también se pega el
  procedimiento, se aplican sobre él.
- Botones para copiar todos los scripts de mejora y todas las sentencias mejoradas. Reporte propio cuando solo hay plan.

## 1.3.0
- **Pestañas en el panel izquierdo:** *Procedimiento* y *Plan de ejecución*.
- **Carga del plan:** subir/arrastrar `.sqlplan` (UTF-16 o UTF-8, como lo guarda SSMS) o pegar el XML. Resumen por sentencia
  (línea en el PA, costo, memoria concedida/usada, spills, conversiones, tiempo). Clic en una sentencia → ubica la línea.
- **Hallazgos del plan (P00–P13):** spill a tempdb (Sort/Hash/Exchange), conversiones implícitas (`PlanAffectingConvert`),
  sobreestimación de memoria (Excessive Grant / usado < 10 %), memoria insuficiente, índices faltantes (con script),
  Key/RID Lookup, scans que leen mucho más de lo que devuelven, desvío de estimación (operador de origen), JOIN sin
  predicado, columnas sin estadísticas, timeout del optimizador, espera por memoria y aviso de plan estimado.
- **Correcciones automáticas según el plan** (se aplican antes que las de código):
  - Conversión NVARCHAR vs VARCHAR: variable local del tipo de la columna (sin cambiar la firma), quitar `N` del literal,
    cambiar la variable local o la columna de la #temporal a VARCHAR.
  - Sort en `INSERT INTO #temporal … ORDER BY`: se quita el ORDER BY (si no hay IDENTITY, TOP ni OFFSET).
  - Sobreestimación de memoria: `VARCHAR(MAX)` → `VARCHAR(2000)` en temporales (opcional, desactivado por defecto).
  - Conversiones a número/fecha: solo se reportan (no son equivalentes).
- Filtro Código / Plan en Hallazgos; sección "Plan de ejecución" e índices sugeridos en el Reporte.

## 1.2.0
- Un solo `WITH (NOLOCK)` por tabla física; en UPDATE/DELETE con JOIN solo en las tablas unidas, no en la que se modifica.

## 1.1.0
- NOLOCK sin duplicados; `COUNT(*)` → `COUNT(1)`; `EXISTS (SELECT 1 …)`; aviso de EXISTS con agregado sin GROUP BY.

## 1.0.0
- Versión inicial: análisis, correcciones automáticas, comparación antes/después, diccionario, metadatos y reporte.
