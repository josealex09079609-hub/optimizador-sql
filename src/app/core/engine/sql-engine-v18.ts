/**
 * v1.8.1 · Adaptador del motor. Reexporta todo sql-engine.ts y agrega, SIN modificar ese archivo:
 *   - Reescrituras SARGables en el SQL optimizado (opción "sargPlus"): SUBSTRING/LEFT → LIKE, fechas → rangos.
 *   - DML sobre #temporales / @variables tabla: no cuenta para R31 (DML sin transacción) ni R30 (sin TRY/CATCH),
 *     y "Cerrar transacciones" no envuelve una transacción que solo modifica temporales.
 * Para activarlo basta con importar este archivo en lugar de './sql-engine' (optimizer.store.ts).
 */
import * as base from './sql-engine';
import { AnalysisResult, AppliedChange, Finding, ImprovedPlan, OptimizeOptions, OptimizeResult, PlanAnalysis } from './models';
import { maskSql, physicalDml, sargPending, sargRewrite, tranOnlyTemp } from './sql-rewrites';
import './options-v18'; // agrega sargPlus a OptimizeOptions

export * from './sql-engine';

const WEIGHT: Record<string, number> = { Alta: 6, Media: 3, Baja: 1, Info: 0 };
const ORDER: Record<string, number> = { Alta: 0, Media: 1, Baja: 2, Info: 3 };
const lineOf = (s: string, i: number) => s.slice(0, i).split('\n').length;

const SARG_CHANGE = (count: number): AppliedChange => ({
  key: 'sargRewrite',
  label: `Filtros no SARGables reescritos: SUBSTRING → LIKE, fechas → rangos con DATEADD/DATEDIFF (${count})`,
  count,
  motivo: 'Predicado SARGable: la función pasa de la columna al valor',
  seguro: 'Solo reescrituras equivalentes (mismos registros). Comparaciones con variables u otras columnas no se cambian.'
});

/** Las transacciones del script (con COMMIT) solo tocan temporales: no se envuelven ni se exige TRY/CATCH. */
function closedTempOnlyTran(src: string): boolean {
  const m = maskSql(src);
  const begins = (m.match(/\bBEGIN\s+TRAN(?:SACTION)?\b/gi) || []).length;
  const commits = (m.match(/\bCOMMIT\b/gi) || []).length;
  return begins > 0 && commits >= begins && tranOnlyTemp(src);
}

export function analyze(src: string): AnalysisResult {
  const a = base.analyze(src);
  let findings: Finding[] = a.findings.map(f => ({ ...f }));

  // R10: indicar cuántos filtros se reescriben automáticamente
  const r10 = findings.find(f => f.id === 'R10');
  if (r10) {
    const rw = sargRewrite(src);
    const pend = sargPending(src);
    if (rw.count) {
      r10.autofix = true;
      r10.detail = `${r10.detail} ✔ Se reescriben automáticamente ${rw.count} en "SQL optimizado" (líneas ${[...new Set(rw.changes.map(c => c.line))].join(', ')}).`;
    }
    if (pend.length) {
      r10.detail += ` Pendientes de revisión manual (${pend.length}): ` +
        pend.slice(0, 8).map(p => `línea ${p.line} ${p.expr} → ${p.reason}`).join(' · ') + (pend.length > 8 ? ' …' : '') + '.';
    }
  }

  // R31: no contar INSERT/UPDATE/DELETE sobre temporales
  const r31 = findings.find(f => f.id === 'R31');
  if (r31) {
    const phys = physicalDml(src);
    if (phys.length < 2) findings = findings.filter(f => f !== r31);
    else {
      r31.detail = `${phys.length} sentencias INSERT/UPDATE/DELETE sobre tablas permanentes (no se cuentan las de #temporales ni @variables tabla).`;
      r31.lines = [...new Set(phys.map(i => lineOf(src, i)))].sort((x, y) => x - y);
    }
  }

  // R30: transacción que solo modifica temporales → no exige TRY/CATCH
  if (findings.some(f => f.id === 'R30') && closedTempOnlyTran(src)) findings = findings.filter(f => f.id !== 'R30');

  findings.sort((x, y) => ORDER[x.sev] - ORDER[y.sev] || x.id.localeCompare(y.id));
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + (WEIGHT[f.sev] || 0), 0));
  return { ...a, findings, score };
}

export function optimize(src: string, opts: OptimizeOptions, plan?: PlanAnalysis | null): OptimizeResult {
  const o: OptimizeOptions = { ...opts };
  if (o.closeTran && closedTempOnlyTran(src)) o.closeTran = false;
  const r = base.optimize(src, o, plan);
  if (!o.sargPlus) return r;
  const rw = sargRewrite(r.src);          // idempotente: si ya se aplicó, no cambia nada
  if (!rw.count) return r;
  return { ...r, src: rw.src, applied: [...r.applied, SARG_CHANGE(rw.count)] };
}

export function improvePlan(plan: PlanAnalysis | null, opts: OptimizeOptions): ImprovedPlan {
  const imp = base.improvePlan(plan, opts);
  if (!opts.sargPlus) return imp;
  return {
    ...imp,
    statements: imp.statements.map(st => {
      const rw = sargRewrite(st.after);
      return rw.count ? { ...st, after: rw.src, applied: [...st.applied, `Filtros no SARGables reescritos (${rw.count})`] } : st;
    })
  };
}
