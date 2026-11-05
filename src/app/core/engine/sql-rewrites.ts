/**
 * v1.8 · Reescrituras SARGables y detección de DML sobre tablas temporales.
 *
 * Regla de oro: solo se reescribe cuando el resultado es EXACTAMENTE el mismo. La función se quita de la columna
 * y se aplica al valor, para que el motor pueda usar Index Seek:
 *   - SUBSTRING(col, 1, n) / LEFT(col, n) = 'xxx'          → col LIKE 'xxx%'
 *   - SUBSTRING(col, 1, n) BETWEEN '…' AND '…' (dígitos)    → col >= '…' AND col < '…+1'
 *   - CONVERT(DATE, dCol) / CAST(dCol AS DATE) = X           → dCol >= X AND dCol < DATEADD(DAY, 1, X)
 *   - CONVERT(VARCHAR(8), dCol, 112) = 'yyyymmdd'            → dCol >= 'yyyymmdd' AND dCol < 'día siguiente'
 *   - YEAR(dCol) = 2026 | @nAnio | YEAR(GETDATE())           → rango con DATEADD(YEAR, …, 0)
 *   - YEAR(dCol) = Y AND MONTH(dCol) = M                     → rango con DATEADD(MONTH, …, 0)
 *   - DATEDIFF(DAY|MONTH|YEAR, dCol, X) op N                 → rango con DATEADD/DATEDIFF sobre X
 *   - DATEADD(DAY|HOUR|MINUTE|SECOND|WEEK, n, dCol) op X     → dCol op DATEADD(…, -n, X)
 * Las reescrituras de fechas solo se aplican a columnas con prefijo de fecha (dFecha…, nomenclatura del área).
 * Este módulo no depende de Angular ni de sql-engine.ts.
 */

export interface SargChange { rule: string; before: string; after: string; line: number; }
export interface SargResult { src: string; count: number; changes: SargChange[]; }
interface Edit { start: number; end: number; text: string; rule: string; }
interface Span { start: number; end: number; }
interface ColRef { text: string; col: string; }

// ---------------------------------------------------------------- utilidades

/** Enmascara comentarios y contenido de literales (misma longitud) para analizar sin falsos positivos. */
export function maskSql(src: string): string {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '-' && d === '-') {
      let j = src.indexOf('\n', i); if (j < 0) j = n;
      out += ' '.repeat(j - i); i = j;
    } else if (c === '/' && d === '*') {
      let depth = 1, j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
        else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      out += src.slice(i, j).replace(/[^\n]/g, ' '); i = j;
    } else if (c === "'") {
      let j = i + 1, closed = false;
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; closed = true; break; }
        j++;
      }
      out += closed ? "'" + src.slice(i + 1, j - 1).replace(/[^\n]/g, ' ') + "'" : "'" + src.slice(i + 1, j).replace(/[^\n]/g, ' ');
      i = j;
    } else { out += c; i++; }
  }
  return out;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function allMatches(re: RegExp, s: string): RegExpExecArray[] {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const res: RegExpExecArray[] = []; let m: RegExpExecArray | null;
  while ((m = r.exec(s)) !== null) { res.push(m); if (m.index === r.lastIndex) r.lastIndex++; }
  return res;
}

const lineOf = (s: string, idx: number) => s.slice(0, idx).split('\n').length;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Divide argumentos de primer nivel (devuelve posiciones absolutas). */
function splitArgs(masked: string, open: number, close: number): Span[] {
  const res: Span[] = []; let depth = 0, st = open + 1;
  for (let i = open + 1; i < close; i++) {
    const ch = masked[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { res.push(trimSpan(masked, st, i)); st = i + 1; }
  }
  res.push(trimSpan(masked, st, close));
  return res;
}
function trimSpan(s: string, a: number, b: number): Span {
  while (a < b && /\s/.test(s[a])) a++;
  while (b > a && /\s/.test(s[b - 1])) b--;
  return { start: a, end: b };
}

/** Columna simple: col | alias.col | [alias].[col] */
function colRef(text: string): ColRef | null {
  const m = /^(?:\[?[A-Za-z_]\w*\]?\s*\.\s*)?\[?([A-Za-z_]\w*)\]?$/.exec(text.trim());
  return m ? { text: text.trim(), col: m[1] } : null;
}
/** Nomenclatura del área: las columnas de fecha empiezan con "d" (dFecha, dFecRegistro…). */
const isDateCol = (c: ColRef) => /^d[A-Z]/.test(c.col);

const STOP_KW = /^(AND|OR|WHERE|GROUP|ORDER|HAVING|UNION|EXCEPT|INTERSECT|INNER|CROSS|FULL|OUTER|JOIN|ON|THEN|WHEN|ELSE|END|BEGIN|SELECT|FROM|INSERT|UPDATE|DELETE|MERGE|SET|IF|WHILE|RETURN|OPTION|COLLATE|ESCAPE|DECLARE|EXEC|EXECUTE|PRINT|COMMIT|ROLLBACK|FOR)$/i;

/** Lee el operando que sigue a un operador de comparación (hasta AND/OR/coma/paréntesis de cierre…). */
function readOperand(masked: string, pos: number): Span | null {
  let i = pos;
  while (i < masked.length && /\s/.test(masked[i])) i++;
  const start = i; let depth = 0;
  while (i < masked.length) {
    const ch = masked[i];
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { if (depth === 0) break; depth--; i++; continue; }
    if (depth === 0) {
      if (ch === ',' || ch === ';') break;
      if (/[A-Za-z_]/.test(ch) && !/[\w@#$.]/.test(masked[i - 1] || ' ')) {
        const w = /^[A-Za-z_]\w*/.exec(masked.slice(i))![0];
        if (STOP_KW.test(w)) break;
        if (/^(LEFT|RIGHT)$/i.test(w) && /^\s+(OUTER\s+)?JOIN\b/i.test(masked.slice(i + w.length))) break;
        i += w.length; continue;
      }
    }
    i++;
  }
  let end = i;
  while (end > start && /\s/.test(masked[end - 1])) end--;
  return end > start ? { start, end } : null;
}

/** El operando es aceptable para mover la función a su lado (sin subconsultas ni funciones no deterministas). */
function safeOperand(maskedText: string, col: ColRef): boolean {
  if (/\(\s*SELECT\b|\bCASE\b|\bNEWID\s*\(|\bRAND\s*\(/i.test(maskedText)) return false;
  return !new RegExp('(^|[^\\w@#])' + escRe(col.col) + '\\b', 'i').test(maskedText);
}

/** La función está en un predicado (WHERE / ON / AND / OR / HAVING / NOT) y es el lado izquierdo de la comparación. */
function inPredicate(masked: string, idx: number): boolean {
  const before = masked.slice(Math.max(0, idx - 2000), idx);
  const ms = allMatches(/\b(WHERE|ON|AND|OR|HAVING|NOT|SELECT|SET|BY|THEN|ELSE|WHEN|CASE|INTO|FROM|VALUES|RETURN|DECLARE|IF|JOIN|BETWEEN|PRINT)\b/gi, before);
  if (!ms.length) return false;
  const k = ms[ms.length - 1][1].toUpperCase();
  if (!['WHERE', 'ON', 'AND', 'OR', 'HAVING', 'NOT'].includes(k)) return false;
  if (k === 'AND' && ms.length > 1 && ms[ms.length - 2][1].toUpperCase() === 'BETWEEN') return false;
  const t = before.replace(/\s+$/, '');
  const ch = t[t.length - 1];
  return !(ch && /[+\-*/%=<>!,.]/.test(ch));
}

// ---------------------------------------------------------------- fechas

interface YMD { y: number; m: number; d: number; }
function parseDateLit(text: string, compact?: boolean): YMD | null {
  const m = compact === true ? /^N?'(\d{4})(\d{2})(\d{2})'$/i.exec(text)
    : compact === false ? /^N?'(\d{4})-(\d{2})-(\d{2})'$/i.exec(text)
    : /^N?'(\d{4})-?(\d{2})-?(\d{2})'$/i.exec(text);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1753 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}
function addDays(p: YMD, k: number): YMD {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + k));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
const pad = (n: number) => String(n).padStart(2, '0');
const lit = (p: YMD) => `'${p.y}${pad(p.m)}${pad(p.d)}'`;

/** Tipos declarados de parámetros y variables (@x TIPO). */
function declaredTypes(masked: string): Map<string, string> {
  const res = new Map<string, string>();
  for (const m of allMatches(/(@\w+)\s+(?:AS\s+)?(DATE|DATETIME2|DATETIME|SMALLDATETIME|DATETIMEOFFSET|INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|N?VARCHAR|N?CHAR)\b/gi, masked)) {
    const k = m[1].toLowerCase();
    if (!res.has(k)) res.set(k, m[2].toUpperCase());
  }
  return res;
}
const coversAll = (t: string) => { const o = t.indexOf('('); return o >= 0 && matchParen(t, o) === t.length - 1; };

/** Operando de tipo DATE (sin hora): literal 'yyyymmdd', CONVERT(DATE, …), CAST(… AS DATE) o variable DATE. */
function dateOperand(srcText: string, mText: string, decls: Map<string, string>): { start: string; next: string } | null {
  const d = parseDateLit(srcText);
  if (d) return { start: lit(d), next: lit(addDays(d, 1)) };
  const isDate = (/^CONVERT\s*\(\s*DATE\s*,/i.test(mText) && coversAll(mText)) ||
    (/^CAST\s*\(/i.test(mText) && /\bAS\s+DATE\s*\)$/i.test(mText) && coversAll(mText)) ||
    (/^@\w+$/.test(mText) && decls.get(mText.toLowerCase()) === 'DATE');
  return isDate ? { start: srcText, next: `DATEADD(DAY, 1, ${srcText})` } : null;
}

/** Inicio de año (o del siguiente) para YEAR(col): literal, YEAR(expr) o variable entera. */
function yearOperand(srcText: string, mText: string, decls: Map<string, string>): { start: string; next: string } | null {
  if (/^\d{4}$/.test(mText)) {
    const y = +mText;
    if (y < 1753 || y > 9998) return null;
    return { start: `'${y}0101'`, next: `'${y + 1}0101'` };
  }
  if (/^YEAR\s*\(/i.test(mText) && coversAll(mText)) {
    const inner = srcText.slice(srcText.indexOf('(') + 1, -1).trim();
    return { start: `DATEADD(YEAR, DATEDIFF(YEAR, 0, ${inner}), 0)`, next: `DATEADD(YEAR, DATEDIFF(YEAR, 0, ${inner}) + 1, 0)` };
  }
  if (/^@\w+$/.test(mText)) {
    const t = decls.get(mText.toLowerCase());
    if (t && /DATE/.test(t)) return null;
    return { start: `DATEADD(YEAR, ${srcText} - 1900, 0)`, next: `DATEADD(YEAR, ${srcText} - 1899, 0)` };
  }
  return null;
}

/** Arma el rango para la relación "f(col) op X" sabiendo el inicio del periodo de X y el del periodo siguiente. */
function rangeFor(col: string, op: string, start: string, next: string): string | null {
  switch (op) {
    case '=': return `(${col} >= ${start} AND ${col} < ${next})`;
    case '>=': return `${col} >= ${start}`;
    case '>': return `${col} >= ${next}`;
    case '<=': return `${col} < ${next}`;
    case '<': return `${col} < ${start}`;
    default: return null;
  }
}

const UNIT: Record<string, string> = { DAY: 'DAY', DD: 'DAY', D: 'DAY', MONTH: 'MONTH', MM: 'MONTH', M: 'MONTH', YEAR: 'YEAR', YY: 'YEAR', YYYY: 'YEAR' };
const ADD_UNIT = /^(DAY|DD|D|HOUR|HH|MINUTE|MI|N|SECOND|SS|S|WEEK|WK|WW)$/i;
const FLIP: Record<string, string> = { '=': '=', '<=': '>=', '<': '>', '>=': '<=', '>': '<' };

// ---------------------------------------------------------------- reescritura

interface Cmp { op: string; a: Span; b?: Span; end: number; }
/** Operador que sigue al cierre de la función y sus operandos. */
function readComparison(masked: string, close: number): Cmp | null {
  const m = /^\s*(>=|<=|<>|!=|=|>|<|BETWEEN\b)/i.exec(masked.slice(close + 1));
  if (!m) return null;
  const op = m[1].toUpperCase();
  if (op === '<>' || op === '!=') return null;
  const a = readOperand(masked, close + 1 + m[0].length);
  if (!a) return null;
  if (op !== 'BETWEEN') return { op, a, end: a.end };
  const and = /^\s*AND\b/i.exec(masked.slice(a.end));
  if (!and) return null;
  const b = readOperand(masked, a.end + and[0].length);
  return b ? { op, a, b, end: b.end } : null;
}

function digitsInc(s: string): string | null {
  const v = (BigInt(s) + 1n).toString().padStart(s.length, '0');
  return v.length === s.length ? v : null;
}

function collectEdits(src: string, masked: string, decls: Map<string, string>): Edit[] {
  const edits: Edit[] = [];
  const covered: Span[] = [];
  const isCovered = (i: number) => covered.some(c => i >= c.start && i < c.end);
  const S = (s: Span) => src.slice(s.start, s.end);
  const M = (s: Span) => masked.slice(s.start, s.end);
  const push = (start: number, end: number, text: string, rule: string) => { edits.push({ start, end, text, rule }); covered.push({ start, end }); };

  // 1) YEAR(col) = Y AND MONTH(col) = M (en cualquier orden) → rango del mes
  for (const m of allMatches(/\b(YEAR|MONTH)\s*\(/gi, masked)) {
    if (isCovered(m.index) || !inPredicate(masked, m.index)) continue;
    const o1 = m.index + m[0].length - 1, c1 = matchParen(masked, o1);
    if (c1 < 0) continue;
    const col = colRef(masked.slice(o1 + 1, c1));
    if (!col || !isDateCol(col)) continue;
    const cmp1 = readComparison(masked, c1);
    if (!cmp1 || cmp1.op !== '=') continue;
    const nx = new RegExp('^\\s*AND\\s+(' + (m[1].toUpperCase() === 'YEAR' ? 'MONTH' : 'YEAR') + ')\\s*\\(', 'i').exec(masked.slice(cmp1.end));
    if (!nx) continue;
    const o2 = cmp1.end + nx[0].length - 1, c2 = matchParen(masked, o2);
    const col2 = c2 > 0 ? colRef(masked.slice(o2 + 1, c2)) : null;
    if (!col2 || col2.text.toLowerCase().replace(/\s/g, '') !== col.text.toLowerCase().replace(/\s/g, '')) continue;
    const cmp2 = readComparison(masked, c2);
    if (!cmp2 || cmp2.op !== '=') continue;
    const [ySp, mSp] = m[1].toUpperCase() === 'YEAR' ? [cmp1.a, cmp2.a] : [cmp2.a, cmp1.a];
    const yT = M(ySp), mT = M(mSp), ys = S(ySp), msrc = S(mSp);
    let start = '', next = '';
    if (/^\d{4}$/.test(yT) && /^\d{1,2}$/.test(mT) && +mT >= 1 && +mT <= 12 && +yT >= 1753 && +yT <= 9998) {
      const first = { y: +yT, m: +mT, d: 1 };
      const nm = +mT === 12 ? { y: +yT + 1, m: 1, d: 1 } : { y: +yT, m: +mT + 1, d: 1 };
      start = lit(first); next = lit(nm);
    } else if (/^@\w+$/.test(yT) && /^@\w+$/.test(mT) && !/DATE/.test(decls.get(yT.toLowerCase()) || '') && !/DATE/.test(decls.get(mT.toLowerCase()) || '')) {
      start = `DATEADD(MONTH, (${ys} - 1900) * 12 + ${msrc} - 1, 0)`;
      next = `DATEADD(MONTH, (${ys} - 1900) * 12 + ${msrc}, 0)`;
    } else if (/^YEAR\s*\(/i.test(yT) && /^MONTH\s*\(/i.test(mT) && coversAll(yT) && coversAll(mT)) {
      const ei = ys.slice(ys.indexOf('(') + 1, -1).trim(), em = msrc.slice(msrc.indexOf('(') + 1, -1).trim();
      if (ei.replace(/\s+/g, '').toLowerCase() !== em.replace(/\s+/g, '').toLowerCase()) continue;
      start = `DATEADD(MONTH, DATEDIFF(MONTH, 0, ${ei}), 0)`;
      next = `DATEADD(MONTH, DATEDIFF(MONTH, 0, ${ei}) + 1, 0)`;
    } else continue;
    if (!safeOperand(yT, col) || !safeOperand(mT, col)) continue;
    push(m.index, cmp2.end, `(${col.text} >= ${start} AND ${col.text} < ${next})`, 'YEAR + MONTH → rango del mes');
  }

  // 2) Funciones sobre la columna en el lado izquierdo de la comparación
  for (const m of allMatches(/\b(SUBSTRING|LEFT|CONVERT|CAST|YEAR|DATEPART|DATEDIFF|DATEADD)\s*\(/gi, masked)) {
    if (isCovered(m.index) || !inPredicate(masked, m.index)) continue;
    const fn = m[1].toUpperCase();
    const open = m.index + m[0].length - 1, close = matchParen(masked, open);
    if (close < 0) continue;
    const cmp = readComparison(masked, close);
    if (!cmp) continue;
    const args = fn === 'CAST' ? [] : splitArgs(masked, open, close);
    const opA = M(cmp.a), srcA = S(cmp.a);
    const opB = cmp.b ? M(cmp.b) : '', srcB = cmp.b ? S(cmp.b) : '';
    let text: string | null = null, rule = '';

    if (fn === 'SUBSTRING' || fn === 'LEFT') {
      // SUBSTRING(col, 1, n) / LEFT(col, n) con literal de n caracteres
      const okArgs = fn === 'SUBSTRING' ? args.length === 3 && M(args[1]) === '1' && /^\d+$/.test(M(args[2]))
        : args.length === 2 && /^\d+$/.test(M(args[1]));
      const col = okArgs ? colRef(M(args[0])) : null;
      if (!col) continue;
      const n = +M(args[args.length - 1]);
      const litA = /^(N?)'([^']*)'$/i.exec(srcA);
      if (cmp.op === '=' && litA && litA[2].length === n && !/[%_[]/.test(litA[2]) && !/ $/.test(litA[2])) {
        text = `${col.text} LIKE ${litA[1]}'${litA[2]}%'`; rule = `${fn} → LIKE 'prefijo%'`;
      } else {
        const dA = /^N?'(\d+)'$/i.exec(srcA), dB = cmp.b ? /^N?'(\d+)'$/i.exec(srcB) : null;
        const okLen = (x: RegExpExecArray | null) => !!x && x[1].length === n;
        if (cmp.op === 'BETWEEN' && okLen(dA) && okLen(dB)) {
          const inc = digitsInc(dB![1]);
          if (inc) { text = `(${col.text} >= '${dA![1]}' AND ${col.text} < '${inc}')`; rule = `${fn} BETWEEN → rango sobre la columna`; }
        } else if (cmp.op !== 'BETWEEN' && okLen(dA)) {
          const inc = digitsInc(dA![1]);
          const r = cmp.op === '>=' ? `${col.text} >= '${dA![1]}'` : cmp.op === '<' ? `${col.text} < '${dA![1]}'`
            : inc && cmp.op === '<=' ? `${col.text} < '${inc}'` : inc && cmp.op === '>' ? `${col.text} >= '${inc}'` : null;
          if (r) { text = r; rule = `${fn} ${cmp.op} → comparación sobre la columna`; }
        }
      }
    } else if (fn === 'CONVERT' || fn === 'CAST') {
      let colTxt = '', target = '', style = '';
      if (fn === 'CAST') {
        const am = /^([\s\S]+?)\s+AS\s+([\s\S]+)$/i.exec(masked.slice(open + 1, close).trim());
        if (!am) continue;
        colTxt = am[1]; target = am[2].replace(/\s+/g, '').toUpperCase();
      } else {
        if (args.length < 2) continue;
        target = M(args[0]).replace(/\s+/g, '').toUpperCase(); colTxt = M(args[1]); style = args[2] ? M(args[2]) : '';
      }
      const col = colRef(colTxt);
      if (!col || !isDateCol(col)) continue;
      if (target === 'DATE') {
        // CONVERT(DATE, dCol) / CAST(dCol AS DATE) contra un valor DATE (sin hora)
        if (!safeOperand(opA, col) || (cmp.b && !safeOperand(opB, col))) continue;
        const a = dateOperand(srcA, opA, decls);
        if (!a) continue;
        if (cmp.op === 'BETWEEN') {
          const b = dateOperand(srcB, opB, decls);
          if (b) { text = `(${col.text} >= ${a.start} AND ${col.text} < ${b.next})`; rule = `${fn}(DATE) BETWEEN → rango de fechas`; }
        } else { text = rangeFor(col.text, cmp.op, a.start, a.next); rule = `${fn}(DATE) ${cmp.op} → rango de fechas`; }
      } else {
        // CONVERT(VARCHAR(8), dCol, 112) = 'yyyymmdd' | CONVERT(VARCHAR(10), dCol, 23|120|121) = 'yyyy-mm-dd'
        const tm = /^N?(?:VAR)?CHAR\((8|10)\)$/.exec(target);
        if (!tm || fn !== 'CONVERT') continue;
        const compact = tm[1] === '8' && style === '112' ? true : tm[1] === '10' && /^(23|120|121|126)$/.test(style) ? false : null;
        if (compact === null) continue;
        const a = parseDateLit(srcA, compact);
        if (!a) continue;
        if (cmp.op === 'BETWEEN') {
          const b = parseDateLit(srcB, compact);
          if (b) { text = `(${col.text} >= ${lit(a)} AND ${col.text} < ${lit(addDays(b, 1))})`; rule = 'CONVERT(VARCHAR, fecha, estilo) BETWEEN → rango de fechas'; }
        } else { text = rangeFor(col.text, cmp.op, lit(a), lit(addDays(a, 1))); rule = `CONVERT(VARCHAR, fecha, estilo) ${cmp.op} → rango de fechas`; }
      }
    } else if (fn === 'YEAR' || fn === 'DATEPART') {
      let colTxt = '';
      if (fn === 'YEAR') { if (args.length !== 1) continue; colTxt = M(args[0]); }
      else { if (args.length !== 2 || !/^(YEAR|YY|YYYY)$/i.test(M(args[0]))) continue; colTxt = M(args[1]); }
      const col = colRef(colTxt);
      if (!col || !isDateCol(col) || !safeOperand(opA, col) || (cmp.b && !safeOperand(opB, col))) continue;
      const a = yearOperand(srcA, opA, decls);
      if (!a) continue;
      if (cmp.op === 'BETWEEN') {
        const b = yearOperand(srcB, opB, decls);
        if (b) { text = `(${col.text} >= ${a.start} AND ${col.text} < ${b.next})`; rule = 'YEAR BETWEEN → rango de años con DATEADD'; }
      } else { text = rangeFor(col.text, cmp.op, a.start, a.next); rule = `YEAR ${cmp.op} → rango del año con DATEADD`; }
    } else if (fn === 'DATEDIFF') {
      // DATEDIFF(unidad, dCol, X) op N  |  DATEDIFF(unidad, X, dCol) op N
      if (args.length !== 3 || cmp.op === 'BETWEEN' || !/^-?\d+$/.test(opA)) continue;
      const unit = UNIT[M(args[0]).toUpperCase()];
      if (!unit) continue;
      const c1 = colRef(M(args[1])), c2 = colRef(M(args[2]));
      const colFirst = !!c1 && isDateCol(c1) && !(c2 && isDateCol(c2));
      const colSecond = !colFirst && !!c2 && isDateCol(c2);
      if (!colFirst && !colSecond) continue;
      const col = (colFirst ? c1 : c2)!;
      const xSp = colFirst ? args[2] : args[1];
      if (!safeOperand(M(xSp), col)) continue;
      const X = S(xSp), N = +opA;
      // idx(col) rel idx(X) + s
      const rel = colFirst ? FLIP[cmp.op] : cmp.op;
      const s = colFirst ? -N : N;
      const B = (j: number) => `DATEADD(${unit}, DATEDIFF(${unit}, 0, ${X})${j ? (j > 0 ? ' + ' + j : ' - ' + (-j)) : ''}, 0)`;
      text = rangeFor(col.text, rel, B(s), B(s + 1));
      rule = `DATEDIFF(${unit}) ${cmp.op} ${N} → rango con DATEADD/DATEDIFF`;
    } else if (fn === 'DATEADD') {
      // DATEADD(DAY|HOUR|…, n, dCol) op X → dCol op DATEADD(…, -n, X)
      if (args.length !== 3 || !ADD_UNIT.test(M(args[0])) || !/^-?\d+$/.test(M(args[1]))) continue;
      const col = colRef(M(args[2]));
      if (!col || !isDateCol(col) || !safeOperand(opA, col) || (cmp.b && !safeOperand(opB, col))) continue;
      const u = S(args[0]), n = -(+M(args[1]));
      const shift = (x: string) => `DATEADD(${u}, ${n}, ${x})`;
      text = cmp.op === 'BETWEEN' ? `${col.text} BETWEEN ${shift(srcA)} AND ${shift(srcB)}` : `${col.text} ${cmp.op} ${shift(srcA)}`;
      rule = 'DATEADD sobre la columna → DATEADD sobre el valor';
    }

    if (text) push(m.index, cmp.end, text, rule);
  }
  return edits;
}

/**
 * Reescribe los predicados no SARGables que tienen equivalente exacto.
 * Devuelve el código resultante, la cantidad de cambios y el detalle de cada uno.
 */
export function sargRewrite(src: string): SargResult {
  const changes: SargChange[] = [];
  let count = 0;
  for (let pass = 0; pass < 4; pass++) {
    const masked = maskSql(src);
    const edits = collectEdits(src, masked, declaredTypes(masked));
    if (!edits.length) break;
    edits.sort((a, b) => b.start - a.start);
    let lastStart = Infinity;
    for (const e of edits) {
      if (e.end > lastStart) continue;
      changes.push({ rule: e.rule, before: src.slice(e.start, e.end).replace(/\s+/g, ' '), after: e.text, line: lineOf(src, e.start) });
      src = src.slice(0, e.start) + e.text + src.slice(e.end);
      lastStart = e.start; count++;
    }
  }
  changes.sort((a, b) => a.line - b.line);
  return { src, count, changes };
}

// ---------------------------------------------------------------- DML sobre temporales

/**
 * ¿El INSERT/UPDATE/DELETE/MERGE que empieza en idx modifica una #temporal o @variable tabla?
 * Resuelve alias: UPDATE t SET … FROM #T t  /  DELETE d FROM #Det d …
 */
export function dmlTargetIsTemp(masked: string, idx: number): boolean {
  const m = /^(UPDATE|DELETE|INSERT|MERGE)\s+(?:TOP\s*\([^)]*\)\s*(?:PERCENT\s+)?)?(?:(?:INTO|FROM)\s+)?((?:\[?[\w#@]+\]?\s*\.\s*)*\[?[#@]?\w+\]?)/i.exec(masked.slice(idx, idx + 600));
  if (!m) return false;
  const target = m[2].replace(/[\s[\]]/g, '');
  if (/^[#@]/.test(target)) return true;
  if (target.includes('.')) return false;
  // Alias: buscarlo en el FROM/JOIN de la misma sentencia
  let region = masked.slice(idx + m[0].length, idx + 4000);
  const cut = region.search(/;|\n\s*(INSERT|UPDATE|DELETE|MERGE|COMMIT|ROLLBACK|END|IF|WHILE|DECLARE|EXEC|EXECUTE|DROP|CREATE|TRUNCATE|BEGIN)\b/i);
  if (cut >= 0) region = region.slice(0, cut);
  const a = new RegExp('\\b(?:FROM|JOIN)\\s+((?:\\[?[\\w#@]+\\]?\\s*\\.\\s*)*\\[?[#@]?\\w+\\]?)\\s+(?:AS\\s+)?\\[?' + escRe(target) + '\\]?(?![\\w.])', 'i').exec(region);
  return !!a && /^[#@]/.test(a[1].replace(/[\s[\]]/g, ''));
}

/**
 * Las transacciones del script solo modifican #temporales / @variables tabla (o no modifican nada):
 * en ese caso no se exige TRY/CATCH ni se envuelve la transacción. Si dentro hay EXEC de otro PA, no se asume.
 */
export function tranOnlyTemp(src: string): boolean {
  const masked = maskSql(src);
  const begins = allMatches(/\bBEGIN\s+TRAN(?:SACTION)?\b/gi, masked);
  if (!begins.length) return false;
  for (const b of begins) {
    const rest = masked.slice(b.index + b[0].length);
    const end = rest.search(/\b(COMMIT|ROLLBACK)\b/i);
    const body = end >= 0 ? rest.slice(0, end) : rest;
    const off = b.index + b[0].length;
    if (/\bEXEC(?:UTE)?\b/i.test(body)) return false;
    for (const d of allMatches(/\b(INSERT|UPDATE|DELETE|MERGE)\b/gi, body)) {
      const after = body.slice(d.index);
      if (/^UPDATE\s+STATISTICS\b/i.test(after)) continue;
      if (/\b(FOR|ON)\s*$/i.test(body.slice(Math.max(0, d.index - 6), d.index))) continue; // FOR UPDATE / ON DELETE
      if (!dmlTargetIsTemp(masked, off + d.index)) return false;
    }
  }
  return true;
}
