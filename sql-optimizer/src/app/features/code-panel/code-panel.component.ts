import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ClipboardService } from '../../core/services/clipboard.service';
import { highlightSql } from '../../core/engine/highlight';

/** Visor de código de solo lectura con copiar/descargar (Diccionario, Metadatos, Reporte). */
@Component({
  selector: 'app-code-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (note()) { <div class="applied muted">{{ note() }}</div> }
    @if (code()) {
      @if (plain()) { <pre class="code wrap">{{ code() }}</pre> }
      @else { <pre class="code" [innerHTML]="html()"></pre> }
      <div class="bar">
        <button (click)="clip.copy(code())">{{ copyLabel() }}</button>
        @if (fileName()) { <button (click)="clip.download(fileName()!, code())">Descargar</button> }
      </div>
    } @else {
      <div class="scroll"><div class="empty">Analiza un procedimiento para ver este contenido.</div></div>
    }
  `
})
export class CodePanelComponent {
  readonly clip = inject(ClipboardService);
  readonly code = input.required<string>();
  readonly fileName = input<string | null>(null);
  readonly note = input<string | null>(null);
  readonly plain = input(false);
  readonly copyLabel = input('Copiar');
  readonly html = computed(() => highlightSql(this.code()));
}
