import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { OptimizerStore } from '../../core/services/optimizer.store';
import { Severity } from '../../core/engine/models';

@Component({
  selector: 'app-findings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.proc(); as r) {
      <div class="summary">
        <div class="score" [style.border-color]="scoreColor()">{{ r.analysis.score }}</div>
        <div class="grow">
          <div class="proc-name">{{ store.baseName() }}</div>
          <div class="chips">
            @for (s of severities; track s) {
              <span class="chip c-{{ s }}" [class.off]="!store.filters().has(s)" (click)="store.toggleFilter(s)">{{ s }}: {{ store.counts()[s] }}</span>
            }
          </div>
        </div>
        <div class="meta">
          {{ r.analysis.stats.lines }} líneas · {{ r.analysis.stats.tables.length }} tablas · {{ r.analysis.stats.temps.length }} temporales ·
          Puntaje tras correcciones automáticas: <b>{{ r.after.score }}</b> · Clic en un nivel para filtrar y en un número de línea para ubicarlo.
        </div>
      </div>
      <div class="scroll">
        @for (f of store.visibleFindings(); track f.id) {
          <div class="f {{ f.sev }}">
            <div class="t">
              <span class="chip c-{{ f.sev }}">{{ f.sev }}</span>
              <span class="id">{{ f.id }}</span>{{ f.title }}
              @if (f.autofix) { <span class="auto">corrección automática</span> }
              <span class="cat">{{ f.cat }}</span>
            </div>
            @if (f.detail) { <div class="d">{{ f.detail }}</div> }
            <div class="r">{{ f.rec }}</div>
            <div class="x">
              @if (f.lines.length) {
                <span>Líneas:
                  @for (l of f.lines.slice(0, 20); track l; let last = $last) {
                    <span class="ln" (click)="store.goTo(l)">{{ l }}</span>{{ last ? '' : ', ' }}
                  }
                  {{ f.lines.length > 20 ? '…' : '' }}
                </span>
              }
              @if (f.ref) { <span>📘 {{ f.ref }}</span> }
            </div>
          </div>
        } @empty {
          <div class="empty">✅ No se encontraron observaciones con los filtros actuales.</div>
        }
      </div>
    } @else {
      <div class="scroll"><div class="empty">Pega un procedimiento y presiona <b>Analizar procedimiento</b>.</div></div>
    }
  `
})
export class FindingsComponent {
  readonly store = inject(OptimizerStore);
  readonly severities: Severity[] = ['Alta', 'Media', 'Baja', 'Info'];
  readonly scoreColor = computed(() => {
    const s = this.store.proc()?.analysis.score ?? 0;
    return s >= 80 ? 'var(--ok)' : s >= 50 ? 'var(--media)' : 'var(--alta)';
  });
}
