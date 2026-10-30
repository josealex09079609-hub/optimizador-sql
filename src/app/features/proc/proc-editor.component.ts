import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OptimizerStore } from '../../core/services/optimizer.store';
import { OptimizeOptions } from '../../core/engine/models';
import { decodePlanBytes } from '../../core/engine/sql-engine';
import { SAMPLE_SQL } from '../../shared/sample';

/** Módulo Procedimiento · panel izquierdo: código, opciones y acciones. */
@Component({
  selector: 'app-proc-editor',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <div class="hint">Pega el procedimiento o arrastra un archivo .sql · Ctrl+Enter para analizar</div>
      <textarea #area spellcheck="false" class="code-input" [class.drop]="dragging()"
        [ngModel]="store.source()" (ngModelChange)="store.source.set($event)"
        (keydown)="onKey($event)" (dragover)="onDragOver($event)" (dragleave)="dragging.set(false)" (drop)="onDrop($event)"
        placeholder="CREATE PROCEDURE Esquema.PA_Tabla_Sel_Finalidad&#10;    @cParametro VARCHAR(20)&#10;AS&#10;BEGIN&#10;    ...&#10;END"></textarea>

      <div class="opts">
        @for (o of store.codeOptions; track o.key) {
          <label [title]="o.hint"><input type="checkbox" [checked]="store.options()[o.key]" (change)="setOpt(o.key, $event)"> {{ o.label }}</label>
        }
      </div>

      <div class="bar">
        <button class="primary" (click)="store.runProc()">⚡ Analizar procedimiento</button>
        <button (click)="loadSample()">Cargar ejemplo</button>
        <button (click)="file.click()">Abrir .sql</button>
        <button (click)="store.clearProc()">Limpiar</button>
        <input #file type="file" accept=".sql,.txt" hidden (change)="onFile($event)">
      </div>
    </section>
  `
})
export class ProcEditorComponent {
  readonly store = inject(OptimizerStore);
  readonly dragging = signal(false);
  private readonly area = viewChild.required<ElementRef<HTMLTextAreaElement>>('area');

  constructor() {
    // Ubica y selecciona la línea indicada desde un hallazgo
    effect(() => {
      const g = this.store.gotoLine();
      if (!g) return;
      setTimeout(() => {
        const ta = this.area().nativeElement, lines = ta.value.split('\n');
        if (g.line < 1 || g.line > lines.length) return;
        let pos = 0;
        for (let k = 0; k < g.line - 1; k++) pos += lines[k].length + 1;
        ta.focus();
        ta.setSelectionRange(pos, pos + lines[g.line - 1].length);
        ta.scrollTop = Math.max(0, (g.line - 5) * 19.4);
      });
    });
  }

  setOpt(key: keyof OptimizeOptions, ev: Event): void { this.store.setOption(key, (ev.target as HTMLInputElement).checked); }
  loadSample(): void { this.store.source.set(SAMPLE_SQL); this.store.runProc(); }

  onKey(e: KeyboardEvent): void {
    const ta = e.target as HTMLTextAreaElement;
    if (e.key === 'Tab') {
      e.preventDefault();
      ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
      this.store.source.set(ta.value);
    }
    if (e.ctrlKey && e.key === 'Enter') this.store.runProc();
  }

  onDragOver(e: DragEvent): void { e.preventDefault(); this.dragging.set(true); }

  async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault(); this.dragging.set(false);
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    if (/\.(sqlplan|xml)$/i.test(f.name)) {           // un plan arrastrado aquí va a su módulo
      this.store.mode.set('plan');
      this.store.setPlan(decodePlanBytes(new Uint8Array(await f.arrayBuffer())));
    } else this.load(await f.text());
  }

  async onFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) this.load(await f.text());
    input.value = '';
  }

  private load(text: string): void { this.store.source.set(text); this.store.runProc(); }
}
