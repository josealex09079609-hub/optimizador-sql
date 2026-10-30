import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { EditorComponent } from './features/editor/editor.component';
import { FindingsComponent } from './features/findings/findings.component';
import { DiffViewerComponent } from './features/diff-viewer/diff-viewer.component';
import { CodePanelComponent } from './features/code-panel/code-panel.component';
import { OptimizerStore } from './core/services/optimizer.store';
import { ThemeService } from './core/services/theme.service';
import { ClipboardService } from './core/services/clipboard.service';

type Tab = 'findings' | 'optimized' | 'dictionary' | 'metadata' | 'report';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [EditorComponent, FindingsComponent, DiffViewerComponent, CodePanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.component.html'
})
export class AppComponent {
  readonly store = inject(OptimizerStore);
  readonly theme = inject(ThemeService);
  readonly clip = inject(ClipboardService);
  readonly tab = signal<Tab>('findings');
  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'findings', label: 'Hallazgos' },
    { id: 'optimized', label: 'SQL optimizado' },
    { id: 'dictionary', label: 'Diccionario' },
    { id: 'metadata', label: 'Metadatos' },
    { id: 'report', label: 'Reporte' }
  ];
}
