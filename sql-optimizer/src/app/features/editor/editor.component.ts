import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OptimizerStore } from '../../core/services/optimizer.store';
import { OPTIMIZE_OPTIONS } from '../../core/engine/options';
import { OptimizeOptions } from '../../core/engine/models';
import { SAMPLE_SQL } from '../../shared/sample';

@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <h2>
        Procedimiento / consulta original
        <span class="muted small">Pega el script o arrastra un archivo .sql · Ctrl+Enter para analizar</span>
      </h2>
      <textarea #area spellcheck="false" class="code-input" [class.drop]="dragging()"
        [ngModel]="store.source()" (ngModelChange)="store.source.set($event)"
        (keydown)="onKey($event)" (dragover)="onDragOver($event)" (dragleave)="dragging.set(false)" (drop)="onDrop($event)"
        placeholder="CREATE PROCEDURE Esquema.PA_Tabla_Sel_Finalidad&#10;    @cParametro VARCHAR(20)&#10;AS&#10;BEGIN&#10;    ...&#10;END"></textarea>

      <div class="opts">
        @for (o of optionDefs; track o.key) {
          <label [title]="o.hint">
            <input type="checkbox" [checked]="store.options()[o.key]" (change)="setOpt(o.key, $event)"> {{ o.label }}
          </label>
        }
      </div>

      <div class="bar">
        <button class="primary" (click)="store.run()">⚡ Analizar y optimizar</button>
        <button (click)="loadSample()">Cargar ejemplo</button>
        <button (click)="file.click()">Abrir .sql</button>
        <button (click)="store.clear()">Limpiar</button>
        <input #file type="file" accept=".sql,.txt" hidden (change)="onFile($event)">
      </div>
    </section>
  `
})
export class EditorComponent {
  readonly store = inject(OptimizerStore);
  readonly optionDefs = OPTIMIZE_OPTIONS;
  readonly dragging = signal(false);
  private readonly area = viewChild.required<ElementRef<HTMLTextAreaElement>>('area');

  constructor() {
    // Ubica y selecciona la línea indicada desde un hallazgo
    effect(() => {
      const g = this.store.gotoLine();
      if (!g) return;
      const ta = this.area().nativeElement, lines = ta.value.split('\n');
      let pos = 0;
      for (let k = 0; k < g.line - 1; k++) pos += lines[k].length + 1;
      ta.focus();
      ta.setSelectionRange(pos, pos + (lines[g.line - 1]?.length ?? 0));
      ta.scrollTop = Math.max(0, (g.line - 5) * 19.4);
    });
  }

  setOpt(key: keyof OptimizeOptions, ev: Event): void {
    this.store.setOption(key, (ev.target as HTMLInputElement).checked);
  }

  loadSample(): void { this.store.source.set(SAMPLE_SQL); this.store.run(); }

  onKey(e: KeyboardEvent): void {
    const ta = e.target as HTMLTextAreaElement;
    if (e.key === 'Tab') {
      e.preventDefault();
      ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
      this.store.source.set(ta.value);
    }
    if (e.ctrlKey && e.key === 'Enter') this.store.run();
  }

  onDragOver(e: DragEvent): void { e.preventDefault(); this.dragging.set(true); }

  async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault(); this.dragging.set(false);
    const f = e.dataTransfer?.files[0];
    if (f) this.load(await f.text());
  }

  async onFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) this.load(await f.text());
    input.value = '';
  }

  private load(text: string): void { this.store.source.set(text); this.store.run(); }
}
