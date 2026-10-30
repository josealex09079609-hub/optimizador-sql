import { Injectable, computed, signal } from '@angular/core';
import * as Engine from '../engine/sql-engine';
import { AnalysisResult, ImprovedPlan, OptimizeOptions, OptimizeResult, PlanAnalysis, Severity } from '../engine/models';
import { OPTIMIZE_OPTIONS } from '../engine/options';
import { buildPlanReport, buildReport } from '../engine/report';

export type Mode = 'proc' | 'plan';
export type ProcTab = 'findings' | 'optimized' | 'dictionary' | 'metadata' | 'report';
export type PlanTab = 'main' | 'findings' | 'improved' | 'report';

interface ProcState { src: string; analysis: AnalysisResult; opt: OptimizeResult; after: AnalysisResult; }
interface PlanState { plan: PlanAnalysis; improved: ImprovedPlan; }

const allSev = () => new Set<Severity>(['Alta', 'Media', 'Baja', 'Info']);

/**
 * Estado de la aplicación con signals. Procedimiento y Plan de ejecución son módulos independientes:
 * cada uno tiene su entrada, su resultado y sus subpestañas.
 */
@Injectable({ providedIn: 'root' })
export class OptimizerStore {
  // ---------- Navegación ----------
  readonly mode = signal<Mode>('proc');
  readonly procTab = signal<ProcTab>('findings');
  readonly planTab = signal<PlanTab>('main');

  readonly options = signal<OptimizeOptions>(
    Object.fromEntries(OPTIMIZE_OPTIONS.map(o => [o.key, o.default])) as OptimizeOptions
  );
  readonly codeOptions = OPTIMIZE_OPTIONS.filter(o => o.group !== 'plan');
  readonly planOptions = OPTIMIZE_OPTIONS.filter(o => o.group === 'plan');

  // ---------- Procedimiento ----------
  readonly source = signal('');
  readonly filters = signal<Set<Severity>>(allSev());
  readonly gotoLine = signal<{ line: number; n: number } | null>(null);
  private readonly procState = signal<ProcState | null>(null);
  readonly proc = this.procState.asReadonly();

  readonly baseName = computed(() => {
    const p = this.procState()?.analysis.proc;
    return p ? (p.schema ? p.schema + '.' : '') + p.name : 'script';
  });
  readonly visibleFindings = computed(() => {
    const s = this.procState(); const f = this.filters();
    return s ? s.analysis.findings.filter(x => f.has(x.sev)) : [];
  });
  readonly counts = computed(() => {
    const c: Record<Severity, number> = { Alta: 0, Media: 0, Baja: 0, Info: 0 };
    this.procState()?.analysis.findings.forEach(f => c[f.sev]++);
    return c;
  });
  readonly dictionary = computed(() => { const s = this.procState(); return s ? Engine.dictionary(s.src) : ''; });
  readonly metadata = computed(() => { const s = this.procState(); return s ? Engine.metadataScripts(s.src) : ''; });
  readonly report = computed(() => { const s = this.procState(); return s ? buildReport(s.analysis, s.opt, s.after) : ''; });

  runProc(): void {
    const src = this.source();
    if (!src.trim()) { this.procState.set(null); return; }
    const analysis = Engine.analyze(src);
    const opt = Engine.optimize(src, this.options(), null);
    this.procState.set({ src, analysis, opt, after: Engine.analyze(opt.src) });
  }
  toggleFilter(sev: Severity): void { this.filters.update(f => toggle(f, sev)); }
  useOptimizedAsInput(): void {
    const s = this.procState();
    if (!s) return;
    this.source.set(s.opt.src);
    this.runProc();
    this.procTab.set('findings');
  }
  clearProc(): void { this.source.set(''); this.procState.set(null); }
  goTo(line: number): void { this.mode.set('proc'); this.gotoLine.set({ line, n: Date.now() }); }

  // ---------- Plan de ejecución (no requiere el procedimiento) ----------
  readonly planXml = signal('');
  readonly planFilters = signal<Set<Severity>>(allSev());
  /** Estado de lectura del plan (para el panel de carga). */
  readonly planParsed = computed<PlanAnalysis | null>(() => {
    const xml = this.planXml();
    return xml.trim() ? Engine.analyzePlan(xml) : null;
  });
  private readonly planState = signal<PlanState | null>(null);
  readonly planResult = this.planState.asReadonly();
  readonly planFixed = computed(() => new Set(this.planState()?.improved.fixed ?? []));
  readonly planReport = computed(() => { const s = this.planState(); return s ? buildPlanReport(s.plan, s.improved) : ''; });
  readonly proposalsScript = computed(() => (this.planState()?.plan.findings ?? [])
    .filter(f => f.proposal?.sql).map(f => `-- ${f.id} ${f.title}${f.stmt ? ' (sentencia ' + f.stmt + ')' : ''}\n${f.proposal!.sql}`).join('\n\nGO\n\n'));
  readonly improvedScript = computed(() => (this.planState()?.improved.statements ?? [])
    .map(x => `-- Sentencia ${x.n} (${x.type})${x.applied.length ? ' · ' + x.applied.join(' · ') : ''}\n${x.after}`).join('\n\n'));

  runPlan(): void {
    const plan = this.planParsed();
    if (!plan || !plan.ok) { this.planState.set(null); return; }
    const o = this.options();
    // Opciones del plan + (opcional) las mismas reglas de código marcadas en Procedimiento
    const opts: OptimizeOptions = o.planCode ? { ...o } : { planConvert: o.planConvert, planSort: o.planSort };
    this.planState.set({ plan, improved: Engine.improvePlan(plan, opts) });
  }
  setPlan(xml: string): void { this.planXml.set(xml); this.runPlan(); }
  togglePlanFilter(sev: Severity): void { this.planFilters.update(f => toggle(f, sev)); }
  clearPlan(): void { this.setPlan(''); }

  // ---------- Opciones ----------
  setOption(key: keyof OptimizeOptions, value: boolean): void {
    this.options.update(o => ({ ...o, [key]: value }));
    if (this.procState()) this.runProc();
    if (this.planState()) this.runPlan();
  }
}

function toggle<T>(set: Set<T>, v: T): Set<T> {
  const n = new Set(set);
  if (n.has(v)) n.delete(v); else n.add(v);
  return n;
}
