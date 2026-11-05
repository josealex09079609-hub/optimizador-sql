/**
 * v1.8.1 · Opciones del optimizador con la casilla "Reescribir filtros no SARGables".
 * Reexporta OPTIMIZE_OPTIONS de options.ts agregando la opción (si no existe) después de LEFT → LIKE.
 */
import { OptionDef } from './models';
import { OPTIMIZE_OPTIONS as BASE } from './options';

declare module './models' {
  interface OptimizeOptions {
    /** Reescribir filtros no SARGables (SUBSTRING → LIKE, fechas → rangos DATEADD/DATEDIFF). */
    sargPlus?: boolean;
  }
}

const SARG_PLUS: OptionDef = {
  key: 'sargPlus',
  label: 'Reescribir filtros no SARGables (SUBSTRING → LIKE, fechas → rangos DATEADD/DATEDIFF)',
  hint: "Solo equivalentes: SUBSTRING/LEFT con texto (=, IN, rangos), CONVERT/CAST a DATE, YEAR/MONTH, DATEDIFF y DATEADD sobre columnas de fecha (prefijo d). No cambia comparaciones con variables u otras columnas.",
  default: true
};

function withSargPlus(list: OptionDef[]): OptionDef[] {
  if (list.some(o => o.key === 'sargPlus')) return list;
  const i = list.findIndex(o => o.key === 'sarg');
  const out = [...list];
  out.splice(i >= 0 ? i + 1 : out.findIndex(o => o.group === 'plan') >= 0 ? out.findIndex(o => o.group === 'plan') : out.length, 0, SARG_PLUS);
  return out;
}

export const OPTIMIZE_OPTIONS: OptionDef[] = withSargPlus(BASE);
