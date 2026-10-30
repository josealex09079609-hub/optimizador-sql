import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { OptimizerStore, PlanTab } from '../../core/services/optimizer.store';
import { PlanPanelComponent } from './plan-panel.component';
import { PlanMainComponent } from './plan-main.component';
import { PlanFindingsComponent } from './plan-findings.component';
import { PlanImprovedComponent } from './plan-improved.component';
import { CodePanelComponent } from '../code-panel/code-panel.component';

/** Módulo Plan de ejecución: carga a la izquierda y subpestañas de resultados a la derecha. */
@Component({
  selector: 'app-plan-page',
  standalone: true,
  imports: [PlanPanelComponent, PlanMainComponent, PlanFindingsComponent, PlanImprovedComponent, CodePanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-plan-panel />
    <section class="card">
      <nav class="tabs">
        @for (t of tabs; track t.id) {
          <div class="tab" [class.on]="store.planTab() === t.id" (click)="store.planTab.set(t.id)">
            {{ t.label }} @if (badge(t.id) != null) { <span class="badge pl">{{ badge(t.id) }}</span> }
          </div>
        }
      </nav>
      <div class="view">
        @switch (store.planTab()) {
          @case ('main') { <app-plan-main /> }
          @case ('findings') { <app-plan-findings /> }
          @case ('improved') { <app-plan-improved /> }
          @case ('report') {
            <app-code-panel [code]="store.planReport()" [plain]="true" copyLabel="Copiar (para correo a DBA)"
              fileName="plan_REVISION.md" emptyText="Sin plan analizado." />
          }
        }
      </div>
    </section>
  `
})
export class PlanPageComponent {
  readonly store = inject(OptimizerStore);
  readonly tabs: { id: PlanTab; label: string }[] = [
    { id: 'main', label: 'Revisión principal' },
    { id: 'findings', label: 'Hallazgos y mejoras' },
    { id: 'improved', label: 'Sentencias mejoradas' },
    { id: 'report', label: 'Reporte' }
  ];
  private readonly counts = computed(() => {
    const r = this.store.planResult();
    if (!r) return { main: 0, findings: 0, improved: 0 };
    return {
      main: r.plan.findings.filter(f => f.main).length,
      findings: r.plan.findings.filter(f => f.id !== 'P00').length,
      improved: r.improved.statements.filter(x => x.after !== x.before).length
    };
  });
  badge(id: PlanTab): number | null { return id === 'report' ? null : this.counts()[id]; }
}
