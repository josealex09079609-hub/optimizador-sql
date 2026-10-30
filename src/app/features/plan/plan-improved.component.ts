import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { OptimizerStore } from '../../core/services/optimizer.store';
import { ClipboardService } from '../../core/services/clipboard.service';
import { diffLines, wordDiff } from '../../core/engine/diff';
import { escapeHtml, highlightSql } from '../../core/engine/highlight';

/** Subpestaña "Sentencias mejoradas": comparación actual vs mejorada por sentencia. */
@Component({
  selector: 'app-plan-improved',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="applied muted">Mejoras aplicadas sobre el texto de cada sentencia del plan. El plan no incluye las declaraciones del PA
      (tipos de variables y temporales): valida antes de reemplazar en el procedimiento.</div>
    <div class="scroll">
      @for (x of items(); track x.n) {
        <div class="imp">
          <div class="ih"><b>Sentencia {{ x.n }}</b> · {{ x.type }}<span class="muted">{{ x.applied.join(' · ') }}</span>
            <button (click)="clip.copy(x.after)">Copiar</button></div>
          <table class="diff">
            <colgroup><col style="width:36px"><col><col style="width:36px"><col></colgroup>
            <tr class="hd"><td colspan="2">Actual (según el plan)</td><td colspan="2">Mejorada</td></tr>
            @for (row of x.rows; track $index) {
              <tr>
                @if (row.a != null) { <td class="ln" [class.del]="row.ch">{{ row.a }}</td><td [class.del]="row.ch" [innerHTML]="row.aHtml"></td> }
                @else { <td class="ln emp"></td><td class="emp"></td> }
                @if (row.b != null) { <td class="ln" [class.add]="row.ch">{{ row.b }}</td><td [class.add]="row.ch" [innerHTML]="row.bHtml"></td> }
                @else { <td class="ln emp"></td><td class="emp"></td> }
              </tr>
            }
          </table>
        </div>
      } @empty {
        <div class="empty">{{ store.planResult() ? 'No hay cambios automáticos aplicables con las opciones seleccionadas.' : 'Sin plan analizado.' }}</div>
      }
    </div>
    <div class="bar">
      <button (click)="clip.copy(store.improvedScript())">Copiar sentencias mejoradas</button>
      <button (click)="clip.download('plan_SENTENCIAS_MEJORADAS.sql', store.improvedScript())">Descargar .sql</button>
    </div>
  `
})
export class PlanImprovedComponent {
  readonly store = inject(OptimizerStore);
  readonly clip = inject(ClipboardService);

  readonly items = computed(() => (this.store.planResult()?.improved.statements ?? []).filter(x => x.after !== x.before).map(x => {
    const { A, B, blocks } = diffLines(x.before, x.after);
    const rows: { a: number | null; b: number | null; aHtml: string; bHtml: string; ch: boolean }[] = [];
    for (const bl of blocks) {
      if (bl.t === 'eq') { for (const o of bl.rows) rows.push({ a: o.a! + 1, b: o.b! + 1, aHtml: highlightSql(A[o.a!]) || ' ', bHtml: highlightSql(B[o.b!]) || ' ', ch: false }); continue; }
      for (let i = 0; i < Math.max(bl.del.length, bl.add.length); i++) {
        const a = bl.del[i], b = bl.add[i];
        let aH = a !== undefined ? escapeHtml(A[a]) : '', bH = b !== undefined ? escapeHtml(B[b]) : '';
        if (a !== undefined && b !== undefined) [aH, bH] = wordDiff(A[a], B[b]);
        rows.push({ a: a !== undefined ? a + 1 : null, b: b !== undefined ? b + 1 : null, aHtml: aH || ' ', bHtml: bH || ' ', ch: true });
      }
    }
    return { ...x, rows };
  }));
}
