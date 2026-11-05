#!/usr/bin/env node
/**
 * Actualización v1.8 · conecta src/app/core/engine/sql-rewrites.ts al motor.
 *   node scripts/actualizar-v1.8.mjs          → aplica (crea copias .bak)
 *   node scripts/actualizar-v1.8.mjs --check  → solo verifica
 * Es idempotente: si un cambio ya está aplicado, lo omite. Si un punto de anclaje no se encuentra,
 * no modifica ningún archivo e indica el cambio manual equivalente (docs/ACTUALIZACION-v1.8.md).
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const P = f => join(root, f);
const ENGINE = 'src/app/core/engine/sql-engine.ts';
const MODELS = 'src/app/core/engine/models.ts';
const OPTIONS = 'src/app/core/engine/options.ts';

const files = {};
for (const f of [ENGINE, MODELS, OPTIONS]) {
  if (!existsSync(P(f))) { console.error(`✘ No existe ${f}. Ejecuta el script desde la raíz del proyecto v1.6/v1.7.`); process.exit(1); }
  files[f] = readFileSync(P(f), 'utf8');
}
if (!existsSync(P('src/app/core/engine/sql-rewrites.ts'))) { console.error('✘ Falta src/app/core/engine/sql-rewrites.ts (copia el paquete completo).'); process.exit(1); }

const results = [];
/** Inserta / reemplaza en un archivo. done(texto) indica si ya está aplicado. */
function edit(file, name, done, apply, manual) {
  const src = files[file];
  if (done(src)) { results.push({ name, status: 'ya aplicado' }); return; }
  const out = apply(src);
  if (out == null || out === src) { results.push({ name, status: 'FALTA', manual }); return; }
  files[file] = out; results.push({ name, status: 'ok', file });
}
const lineIndent = (src, idx) => { const ls = src.lastIndexOf('\n', idx - 1) + 1; return /^[ \t]*/.exec(src.slice(ls))[0]; };
const insertAfterLine = (src, needle, text) => {
  const i = src.indexOf(needle); if (i < 0) return null;
  const end = src.indexOf('\n', i); const ind = lineIndent(src, i);
  return src.slice(0, end + 1) + text.split('\n').map(l => ind + l).join('\n') + '\n' + src.slice(end + 1);
};

// ---- models.ts
edit(MODELS, 'models: opción sargPlus', s => /sargPlus\?/.test(s),
  s => { const m = /^([ \t]*)sarg\?: boolean;[^\n]*\n/m.exec(s); return m ? s.slice(0, m.index + m[0].length) + `${m[1]}/** v1.8: reescribir filtros no SARGables (SUBSTRING → LIKE, fechas → rangos). */\n${m[1]}sargPlus?: boolean;\n` + s.slice(m.index + m[0].length) : null; },
  'En OptimizeOptions agregar:  sargPlus?: boolean;');

// ---- options.ts
edit(OPTIONS, 'options: casilla "Reescribir filtros no SARGables"', s => /'sargPlus'/.test(s),
  s => insertAfterLine(s, "key: 'sarg'",
    "{ key: 'sargPlus', label: 'Reescribir filtros no SARGables (SUBSTRING → LIKE, fechas → rangos DATEADD/DATEDIFF)', hint: 'Solo reescrituras equivalentes: SUBSTRING/LEFT con literal, CONVERT/CAST a DATE, YEAR/MONTH, DATEDIFF y DATEADD sobre columnas de fecha (prefijo d)', default: true },"),
  "Después de la opción { key: 'sarg', … } agregar la opción { key: 'sargPlus', … default: true }.");

// ---- sql-engine.ts
edit(ENGINE, 'engine: import de sql-rewrites', s => s.includes("from './sql-rewrites'"),
  s => { const m = /^import [^\n]* from '\.\/models';\n/m.exec(s); return m ? s.slice(0, m.index + m[0].length) + "import { sargRewrite, dmlTargetIsTemp, tranOnlyTemp } from './sql-rewrites';\n" + s.slice(m.index + m[0].length) : null; },
  "Agregar: import { sargRewrite, dmlTargetIsTemp, tranOnlyTemp } from './sql-rewrites';");

edit(ENGINE, 'R31: no contar DML sobre temporales', s => s.includes('dmlTargetIsTemp(masked, m.index)'),
  s => { const n = ".filter(m => !/^UPDATE\\s+STATISTICS/i.test(m[0]))"; return s.includes(n) ? s.replace(n, n + '.filter(m => !dmlTargetIsTemp(masked, m.index))') : null; },
  'En la regla R31 (const dml = …) agregar  .filter(m => !dmlTargetIsTemp(masked, m.index))  después del filtro UPDATE STATISTICS.');

edit(ENGINE, 'R30: no exigir TRY/CATCH si la transacción solo toca temporales', s => s.includes('!hasTry && !tranOnlyTemp(src)'),
  s => { const n = 'else if (begins.length && !hasTry)'; return s.includes(n) ? s.replace(n, 'else if (begins.length && !hasTry && !tranOnlyTemp(src))') : null; },
  "En la regla R30 cambiar  else if (begins.length && !hasTry)  por  else if (begins.length && !hasTry && !tranOnlyTemp(src)).");

edit(ENGINE, 'closeTran: no envolver transacciones que solo tocan temporales', s => s.includes('commits >= begins.length && tranOnlyTemp(src)'),
  s => { const n = 'if (commits >= begins.length && hasTry && hasRb) return { src, count: 0 };'; return s.includes(n) ? insertAfterLine(s, n, 'if (commits >= begins.length && tranOnlyTemp(src)) return { src, count: 0 }; // v1.8: solo temporales') : null; },
  'En fixes.closeTran, después de "if (commits >= begins.length && hasTry && hasRb) return …" agregar:\n    if (commits >= begins.length && tranOnlyTemp(src)) return { src, count: 0 };');

edit(ENGINE, 'R10: marcar corrección automática cuando hay reescritura', s => s.includes('sargRewrite(src).count > 0'),
  s => { const n = "nonSarg.map(x => x.i), 'Manual BP – Índices / Conformidad DBA')"; return s.includes(n) ? s.replace(n, "nonSarg.map(x => x.i), 'Manual BP – Índices / Conformidad DBA', sargRewrite(src).count > 0)") : null; },
  "En la regla R10 agregar el último argumento  sargRewrite(src).count > 0  (autofix).");

edit(ENGINE, 'optimize: ejecutar sargRewrite', s => s.includes("run('sargRewrite')"),
  s => insertAfterLine(s, "if (opts.sarg) run('sargLeft');", "if (opts.sargPlus) run('sargRewrite');"),
  "En optimize(), después de  if (opts.sarg) run('sargLeft');  agregar  if (opts.sargPlus) run('sargRewrite');");

edit(ENGINE, 'engine: registrar la corrección sargRewrite', s => s.includes("fixes['sargRewrite']"),
  s => /\bconst fixes\b/.test(s) && /\bconst FIXMETA\b/.test(s) ? s.replace(/\s*$/, '\n') + `
// ---- v1.8: reescrituras SARGables (sql-rewrites.ts)
fixes['sargRewrite'] = (src: string) => { const r = sargRewrite(src); return { src: r.src, count: r.count }; };
FIXMETA['sargRewrite'] = [
  'Filtros no SARGables reescritos (SUBSTRING → LIKE, fechas → rangos con DATEADD/DATEDIFF)',
  'Predicado SARGable (Index Seek)',
  'Solo reescrituras equivalentes: la función pasa de la columna al valor y el rango cubre exactamente los mismos registros.'
];
` : null,
  "Al final de sql-engine.ts registrar fixes['sargRewrite'] y FIXMETA['sargRewrite'] (ver docs).");

// ---- resultado
const missing = results.filter(r => r.status === 'FALTA');
for (const r of results) console.log(`${r.status === 'ok' ? '✔' : r.status === 'ya aplicado' ? '•' : '✘'} ${r.name}${r.status === 'ya aplicado' ? ' (ya aplicado)' : ''}`);
if (missing.length) {
  console.error('\n✘ No se encontraron estos puntos de anclaje. No se modificó ningún archivo. Cambios manuales:');
  for (const m of missing) console.error(`  - ${m.name}: ${m.manual}`);
  process.exit(1);
}
if (check) { console.log('\nVerificación correcta (modo --check, sin cambios).'); process.exit(0); }

const touched = new Set(results.filter(r => r.status === 'ok').map(r => r.file));
for (const f of touched) { copyFileSync(P(f), P(f) + '.bak'); writeFileSync(P(f), files[f]); }

// versión y changelog
const pkgPath = P('package.json');
if (existsSync(pkgPath)) {
  const pkg = readFileSync(pkgPath, 'utf8');
  if (!/"version":\s*"1\.8\.0"/.test(pkg)) writeFileSync(pkgPath, pkg.replace(/"version":\s*"[^"]+"/, '"version": "1.8.0"'));
}
const chPath = P('CHANGELOG.md');
if (existsSync(chPath)) {
  const ch = readFileSync(chPath, 'utf8');
  if (!ch.includes('## 1.8.0')) writeFileSync(chPath, ch.replace('# Changelog\n', `# Changelog

## 1.8.0
- **SQL optimizado aplica los hallazgos de funciones sobre columnas (R10)** con reescrituras equivalentes:
  SUBSTRING/LEFT con literal → LIKE 'prefijo%' o rango; CONVERT/CAST a DATE, CONVERT(VARCHAR, fecha, 112/120),
  YEAR, YEAR + MONTH, DATEDIFF y DATEADD sobre columnas de fecha → rangos con DATEADD/DATEDIFF.
- **Transacciones y temporales:** los UPDATE/DELETE/INSERT sobre #temporales o @variables tabla ya no cuentan para
  R31 (DML sin transacción) ni R30 (sin TRY/CATCH), y no se envuelve en TRY/CATCH una transacción que solo toca temporales.
`));
}
console.log(`\n✔ Actualización v1.8 aplicada (${touched.size} archivo(s); copias .bak creadas). Ejecuta: npm test`);
