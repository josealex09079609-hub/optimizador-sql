import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { OptimizerStore } from '../../core/services/optimizer.store';
import { planScore } from '../../core/engine/sql-engine';
import { PlanStatement, Severity } from '../../core/engine/models';

/** Subpestaña "Revisión principal": puntaje, alerta de spill, 5 indicadores y tabla por sentencia. */
@Component({
  selector: 'app-plan-main',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.planResult(); as r) {
      <div class="summary">
        <div class="score" [style.border-color]="scoreColor()">{{ score() }}</div>
        <div class="grow">
          <div class="proc-name">Plan {{ r.plan.isActual ? 'real' : 'estimado' }}{{ r.plan.build ? ' · SQL Server ' + r.plan.build : '' }} · {{ r.plan.statements.length }} sentencia(s)</div>
          <div class="chips">@for (s of severities; track s) { <span class="chip c-{{ s }}">{{ s }}: {{ counts()[s] }}</span> }</div>
        </div>
        <div class="meta">Puntaje del plan tras las mejoras automáticas: <b>{{ scoreAfter() }}</b></div>
      </div>
      <div class="scroll">
        @if (focus().spills) {
          <div class="spillbox">⚠ <b>{{ focus().spills }} alerta(s) de spill a tempdb</b>: es lo más importante a corregir. El operador no tuvo
            memoria suficiente y escribió en disco.</div>
        } @else if (r.plan.isActual) {
          <div class="spillbox ok">✔ Sin alertas de spill a tempdb.</div>
        } @else {
          <div class="spillbox est">Plan estimado: los spills solo se ven en el plan real.</div>
        }
        <div class="focus">
          @for (c of cards(); track c.key) {
            <div class="fc" [class.bad]="c.value" [class.okc]="!c.value" [class.spill]="c.key === 'P01'" (click)="goTo(c.key)">
              <div class="v">{{ c.value || '✔' }}</div><div class="l">{{ c.label }}</div>
            </div>
          }
        </div>

        <div class="sect">Sentencias del plan</div>
        <div class="ptable">
          <table class="pt">
            <tr><th>#</th><th>Sentencia</th><th>Costo</th><th>Memoria concedida / usada</th><th>Alertas</th><th>Tiempo</th></tr>
            @for (s of r.plan.statements; track s.n) {
              <tr>
                <td class="n">{{ s.n }}</td>
                <td><b>{{ s.type }}</b><div class="stmt-txt">{{ s.text }}</div></td>
                <td class="n">{{ s.cost != null ? s.cost.toFixed(3) : '—' }}</td>
                <td>
                  {{ kb(s.grantedKB) }} / {{ kb(s.usedKB) }}
                  @if (usage(s) != null) { <div class="bar-m"><i [class.low]="excessive(s)" [style.width.%]="barWidth(s)"></i></div> }
                </td>
                <td>
                  @if (s.spills) { <span class="pill bad">⚠ {{ s.spills }} spill</span> }
                  @if (s.converts) { <span class="pill bad">{{ s.converts }} CONVERT</span> }
                  @if (has(s.n, 'P15')) { <span class="pill bad">Table Scan</span> }
                  @if (excessive(s)) { <span class="pill warn">memoria</span> }
                  @if (has(s.n, 'P08')) { <span class="pill warn">residual</span> }
                  @if (s.timeout) { <span class="pill warn">timeout</span> }
                  @if (!s.spills && !s.converts && !excessive(s) && !s.timeout && !has(s.n, 'P15') && !has(s.n, 'P08')) { <span class="pill okp">OK</span> }
                </td>
                <td class="n">{{ s.elapsedMs != null ? num(s.elapsedMs) + ' ms' : '—' }}</td>
              </tr>
            }
          </table>
        </div>
        <div class="hint plain">Clic en una tarjeta para ver sus hallazgos y mejoras propuestas.</div>
      </div>
    } @else {
      <div class="scroll"><div class="empty">Sube un plan de ejecución (.sqlplan) y presiona <b>Analizar plan</b>.</div></div>
    }
  `
})
export class PlanMainComponent {
  readonly store = inject(OptimizerStore);
  readonly severities: Severity[] = ['Alta', 'Media', 'Baja', 'Info'];
  private readonly findings = computed(() => this.store.planResult()?.plan.findings ?? []);
  readonly counts = computed(() => {
    const c: Record<Severity, number> = { Alta: 0, Media: 0, Baja: 0, Info: 0 };
    this.findings().forEach(f => c[f.sev]++);
    return c;
  });
  readonly score = computed(() => planScore(this.findings()));
  readonly scoreAfter = computed(() => planScore(this.findings().filter(f => !this.store.planFixed().has(f.key || ''))));
  readonly scoreColor = computed(() => this.score() >= 80 ? 'var(--ok)' : this.score() >= 50 ? 'var(--media)' : 'var(--alta)');
  readonly focus = computed(() => this.store.planResult()?.plan.focus ?? { spills: 0, converts: 0, tableScans: 0, memory: 0, residual: 0 });
  /** Spill primero: es la alerta más importante del plan. */
  readonly cards = computed(() => {
    const f = this.focus();
    return [
      { key: 'P01', value: f.spills, label: 'Spill a tempdb' },
      { key: 'P02', value: f.converts, label: 'Conversiones implícitas con alerta' },
      { key: 'P15', value: f.tableScans, label: 'Table Scan' },
      { key: 'P04', value: f.memory, label: 'Sobreestimación de memoria elevada' },
      { key: 'P08', value: f.residual, label: 'Lectura residual elevada' }
    ];
  });

  goTo(id: string): void {
    this.store.planTab.set('findings');
    setTimeout(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('[id^="pf-"]'))
        .find(e => e.id.startsWith('pf-' + id) || (id === 'P02' && e.id.startsWith('pf-P03')));
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  has(stmt: number, id: string): boolean { return this.findings().some(f => f.stmt === stmt && f.id === id); }
  usage(s: PlanStatement): number | null { return s.grantedKB && s.usedKB != null ? s.usedKB / s.grantedKB : null; }
  excessive(s: PlanStatement): boolean { const u = this.usage(s); return u != null && (s.grantedKB ?? 0) >= 51200 && u < 0.1; }
  barWidth(s: PlanStatement): number { return Math.max(2, Math.min(100, (this.usage(s) ?? 0) * 100)); }
  kb(v: number | null): string { return v == null ? '—' : v >= 1048576 ? (v / 1048576).toFixed(2) + ' GB' : v >= 1024 ? (v / 1024).toFixed(1) + ' MB' : Math.round(v) + ' KB'; }
  num(v: number): string { return Math.round(v).toLocaleString('es-PE'); }
}
