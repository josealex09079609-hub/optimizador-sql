import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ProcPageComponent } from './features/proc/proc-page.component';
import { PlanPageComponent } from './features/plan/plan-page.component';
import { OptimizerStore } from './core/services/optimizer.store';
import { ThemeService } from './core/services/theme.service';
import { ClipboardService } from './core/services/clipboard.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ProcPageComponent, PlanPageComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.component.html'
})
export class AppComponent {
  readonly store = inject(OptimizerStore);
  readonly theme = inject(ThemeService);
  readonly clip = inject(ClipboardService);

  readonly planBadge = computed(() => {
    const r = this.store.planResult();
    if (!r) return this.store.planParsed() && !this.store.planParsed()!.ok ? 'error' : 'sin plan';
    const sp = r.plan.focus?.spills ?? 0;
    return sp ? `⚠ ${sp} spill` : r.plan.findings.filter(f => f.main).length + ' alertas';
  });
  readonly planBad = computed(() => !!this.store.planResult()?.plan.focus?.spills);
}
