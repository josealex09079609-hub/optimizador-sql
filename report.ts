import { AnalysisResult, ImprovedPlan, OptimizeResult, PlanAnalysis } from './models';
import { planReport, planScore } from './sql-engine';

const fecha = () => new Date().toLocaleDateString('es-PE');
const pendingScore = (plan: PlanAnalysis, fixed: string[]) => planScore(plan.findings.filter(f => !fixed.includes(f.key || '')));

/** Reporte del procedimiento con el formato de entrega de la skill (§8). */
export function buildReport(a: AnalysisResult, opt: OptimizeResult, after: AnalysisResult): string {
  const p = a.proc;
  const name = p ? (p.schema ? p.schema + '.' : '') + p.name : 'Script SQL';
  const cell = (t: string) => String(t).replace(/\|/g, '\\|');
  let r = `# Revisión de PA – ${name}\nFecha: ${fecha()} · Estándar: skill pa-sqlserver-cajaica\n`;
  r += `Puntaje: ${a.score}/100 → ${after.score}/100 tras cambios aplicados\n\n`;
  r += `## 1. Tabla de cambios aplicados\n`;
  r += opt.applied.length
    ? `| Cambio | Motivo | Por qué no altera la lógica |\n|---|---|---|\n` + opt.applied.map(x => `| ${cell(x.label)} | ${cell(x.motivo)} | ${cell(x.seguro)} |`).join('\n') + '\n'
    : '- Ninguno\n';
  r += `\n## 2. Observaciones no aplicadas\n`;
  const pend = after.findings.filter(f => f.sev !== 'Info' || ['R04', 'R58', 'R61'].includes(f.id));
  if (!pend.length) r += '- Ninguna\n';
  (['Alta', 'Media', 'Baja', 'Info'] as const).forEach(s => {
    const l = pend.filter(f => f.sev === s);
    if (!l.length) return;
    r += `\n### Prioridad ${s}\n`;
    l.forEach(f => {
      r += `- **${f.id} ${f.title}**${f.lines.length ? ` (líneas ${f.lines.slice(0, 15).join(', ')} del código optimizado)` : ''}\n`;
      r += `  ${f.detail ? f.detail + ' ' : ''}${f.rec}${f.ref ? `\n  _Ref.: ${f.ref}_` : ''}\n`;
    });
  });
  r += `\n## 3. Preguntas / contexto faltante\n`;
  const ctx: string[] = [];
  if (/TODO: validar/.test(opt.src)) ctx.push('Tipos y longitudes exactos marcados con TODO: ejecutar los scripts de Metadatos.');
  if (after.findings.some(f => f.id === 'R11')) ctx.push('Código de las funciones de usuario utilizadas.');
  if (after.findings.some(f => f.id === 'R61')) ctx.push('Código de los PAs invocados, si el cambio los involucra.');
  if (after.findings.some(f => f.id === 'R33' || f.id === 'R23')) ctx.push('Tipos reales de las columnas comparadas (posibles conversiones implícitas).');
  ctx.push('Plan de ejecución real (.sqlplan): analízalo en el módulo Plan de ejecución.');
  ctx.push('¿Es un PA nuevo o existente? (define si aplica SET NOCOUNT ON y la nomenclatura).');
  r += ctx.map(x => '- ' + x).join('\n') + '\n';
  r += `\n## 4. Validación antes del pase a DBA\n- Mismos result sets (columnas, orden, tipos, filas) y mismos efectos (DML, OUTPUT, RETURN).\n`;
  r += `- Planes de ejecución ORIGINAL y MEJORA (.sqlplan): sin CONVERT_IMPLICIT, sin spills, memoria concedida acorde a la usada, menos lecturas lógicas.\n- Diccionario de datos registrado si el PA no lo tenía.\n`;
  return r;
}

/** Reporte del módulo Plan de ejecución. */
export function buildPlanReport(plan: PlanAnalysis, improved: ImprovedPlan): string {
  let r = `# Revisión de plan de ejecución\nFecha: ${fecha()} · Estándar: skill pa-sqlserver-cajaica\n`;
  r += `Puntaje del plan: ${planScore(plan.findings)}/100 → ${pendingScore(plan, improved.fixed)}/100 con las mejoras automáticas\n`;
  r += planReport(plan, improved.fixed, improved);
  r += `\n## Validación antes del pase a DBA\n- Aplicar las sentencias mejoradas en el PA respetando sus declaraciones (tipos de variables y temporales).\n`;
  r += `- Volver a capturar el plan real: sin spills, sin conversiones con alerta, memoria concedida acorde a la usada, menos lecturas lógicas (SET STATISTICS IO, TIME ON).\n- Los índices y estadísticas propuestos se validan con el DBA.\n`;
  return r;
}
