import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { OptimizerStore, ProcTab } from '../../core/services/optimizer.store';
import { ProcEditorComponent } from './proc-editor.component';
import { FindingsComponent } from './findings.component';
import { DiffViewerComponent } from './diff-viewer.component';
import { CodePanelComponent } from '../code-panel/code-panel.component';

/** Módulo Procedimiento: entrada a la izquierda y subpestañas de resultados a la derecha. */
@Component({
  selector: 'app-proc-page',
  standalone: true,
  imports: [ProcEditorComponent, FindingsComponent, DiffViewerComponent, CodePanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-proc-editor />
    <section class="card">
      <nav class="tabs">
        @for (t of tabs; track t.id) {
          <div class="tab" [class.on]="store.procTab() === t.id" (click)="store.procTab.set(t.id)">
            {{ t.label }}
            @if (t.id === 'findings') { <span class="badge">{{ store.proc()?.analysis?.findings?.length ?? 0 }}</span> }
          </div>
        }
      </nav>
      <div class="view">
        @switch (store.procTab()) {
          @case ('findings') { <app-findings /> }
          @case ('optimized') { <app-diff-viewer /> }
          @case ('dictionary') {
            <app-code-panel [code]="store.dictionary()" [fileName]="store.baseName() + '_DICCIONARIO.sql'" />
          }
          @case ('metadata') {
            <app-code-panel [code]="store.metadata()"
              note="Si faltan tipos o dependencias (TODO en temporales, funciones, otros PAs), ejecuta estos scripts y usa el resultado para definir tipos exactos (SKILL §0.1)." />
          }
          @case ('report') {
            <app-code-panel [code]="store.report()" [plain]="true" copyLabel="Copiar (para correo a DBA)"
              [fileName]="store.baseName() + '_REVISION.md'" />
          }
        }
      </div>
    </section>
  `
})
export class ProcPageComponent {
  readonly store = inject(OptimizerStore);
  readonly tabs: { id: ProcTab; label: string }[] = [
    { id: 'findings', label: 'Hallazgos' },
    { id: 'optimized', label: 'SQL optimizado' },
    { id: 'dictionary', label: 'Diccionario' },
    { id: 'metadata', label: 'Metadatos' },
    { id: 'report', label: 'Reporte' }
  ];
}
