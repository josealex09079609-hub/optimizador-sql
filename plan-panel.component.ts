import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { OptimizerStore } from '../../core/services/optimizer.store';
import { OptimizeOptions } from '../../core/engine/models';
import { decodePlanBytes } from '../../core/engine/sql-engine';
import { SAMPLE_PLAN } from '../../shared/sample';

/** Módulo Plan de ejecución · panel izquierdo: carga del .sqlplan, opciones y acciones. */
@Component({
  selector: 'app-plan-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card', '[class.drop]': 'dragging()', '(dragover)': 'onDragOver($event)', '(dragleave)': 'dragging.set(false)', '(drop)': 'onDrop($event)' },
  template: `
    <div class="hint">
      Sube o arrastra el <b>.sqlplan</b> guardado desde SSMS (de preferencia el <b>plan real</b>: Ctrl+M, ejecutar y
      "Guardar plan de ejecución como…") o pega su XML.
    </div>

    @if (store.planParsed(); as p) {
      @if (p.ok) {
        <div class="pstatus ok">
          ✔ Plan <b>{{ p.isActual ? 'real' : 'estimado' }}</b>{{ p.build ? ' · SQL Server ' + p.build : '' }} · {{ p.statements.length }} sentencia(s) ·
          @if (p.focus?.spills) { <b class="txt-del">⚠ {{ p.focus?.spills }} spill(s)</b> } @else { 0 spills },
          {{ p.focus?.converts }} conversión(es) con alerta, {{ p.focus?.tableScans }} Table Scan,
          {{ p.focus?.memory }} memoria elevada, {{ p.focus?.residual }} lectura residual elevada.
          @if (!p.isActual) { <span class="warn">Plan estimado: sin spills ni memoria usada; sube el plan real para ese análisis.</span> }
        </div>
      } @else {
        <div class="pstatus err">⚠ {{ p.error }}</div>
      }
    } @else {
      <div class="pstatus none">Sin plan cargado.</div>
    }

    <textarea class="plan-xml" spellcheck="false" [value]="store.planXml()" (input)="onPaste($event)"
      placeholder='<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" …>'></textarea>

    <div class="opts">
      @for (o of store.planOptions; track o.key) {
        <label [title]="o.hint"><input type="checkbox" [checked]="store.options()[o.key]" (change)="setOpt(o.key, $event)"> {{ o.label }}</label>
      }
    </div>

    <div class="bar">
      <button class="primary" (click)="store.runPlan()">⚡ Analizar plan</button>
      <button (click)="file.click()">Subir .sqlplan</button>
      <button (click)="store.setPlan(sample)">Cargar ejemplo</button>
      <button (click)="store.clearPlan()">Limpiar</button>
      <input #file type="file" accept=".sqlplan,.xml" hidden (change)="onFile($event)">
    </div>
  `
})
export class PlanPanelComponent {
  readonly store = inject(OptimizerStore);
  readonly dragging = signal(false);
  readonly sample = SAMPLE_PLAN;
  private pasteTimer: ReturnType<typeof setTimeout> | null = null;

  setOpt(key: keyof OptimizeOptions, ev: Event): void { this.store.setOption(key, (ev.target as HTMLInputElement).checked); }

  onPaste(e: Event): void {
    const v = (e.target as HTMLTextAreaElement).value;
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => this.store.setPlan(v), 400);
  }

  async onFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) await this.load(f);
    input.value = '';
  }

  onDragOver(e: DragEvent): void { e.preventDefault(); this.dragging.set(true); }
  async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault(); this.dragging.set(false);
    const f = e.dataTransfer?.files[0];
    if (f) await this.load(f);
  }

  /** SSMS guarda los .sqlplan normalmente en UTF-16: se decodifica según el BOM. */
  private async load(f: File): Promise<void> {
    this.store.setPlan(decodePlanBytes(new Uint8Array(await f.arrayBuffer())));
  }
}
