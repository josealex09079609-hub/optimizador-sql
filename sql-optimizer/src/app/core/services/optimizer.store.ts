import { Injectable, computed, signal } from '@angular/core';
import * as Engine from '../engine/sql-engine';
import { AnalysisResult, OptimizeOptions, OptimizeResult, Severity } from '../engine/models';
import { OPTIMIZE_OPTIONS } from '../engine/options';
import { buildReport } from '../engine/report';

interface RunState { src: string; analysis: AnalysisResult; opt: OptimizeResult; after: AnalysisResult; }

/** Estado de la aplicación con signals. El análisis se ejecuta bajo demanda (botón / Ctrl+Enter). */
@Injectable({ providedIn: 'root' })
export class OptimizerStore {
  readonly source = signal('');
  readonly options = signal<OptimizeOptions>(
    Object.fromEntries(OPTIMIZE_OPTIONS.map(o => [o.key, o.default])) as OptimizeOptions
  );
  readonly filters = signal<Set<Severity>>(new Set(['Alta', 'Media', 'Baja', 'Info']));
  /** Línea a resaltar en el editor (clic en un hallazgo). */
  readonly gotoLine = signal<{ line: number; n: number } | null>(null);

  private readonly state = signal<RunState | null>(null);

  readonly result = this.state.asReadonly();
  readonly hasResult = computed(() => this.state() !== null);
  readonly baseName = computed(() => {
    const p = this.state()?.analysis.proc;
    return p ? (p.schema ? p.schema + '.' : '') + p.name : 'script';
  });
  readonly visibleFindings = computed(() => {
    const s = this.state(); const f = this.filters();
    return s ? s.analysis.findings.filter(x => f.has(x.sev)) : [];
  });
  readonly counts = computed(() => {
    const c: Record<Severity, number> = { Alta: 0, Media: 0, Baja: 0, Info: 0 };
    this.state()?.analysis.findings.forEach(f => c[f.sev]++);
    return c;
  });
  readonly dictionary = computed(() => (this.state() ? Engine.dictionary(this.state()!.src) : ''));
  readonly metadata = computed(() => (this.state() ? Engine.metadataScripts(this.state()!.src) : ''));
  readonly report = computed(() => {
    const s = this.state();
    return s ? buildReport(s.analysis, s.opt, s.after) : '';
  });

  run(): void {
    const src = this.source();
    if (!src.trim()) { this.state.set(null); return; }
    const analysis = Engine.analyze(src);
    const opt = Engine.optimize(src, this.options());
    const after = Engine.analyze(opt.src);
    this.state.set({ src, analysis, opt, after });
  }

  setOption(key: keyof OptimizeOptions, value: boolean): void {
    this.options.update(o => ({ ...o, [key]: value }));
    if (this.state()) this.run();
  }

  toggleFilter(sev: Severity): void {
    this.filters.update(f => { const n = new Set(f); n.has(sev) ? n.delete(sev) : n.add(sev); return n; });
  }

  useOptimizedAsInput(): void {
    const s = this.state();
    if (!s) return;
    this.source.set(s.opt.src);
    this.run();
  }

  clear(): void { this.source.set(''); this.state.set(null); }

  goTo(line: number): void { this.gotoLine.set({ line, n: Date.now() }); }
}
