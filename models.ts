export type Severity = 'Alta' | 'Media' | 'Baja' | 'Info';

export interface SqlSpan { start: number; end: number; text: string; type?: 'line' | 'block'; }

export interface Finding {
  id: string;
  /** Identificador único (código: igual a id; plan: id + sentencia/operador). */
  key?: string;
  source?: 'code' | 'plan';
  sev: Severity;
  cat: string;
  title: string;
  detail: string;
  rec: string;
  lines: number[];
  ref: string;
  autofix: boolean;
  stmt?: number;
  /** Script sugerido (p. ej. índice faltante del plan). */
  script?: string;
  /** Mejora propuesta para hallazgos del plan: explicación + script/fragmento SQL. */
  proposal?: { text: string; sql?: string };
  /** Hallazgo de la revisión principal del plan (spill, conversión con alerta, Table Scan, memoria elevada, lectura residual). */
  main?: boolean;
  node?: number;
}

export interface ProcParam { name: string; type: string; def: string | null; out: boolean; }

export interface ProcInfo {
  kind: string;
  fullName: string;
  name: string;
  schema: string | null;
  params: ProcParam[];
  index: number;
  asIndex: number;
}

export interface AnalysisResult {
  findings: Finding[];
  proc: ProcInfo | null;
  score: number;
  stats: { lines: number; tables: string[]; temps: string[] };
}

export interface AppliedChange { key: string; label: string; count?: number; motivo: string; seguro: string; }

export interface OptimizeResult { src: string; applied: AppliedChange[]; planFixed: string[]; }

export interface PlanStatement {
  n: number;
  type: string;
  text: string;
  fullText: string;
  line: number;
  at: number;
  cost: number | null;
  estRows: number | null;
  grantedKB: number | null;
  usedKB: number | null;
  desiredKB: number | null;
  waitMs: number | null;
  elapsedMs: number | null;
  cpuMs: number | null;
  dop: number | null;
  spills: number;
  converts: number;
  warnings: number;
  timeout: boolean;
  /** Parámetros del plan (tipo, valor compilado y de ejecución). */
  params: { name: string; type: string; compiled?: string; runtime?: string }[];
}

export interface PlanAnalysis {
  ok: boolean;
  error: string;
  build: string;
  isActual: boolean;
  statements: PlanStatement[];
  findings: Finding[];
  missingIndexes: { table: string; impact: number | null; script: string; stmt: number }[];
  fixes: { converts: any[]; convertsAll: any[]; sorts: any[]; excessiveGrant: boolean };
  /** Conteo de la revisión principal. */
  focus?: { spills: number; converts: number; tableScans: number; memory: number; residual: number };
}

export interface OptimizeOptions {
  addNolock?: boolean;
  countOne?: boolean;
  existsOne?: boolean;
  collateTemp?: boolean;
  dropIfExists?: boolean;
  singleIn?: boolean;
  throwSemicolon?: boolean;
  closeTran?: boolean;
  selectInto?: boolean;
  innerJoin?: boolean;
  trim?: boolean;
  stringAgg?: boolean;
  sarg?: boolean;
  nolockTemp?: boolean;
  trailingComma?: boolean;
  removeComments?: boolean;
  schema?: boolean;
  upper?: boolean;
  nocount?: boolean;
  reviewNotes?: boolean;
  planConvert?: boolean;
  planSort?: boolean;
  planMaxGrant?: boolean;
  /** En el módulo Plan: aplicar también las reglas de código a las sentencias. */
  planCode?: boolean;
}

export interface OptionDef { key: keyof OptimizeOptions; label: string; hint: string; default: boolean; group?: 'plan'; }

export interface ImprovedStatement { n: number; type: string; line: number; before: string; after: string; applied: string[]; fixed: string[]; }
export interface ImprovedPlan { statements: ImprovedStatement[]; fixed: string[]; }
