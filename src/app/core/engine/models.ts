export type Severity = 'Alta' | 'Media' | 'Baja' | 'Info';

export interface SqlSpan { start: number; end: number; text: string; type?: 'line' | 'block'; }

export interface Finding {
  id: string;
  sev: Severity;
  cat: string;
  title: string;
  detail: string;
  rec: string;
  lines: number[];
  ref: string;
  autofix: boolean;
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

export interface OptimizeResult { src: string; applied: AppliedChange[]; }

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
}

export interface OptionDef { key: keyof OptimizeOptions; label: string; hint: string; default: boolean; }
