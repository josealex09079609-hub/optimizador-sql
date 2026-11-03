import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { SwUpdate, VersionEvent, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';
import { OptimizerStore } from './optimizer.store';
import { decodePlanBytes } from '../engine/sql-engine';

/** Evento de instalación de Chromium (Edge / Chrome). No está en los tipos estándar del DOM. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}
interface LaunchParams { files: FileSystemFileHandleLike[] }
interface FileSystemFileHandleLike { getFile(): Promise<File> }

/**
 * Instalación como aplicación de escritorio (PWA):
 * - captura el aviso de instalación del navegador y lo expone en el botón "Instalar";
 * - detecta si ya se ejecuta instalada (ventana propia);
 * - avisa cuando hay una versión nueva publicada y permite actualizar;
 * - abre archivos .sql / .sqlplan con "Abrir con…" (Windows) y los atajos del icono.
 */
@Injectable({ providedIn: 'root' })
export class PwaService {
  private readonly store = inject(OptimizerStore);
  private readonly swUpdate = inject(SwUpdate);
  private deferred: BeforeInstallPromptEvent | null = null;

  /** El navegador ofrece la instalación (Edge / Chrome con HTTPS o localhost). */
  readonly canInstall = signal(false);
  /** Se está ejecutando como aplicación instalada. */
  readonly installed = signal(this.isStandalone());
  /** Hay una versión nueva descargada lista para usar. */
  readonly updateReady = signal(false);
  /** Sin conexión (la app sigue funcionando desde la caché). */
  readonly offline = signal(typeof navigator !== 'undefined' && !navigator.onLine);
  /** Mostrar ayuda de instalación manual cuando el navegador no ofrece el aviso. */
  readonly showHelp = signal(false);
  readonly secure = typeof window !== 'undefined' && window.isSecureContext;
  readonly installLabel = computed(() => this.canInstall() ? '⬇ Instalar en el PC' : '⬇ Cómo instalar');

  constructor() {
    if (typeof window === 'undefined') return;
    const destroy = inject(DestroyRef);

    const onPrompt = (e: Event) => { e.preventDefault(); this.deferred = e as BeforeInstallPromptEvent; this.canInstall.set(true); };
    const onInstalled = () => { this.deferred = null; this.canInstall.set(false); this.installed.set(true); };
    const onOnline = () => this.offline.set(false);
    const onOffline = () => this.offline.set(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const mq = window.matchMedia('(display-mode: standalone)');
    const onMode = () => this.installed.set(this.isStandalone());
    mq.addEventListener?.('change', onMode);
    destroy.onDestroy(() => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      mq.removeEventListener?.('change', onMode);
    });

    // Actualizaciones publicadas (solo en producción con service worker activo)
    if (this.swUpdate.isEnabled) {
      const sub = this.swUpdate.versionUpdates
        .pipe(filter((e: VersionEvent): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(() => this.updateReady.set(true));
      destroy.onDestroy(() => sub.unsubscribe());
      // Revisar si hay versión nueva cada 6 horas mientras la app está abierta
      const t = setInterval(() => this.swUpdate.checkForUpdate().catch(() => undefined), 6 * 60 * 60 * 1000);
      destroy.onDestroy(() => clearInterval(t));
    }

    this.handleShortcut();
    this.handleFileLaunch();
  }

  /** Botón "Instalar": muestra el diálogo nativo del navegador o la ayuda manual. */
  async install(): Promise<void> {
    if (!this.deferred) { this.showHelp.set(true); return; }
    await this.deferred.prompt();
    const choice = await this.deferred.userChoice;
    this.deferred = null;
    this.canInstall.set(false);
    if (choice.outcome === 'accepted') this.installed.set(true);
  }

  async applyUpdate(): Promise<void> {
    try { await this.swUpdate.activateUpdate(); } finally { document.location.reload(); }
  }

  private isStandalone(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
  }

  /** Atajos del icono instalado: ./?modo=proc | ./?modo=plan */
  private handleShortcut(): void {
    const modo = new URLSearchParams(location.search).get('modo');
    if (modo === 'plan' || modo === 'proc') this.store.mode.set(modo);
  }

  /** "Abrir con → Optimizador SQL" sobre un .sql o .sqlplan (File Handling API, Edge/Chrome instalados). */
  private handleFileLaunch(): void {
    const lq = (window as Window & { launchQueue?: { setConsumer(cb: (p: LaunchParams) => void): void } }).launchQueue;
    if (!lq) return;
    lq.setConsumer(async params => {
      const handle = params.files?.[0];
      if (!handle) return;
      const file = await handle.getFile();
      if (/\.(sqlplan|xml)$/i.test(file.name)) {
        this.store.mode.set('plan');
        this.store.setPlan(decodePlanBytes(new Uint8Array(await file.arrayBuffer())));
      } else {
        this.store.mode.set('proc');
        this.store.source.set(await file.text());
        this.store.runProc();
      }
    });
  }
}
