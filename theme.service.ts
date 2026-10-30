import { Injectable, effect, signal } from '@angular/core';

export type Theme = 'light' | 'dark';
const KEY = 'sqlopt-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(this.read());

  constructor() {
    effect(() => {
      const t = this.theme();
      document.documentElement.setAttribute('data-theme', t);
      try { localStorage.setItem(KEY, t); } catch { /* modo privado */ }
    });
  }

  toggle(): void { this.theme.update(t => (t === 'light' ? 'dark' : 'light')); }

  private read(): Theme {
    try { return (localStorage.getItem(KEY) as Theme) || 'light'; } catch { return 'light'; }
  }
}
