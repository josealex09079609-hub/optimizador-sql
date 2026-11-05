#!/usr/bin/env node
/**
 * Actualización v1.8.2 · activa el adaptador del motor (sql-engine-v18.ts + options-v18.ts).
 * NO modifica sql-engine.ts, options.ts ni models.ts: solo cambia las rutas de import en los servicios/componentes:
 *     '…/engine/sql-engine'  →  '…/engine/sql-engine-v18'
 *     '…/engine/options'     →  '…/engine/options-v18'
 *   node scripts/actualizar-v1.8.2.mjs --check   → muestra qué cambiaría
 *   node scripts/actualizar-v1.8.2.mjs           → aplica (copias .bak), sube la versión a 1.8.1 y actualiza el CHANGELOG
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const appDir = join(root, 'src', 'app');
const engineDir = join(appDir, 'core', 'engine');

for (const f of ['sql-engine.ts', 'options.ts', 'models.ts', 'sql-rewrites.ts', 'sql-engine-v18.ts', 'options-v18.ts']) {
  if (!existsSync(join(engineDir, f))) { console.error(`✘ Falta src/app/core/engine/${f}. Copia el paquete completo y ejecuta desde la raíz del proyecto.`); process.exit(1); }
}

const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : []; });
const files = walk(appDir).filter(p => !p.startsWith(engineDir + sep));

const RE = /(from\s+['"])((?:\.\.?\/)+(?:[\w-]+\/)*engine\/)(sql-engine|options)(['"])/g;
const changes = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const out = src.replace(RE, (_, a, path, mod, z) => `${a}${path}${mod}-v18${z}`);
  if (out !== src) changes.push({ f, out, n: (src.match(RE) || []).length });
}
const already = files.some(f => /engine\/(sql-engine|options)-v18['"]/.test(readFileSync(f, 'utf8')));
const store = files.find(f => f.endsWith('optimizer.store.ts'));
const storeOk = store && (/engine\/sql-engine-v18['"]/.test(readFileSync(store, 'utf8')) || changes.some(c => c.f === store));

for (const c of changes) console.log(`✔ ${relative(root, c.f)} (${c.n} import${c.n > 1 ? 's' : ''})`);
if (!changes.length && already) console.log('• Ya aplicado: los imports apuntan a sql-engine-v18 / options-v18.');
if (!storeOk) {
  console.error('✘ No se encontró el import del motor en optimizer.store.ts. Cambio manual:\n' +
    "    import * as Engine from '../engine/sql-engine';      →  '../engine/sql-engine-v18'\n" +
    "    import { OPTIMIZE_OPTIONS } from '../engine/options'; →  '../engine/options-v18'");
  process.exit(1);
}
if (check) { console.log('\nVerificación correcta (modo --check, sin cambios).'); process.exit(0); }

for (const c of changes) { copyFileSync(c.f, c.f + '.bak'); writeFileSync(c.f, c.out); }

const pkg = join(root, 'package.json');
if (existsSync(pkg)) { const s = readFileSync(pkg, 'utf8'); writeFileSync(pkg, s.replace(/"version":\s*"[^"]+"/, '"version": "1.8.2"')); }
const ch = join(root, 'CHANGELOG.md');
if (existsSync(ch)) {
  const s = readFileSync(ch, 'utf8');
  if (!s.includes('## 1.8.2')) writeFileSync(ch, s.replace('# Changelog\n', `# Changelog

## 1.8.2
- SUBSTRING: también número sin comillas de n dígitos (= 305, IN (305, 302)).
- R10 explica qué filtros quedan pendientes y por qué (variable, otra columna, negación…).

## 1.8.1
- SQL optimizado aplica las reescrituras SARGables (casilla "Reescribir filtros no SARGables"):
  SUBSTRING/LEFT con texto → LIKE (incluye posición > 1 con '_', listas IN y literal a la izquierda), rangos con
  literales numéricos; CONVERT/CAST a DATE, CONVERT(VARCHAR, fecha, 112), YEAR, YEAR + MONTH, DATEDIFF y DATEADD
  sobre columnas de fecha → rangos con DATEADD/DATEDIFF. R10 indica cuántos filtros se reescribieron.
- DML sobre #temporales / @variables tabla: no cuenta para R31 ni R30 y la transacción no se envuelve en TRY/CATCH.
- Integración por adaptador (sql-engine-v18.ts / options-v18.ts): sql-engine.ts no se modifica.
`));
}
console.log(`\n✔ v1.8.2 activada (${changes.length} archivo(s), copias .bak). Siguiente: npm test && npm start`);
