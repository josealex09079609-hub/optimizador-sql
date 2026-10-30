import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { OptimizerStore } from '../../core/services/optimizer.store';
import { ClipboardService } from '../../core/services/clipboard.service';
import { diffLines, wordDiff } from '../../core/engine/diff';
import { escapeHtml, highlightSql } from '../../core/engine/highlight';

type Mode = 'side' | 'unified' | 'result';
interface Row {
  kind: 'eq' | 'ch' | 'fold' | 'del' | 'add';
  aNo?: number; bNo?: number; aHtml?: string; bHtml?: string;
  hasA?: boolean; hasB?: boolean; foldId?: string; hidden?: number;
}

@Component({
  selector: 'app-diff-viewer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.proc(); as r) {
      <div class="applied">
        @if (r.opt.applied.length) {
          ✔ Cambios aplicados:
          @for (a of r.opt.applied; track a.key; let last = $last) { {{ a.label }}{{ last ? '' : ' · ' }} }
          <br><span class="warn">⚠ Regla de oro: lo que no se puede demostrar equivalente no se aplica y queda en
          "Observaciones no aplicadas" (Reporte). Valida resultados y el plan real antes del pase.</span>
        } @else { No se aplicaron cambios automáticos con las opciones seleccionadas. }
      </div>

      <div class="diffbar">
        <div class="seg">
          <button [class.on]="mode() === 'side'" (click)="mode.set('side')">Antes / Después</button>
          <button [class.on]="mode() === 'unified'" (click)="mode.set('unified')">Unificado</button>
          <button [class.on]="mode() === 'result'" (click)="mode.set('result')">Solo resultado</button>
        </div>
        <label class="muted inline"><input type="checkbox" [checked]="fold()" (change)="toggleFold()"> Ocultar líneas sin cambios</label>
        <span class="dstat">
          @if (diff().removed || diff().added) {
            <b class="d">−{{ diff().removed }}</b> / <b class="a">+{{ diff().added }}</b> líneas · {{ diff().changedBlocks }} bloque(s) modificado(s)
          } @else { Sin diferencias }
        </span>
      </div>

      @if (mode() === 'result') {
        <pre class="code" [innerHTML]="resultHtml()"></pre>
      } @else {
        <div class="diffwrap">
          <table class="diff">
            @if (mode() === 'side') {
              <colgroup><col style="width:44px"><col><col style="width:44px"><col></colgroup>
              <tr class="hd"><td colspan="2">ANTES (original)</td><td colspan="2">DESPUÉS (optimizado)</td></tr>
            } @else {
              <colgroup><col style="width:44px"><col style="width:44px"><col style="width:16px"><col></colgroup>
              <tr class="hd"><td colspan="4">Unificado: <span class="txt-del">− antes</span> · <span class="txt-add">+ después</span></td></tr>
            }
            @for (row of rows(); track $index) {
              @switch (row.kind) {
                @case ('fold') {
                  <tr class="fold" (click)="expand(row.foldId!)"><td colspan="4">⋯ {{ row.hidden }} líneas sin cambios (clic para mostrar)</td></tr>
                }
                @case ('eq') {
                  @if (mode() === 'side') {
                    <tr><td class="ln">{{ row.aNo }}</td><td [innerHTML]="row.aHtml"></td><td class="ln">{{ row.bNo }}</td><td [innerHTML]="row.bHtml"></td></tr>
                  } @else {
                    <tr><td class="ln">{{ row.aNo }}</td><td class="ln">{{ row.bNo }}</td><td class="sg"></td><td [innerHTML]="row.bHtml"></td></tr>
                  }
                }
                @case ('ch') {
                  <tr>
                    @if (row.hasA) { <td class="ln del">{{ row.aNo }}</td><td class="del" [innerHTML]="row.aHtml"></td> }
                    @else { <td class="ln emp"></td><td class="emp"></td> }
                    @if (row.hasB) { <td class="ln add">{{ row.bNo }}</td><td class="add" [innerHTML]="row.bHtml"></td> }
                    @else { <td class="ln emp"></td><td class="emp"></td> }
                  </tr>
                }
                @case ('del') {
                  <tr><td class="ln del">{{ row.aNo }}</td><td class="ln del"></td><td class="sg del">−</td><td class="del" [innerHTML]="row.aHtml"></td></tr>
                }
                @case ('add') {
                  <tr><td class="ln add"></td><td class="ln add">{{ row.bNo }}</td><td class="sg add">+</td><td class="add" [innerHTML]="row.bHtml"></td></tr>
                }
              }
            }
          </table>
        </div>
      }

      <div class="bar">
        <button (click)="clip.copy(r.opt.src)">Copiar</button>
        <button (click)="clip.download(store.baseName() + '_OPTIMIZADO.sql', r.opt.src)">Descargar .sql</button>
        <button (click)="store.useOptimizedAsInput()">Usar como entrada y re-analizar</button>
      </div>
    } @else {
      <div class="scroll"><div class="empty">Aún no hay resultado para comparar.</div></div>
    }
  `
})
export class DiffViewerComponent {
  readonly store = inject(OptimizerStore);
  readonly clip = inject(ClipboardService);
  readonly mode = signal<Mode>('side');
  readonly fold = signal(true);
  private readonly opened = signal<Set<string>>(new Set());
  private static readonly CTX = 3;

  readonly diff = computed(() => {
    const r = this.store.proc();
    return r ? diffLines(r.src, r.opt.src) : { A: [], B: [], blocks: [], removed: 0, added: 0, changedBlocks: 0 };
  });
  readonly resultHtml = computed(() => highlightSql(this.store.proc()?.opt.src ?? ''));

  readonly rows = computed<Row[]>(() => {
    const { A, B, blocks } = this.diff();
    const side = this.mode() === 'side', fold = this.fold(), opened = this.opened();
    const rows: Row[] = [];
    const eq = (a: number, b: number): Row => ({ kind: 'eq', aNo: a + 1, bNo: b + 1, aHtml: highlightSql(A[a]) || ' ', bHtml: highlightSql(B[b]) || ' ' });
    let fid = 0;
    blocks.forEach((bl, bi) => {
      if (bl.t === 'eq') {
        const r = bl.rows, head = bi === 0 ? 0 : DiffViewerComponent.CTX, tail = bi === blocks.length - 1 ? 0 : DiffViewerComponent.CTX;
        const id = 'f' + fid++;
        if (fold && r.length > head + tail + 1 && !opened.has(id)) {
          r.slice(0, head).forEach(o => rows.push(eq(o.a!, o.b!)));
          rows.push({ kind: 'fold', foldId: id, hidden: r.length - head - tail });
          r.slice(r.length - tail).forEach(o => rows.push(eq(o.a!, o.b!)));
        } else r.forEach(o => rows.push(eq(o.a!, o.b!)));
        return;
      }
      const pairs = Math.min(bl.del.length, bl.add.length);
      const wd = Array.from({ length: pairs }, (_, i) => wordDiff(A[bl.del[i]], B[bl.add[i]]));
      if (side) {
        for (let i = 0; i < Math.max(bl.del.length, bl.add.length); i++) {
          const a = bl.del[i], b = bl.add[i];
          rows.push({
            kind: 'ch', hasA: a !== undefined, hasB: b !== undefined,
            aNo: a !== undefined ? a + 1 : undefined, bNo: b !== undefined ? b + 1 : undefined,
            aHtml: a !== undefined ? (i < pairs ? wd[i][0] : escapeHtml(A[a])) || ' ' : '',
            bHtml: b !== undefined ? (i < pairs ? wd[i][1] : escapeHtml(B[b])) || ' ' : ''
          });
        }
      } else {
        bl.del.forEach((a, i) => rows.push({ kind: 'del', aNo: a + 1, aHtml: (i < pairs ? wd[i][0] : escapeHtml(A[a])) || ' ' }));
        bl.add.forEach((b, i) => rows.push({ kind: 'add', bNo: b + 1, bHtml: (i < pairs ? wd[i][1] : escapeHtml(B[b])) || ' ' }));
      }
    });
    return rows;
  });

  expand(id: string): void { this.opened.update(s => new Set(s).add(id)); }
  toggleFold(): void { this.fold.update(v => !v); this.opened.set(new Set()); }
}
