import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ClipboardService {
  readonly toast = signal<string | null>(null);

  async copy(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    this.notify('Copiado');
  }

  download(fileName: string, text: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private notify(msg: string): void {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(null), 1400);
  }
}
