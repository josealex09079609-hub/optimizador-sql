import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { OptimizerStore } from '../../core/services/optimizer.store';
import { ClipboardService } from '../../core/services/clipboard.service';
import { Severity } from '../../core/engine/models';
import { highlightSql } from '../../core/engine/highlight';

/** Subpestaña "Hallazgos y mejoras": principales primero (spill), el resto plegado. */
@Component({
  selector: 'app-plan-findings',
  standalone: true,
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.planResult()) {
      <div class="scroll">
        <div class="chips">
          @for (s of severities; track s) {
            <span class="chip c-{{ s }}" [class.off]="!store.planFilters().has(s)" (click)="store.togglePlanFilter(s)">{{ s }}: {{ counts()[s] }}</span>
          }
        </div>
        <div class="sect">Principales: spill, conversiones con alerta, Table Scan, memoria elevada, lectura residual</div>
        @for (f of main(); track f.key) {
          <ng-container *ngTemplateOutlet="finding; context: { $implicit: f }" />
        } @empty {
          <div class="empty">✅ Sin hallazgos principales.</div>
        }
        @if (others().length) {
          <details class="others">
            <summary>Otras observaciones del plan ({{ others().length }})</summary>
            @for (f of others(); track f.key) {
              <ng-container *ngTemplateOutlet="finding; context: { $implicit: f }" />
            }
          </details>
        }
      </div>
      <div class="bar"><button (click)="clip.copy(store.proposalsScript())">Copiar todos los scripts de mejora</button></div>

      <ng-template #finding let-f>
        <div class="f {{ f.sev }}" [id]="'pf-' + f.key">
          <div class="t">
            <span class="chip c-{{ f.sev }}">{{ f.sev }}</span><span class="id">{{ f.id }}</span>{{ f.title }}
            @if (f.stmt) { <span class="src-plan">sentencia {{ f.stmt }}</span> }
            @if (store.planFixed().has(f.key)) { <span class="st-ok">✔ aplicado en la sentencia mejorada</span> }
            <span class="cat">{{ f.cat }}</span>
          </div>
          <div class="d">{{ f.detail }}</div>
          <div class="r">{{ f.rec }}</div>
          @if (f.proposal; as pr) {
            <div class="prop">
              <div class="ph"><b>💡 Mejora propuesta</b>@if (pr.sql) { <button (click)="clip.copy(pr.sql)">Copiar</button> }</div>
              <div class="ptext">{{ pr.text }}</div>
              @if (pr.sql) { <pre [innerHTML]="hl(pr.sql)"></pre> }
            </div>
          }
          @if (f.ref) { <div class="x"><span>📘 {{ f.ref }}</span></div> }
        </div>
      </ng-template>
    } @else {
      <div class="scroll"><div class="empty">Sin plan analizado.</div></div>
    }
  `
})
export class PlanFindingsComponent {
  readonly store = inject(OptimizerStore);
  readonly clip = inject(ClipboardService);
  readonly severities: Severity[] = ['Alta', 'Media', 'Baja', 'Info'];
  readonly hl = highlightSql;
  private readonly all = computed(() => this.store.planResult()?.plan.findings ?? []);
  private readonly visible = computed(() => this.all().filter(f => this.store.planFilters().has(f.sev)));
  readonly main = computed(() => this.visible().filter(f => f.main));
  readonly others = computed(() => this.visible().filter(f => !f.main));
  readonly counts = computed(() => {
    const c: Record<Severity, number> = { Alta: 0, Media: 0, Baja: 0, Info: 0 };
    this.all().forEach(f => c[f.sev]++);
    return c;
  });
}
