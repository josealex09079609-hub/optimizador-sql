import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PwaService } from '../core/services/pwa.service';

/** Botón "Instalar" (cabecera), aviso de actualización, estado sin conexión y ayuda de instalación manual. */
@Component({
  selector: 'app-pwa-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pwa-host' },
  template: `
    @if (pwa.offline()) { <span class="pwa-chip off" title="La aplicación funciona sin conexión">● Sin conexión</span> }
    @if (pwa.installed()) {
      <span class="pwa-chip ok" title="Se está ejecutando como aplicación instalada">✔ Instalada</span>
    } @else {
      <button class="pwa-install" (click)="pwa.install()" [title]="pwa.canInstall() ? 'Instalar como aplicación de escritorio' : 'Ver cómo instalar'">
        {{ pwa.installLabel() }}
      </button>
    }

    @if (pwa.updateReady()) {
      <div class="pwa-toast">
        <span>🔄 Hay una nueva versión del optimizador.</span>
        <button class="primary" (click)="pwa.applyUpdate()">Actualizar ahora</button>
        <button (click)="pwa.updateReady.set(false)">Después</button>
      </div>
    }

    @if (pwa.showHelp()) {
      <div class="pwa-modal" (click)="pwa.showHelp.set(false)">
        <div class="pwa-dialog" (click)="$event.stopPropagation()">
          <h3>Instalar el optimizador en tu PC</h3>
          @if (!pwa.secure) {
            <p class="warn">⚠ La página no se abrió con <b>HTTPS</b>: el navegador solo permite instalar aplicaciones desde
              HTTPS o desde <b>localhost</b>. Pide a Infraestructura publicarla con certificado.</p>
          }
          <ol>
            <li><b>Microsoft Edge:</b> menú <b>…</b> → <b>Aplicaciones</b> → <b>Instalar este sitio como una aplicación</b>
              (o el icono ⊕ al final de la barra de direcciones).</li>
            <li><b>Google Chrome:</b> icono de instalar (monitor con flecha) en la barra de direcciones, o menú <b>⋮</b> →
              <b>Transmitir, guardar y compartir</b> → <b>Instalar página como aplicación</b>.</li>
            <li>Se crea un acceso directo en el menú Inicio / escritorio y se abre en su propia ventana.</li>
          </ol>
          <p class="muted">Una vez instalada funciona sin conexión (el análisis es 100 % local), se actualiza sola cuando se
            publica una nueva versión y en Windows puedes usar <b>Abrir con → Optimizador SQL</b> sobre archivos .sql y .sqlplan.
            Para desinstalar: en la ventana de la app, menú <b>…</b> → <b>Desinstalar</b>.</p>
          <div class="pwa-actions"><button class="primary" (click)="pwa.showHelp.set(false)">Entendido</button></div>
        </div>
      </div>
    }
  `
})
export class PwaBarComponent {
  readonly pwa = inject(PwaService);
}
