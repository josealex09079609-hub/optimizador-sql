/**
 * Motor de análisis y optimización T-SQL (SQL Server 2019) + análisis de planes de ejecución.
 * Reglas: skill "pa-sqlserver-cajaica" (Manual de Buenas Prácticas UPBD + code review senior + DBA).
 * Lógica pura (sin dependencias de Angular): se puede probar de forma aislada.
 */
import { SqlSpan, AnalysisResult, AppliedChange, Finding, OptimizeOptions, OptimizeResult, ProcInfo, PlanAnalysis, ImprovedPlan } from './models';

interface XNode { name: string; attrs: Record<string, string>; children: XNode[] }

// ---------- Utilidades ----------
export function mask(src: string): { masked: string; comments: SqlSpan[]; strings: SqlSpan[] } {
  let out = '', i = 0, n = src.length;
  const comments: SqlSpan[] = [], strings: SqlSpan[] = [];
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '-' && d === '-') {
      let j = src.indexOf('\n', i); if (j === -1) j = n;
      comments.push({ start: i, end: j, text: src.slice(i, j), type: 'line' });
      out += ' '.repeat(j - i); i = j;
    } else if (c === '/' && d === '*') {
      let depth = 1, j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
        else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      const t = src.slice(i, j);
      comments.push({ start: i, end: j, text: t, type: 'block' });
      out += t.replace(/[^\n]/g, ' '); i = j;
    } else if (c === "'" || ((c === 'N' || c === 'n') && d === "'" && !/\w/.test(src[i - 1] || ''))) {
      let j = c === "'" ? i + 1 : i + 2;
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; break; }
        j++;
      }
      const t = src.slice(i, j);
      strings.push({ start: i, end: j, text: t });
      const q = c === "'" ? 1 : 2;
      out += t.slice(0, q) + t.slice(q, -1).replace(/[^\n]/g, ' ') + "'"; i = j;
    } else { out += c; i++; }
  }
  return { masked: out, comments, strings };
}

const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;

function matchParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function allMatches(re, s) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const res: any[] = []; let m;
  while ((m = r.exec(s)) !== null) { res.push(m); if (m.index === r.lastIndex) r.lastIndex++; }
  return res;
}

const uniq = (a: number[]) => [...new Set(a)].sort((x, y) => x - y);

const RESERVED = new Set(('SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL CROSS OUTER ON AND OR GROUP ORDER BY HAVING UNION ALL ' +
  'INSERT INTO UPDATE DELETE SET VALUES AS WITH NOLOCK EXISTS IN NOT NULL IS CASE WHEN THEN ELSE END BEGIN IF WHILE ' +
  'DECLARE EXEC EXECUTE RETURN TOP DISTINCT APPLY OPTION PIVOT UNPIVOT MERGE USING OUTPUT TABLE PROCEDURE PROC CREATE ' +
  'ALTER DROP TRUNCATE COMMIT ROLLBACK TRAN TRANSACTION TRY CATCH THROW GO LIKE BETWEEN OVER PARTITION ROWS FETCH NEXT ' +
  'OFFSET ASC DESC INDEX FOR XML PATH').split(' '));

// Hints de tabla reconocidos (WITH (...) o sintaxis antigua (...) sin WITH)
const TABLE_HINT = /^\s*(NOLOCK|READUNCOMMITTED|READCOMMITTED|READCOMMITTEDLOCK|HOLDLOCK|UPDLOCK|ROWLOCK|PAGLOCK|TABLOCK|TABLOCKX|XLOCK|NOWAIT|READPAST|SERIALIZABLE|REPEATABLEREAD|SNAPSHOT|INDEX|FORCESEEK|FORCESCAN|NOEXPAND|KEEPIDENTITY|KEEPDEFAULTS|IGNORE_CONSTRAINTS|IGNORE_TRIGGERS)\b/i;
// Hints de bloqueo: si existen, NOLOCK no se agrega (sería contradictorio o daría error)
const LOCK_HINT = /\b(HOLDLOCK|UPDLOCK|ROWLOCK|PAGLOCK|TABLOCK|TABLOCKX|XLOCK|READPAST|SERIALIZABLE|REPEATABLEREAD|READCOMMITTED|READCOMMITTEDLOCK|SNAPSHOT)\b/i;
const hasNolockHint = h => !!h && /\b(NOLOCK|READUNCOMMITTED)\b/i.test(h);

// Lee los grupos de hints que siguen a una tabla: WITH (...) y/o (...) antiguo, uno o varios seguidos
function readHintGroups(masked, pos) {
  const groups: any[] = [];
  for (let guard = 0; guard < 6; guard++) {
    const w = /^\s*(WITH\s*)?\(/i.exec(masked.slice(pos));
    if (!w) break;
    const open = pos + w[0].length - 1, close = matchParen(masked, open);
    if (close < 0) break;
    const inner = masked.slice(open + 1, close);
    if (!w[1] && !TABLE_HINT.test(inner)) break; // "(…)" sin WITH solo cuenta si es un hint conocido
    const start = pos + (w[0].length - w[0].trimStart().length);
    groups.push({ start, open, close, legacy: !w[1], inner });
    pos = close + 1;
  }
  return { groups, end: pos };
}

function tableRefs(masked) {
  const refs: any[] = [];
  const re = /\b(FROM|JOIN)\s+((?:\[?[\w#@]+\]?\s*\.\s*){0,3}\[?[#@]?[\w]+\]?)/gi;
  for (const m of allMatches(re, masked)) {
    const name = m[2].replace(/\s/g, '');
    const nameIndex = m.index + m[0].length - m[2].length;
    let pos = m.index + m[0].length;
    let alias: any = null;
    const p0 = /^\s*\(/.exec(masked.slice(pos));
    if (p0) {
      const open = pos + p0[0].length - 1, close = matchParen(masked, open);
      if (!TABLE_HINT.test(close > 0 ? masked.slice(open + 1, close) : '')) continue; // TVF / función
    } else {
      const a = /^\s+(?:AS\s+)?(\[?[A-Za-z_]\w*\]?)/i.exec(masked.slice(pos));
      if (a && !RESERVED.has(a[1].replace(/[\[\]]/g, '').toUpperCase())) { alias = a[1]; pos += a[0].length; }
    }
    const aliasEnd = pos;
    const hg = readHintGroups(masked, pos);
    const groups = hg.groups;
    const hint = groups.length ? groups.map(g => g.inner).join(',') : null;
    refs.push({ kw: m[1].toUpperCase(), name, alias, hint, groups, legacy: groups.some(g => g.legacy),
      hintOpen: groups.length ? groups[0].open : -1, hintClose: groups.length ? groups[groups.length - 1].close : -1,
      aliasEnd, index: m.index, nameIndex, end: hg.end, isTemp: /^#|^\[#|^@/.test(name) });
  }
  return refs;
}

// ----- Utilidades de hints -----
const isNolockTok = t => /^\s*(NOLOCK|READUNCOMMITTED)\s*$/i.test(t);
function hintTokens(groups) { return groups.flatMap(g => splitTop(g.inner).map(t => t.trim()).filter(Boolean)); }
function dedupeNolock(tokens) {
  const out: any[] = []; let seen = false;
  for (const t of tokens) {
    if (isNolockTok(t)) { if (!seen) { out.push('NOLOCK'); seen = true; } }
    else if (!out.some(o => o.toUpperCase() === t.toUpperCase())) out.push(t);
  }
  return out;
}
function hintNeedsNormalize(groups) {
  if (!groups.length) return false;
  const toks = hintTokens(groups);
  const nl = toks.filter(isNolockTok).length;
  return groups.length > 1 || nl > 1 || (groups[0].legacy && nl > 0);
}
function hintEdit(src, groups, tokens) {
  const s0 = groups[0].start, e0 = groups[groups.length - 1].close + 1;
  if (!tokens.length) {
    let s1 = s0; while (s1 > 0 && /[ \t]/.test(src[s1 - 1])) s1--;
    return { start: s1, end: e0, text: '' };
  }
  return { start: s0, end: e0, text: `WITH (${tokens.join(', ')})` };
}
function applyEdits(src, edits) {
  edits.sort((a, b) => b.start - a.start);
  let last = Infinity;
  for (const e of edits) { if (e.end > last) continue; src = src.slice(0, e.start) + e.text + src.slice(e.end); last = e.start; }
  return src;
}
function dmlHeadHints(masked) {
  const res: any[] = [];
  const re = /\b(UPDATE|DELETE)\s+(?:TOP\s*\(\s*\d+\s*\)\s*(?:PERCENT\s+)?)?((?:\[?[\w#@]+\]?\s*\.\s*){0,3}\[?[#@]?\w+\]?)/gi;
  for (const m of allMatches(re, masked)) {
    if (/^FROM$/i.test(m[2])) continue;
    const hg = readHintGroups(masked, m.index + m[0].length);
    if (hg.groups.length) res.push({ kind: m[1].toUpperCase(), name: m[2], index: m.index, groups: hg.groups, isTemp: /[#@]/.test(m[2]) });
  }
  return res;
}

function stmtContext(masked, idx) {
  const before = masked.slice(Math.max(0, idx - 4000), idx);
  const ms = allMatches(/\b(SELECT|UPDATE|DELETE|INSERT|MERGE)\b/gi, before);
  return ms.length ? ms[ms.length - 1][1].toUpperCase() : null;
}

function predicateContext(masked, idx) {
  const before = masked.slice(Math.max(0, idx - 1500), idx);
  const ms = allMatches(/\b(WHERE|ON|AND|OR|HAVING|SELECT|SET|BY|THEN|ELSE|WHEN|CASE|INTO|FROM|VALUES|RETURN|DECLARE|IF|JOIN)\b/gi, before);
  if (!ms.length) return false;
  return ['WHERE', 'ON', 'AND', 'OR', 'HAVING'].includes(ms[ms.length - 1][1].toUpperCase());
}

function parseProc(src: string, masked: string): ProcInfo | null {
  const m = /\b(CREATE(?:\s+OR\s+ALTER)?|ALTER)\s+PROC(?:EDURE)?\s+((?:\[?\w+\]?\.){0,2}\[?\w+\]?)/i.exec(masked);
  if (!m) return null;
  const fullName = m[2].replace(/[\[\]]/g, '');
  const parts = fullName.split('.');
  const name = parts[parts.length - 1];
  const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
  const rest = masked.slice(m.index + m[0].length);
  const asM = /\bAS\b(?=\s*(?:BEGIN|SET|DECLARE|SELECT|IF|WITH|INSERT|UPDATE|DELETE|EXEC|TRUNCATE|CREATE|;|$))/im.exec(rest);
  const headerEnd = asM ? m.index + m[0].length + asM.index : m.index + m[0].length;
  const header = masked.slice(m.index + m[0].length, headerEnd);
  const params: any[] = [];
  for (const p of allMatches(/(@\w+)\s+(?:AS\s+)?([A-Za-z_]\w*(?:\s*\(\s*(?:\d+|MAX)\s*(?:,\s*\d+\s*)?\))?)(\s*=\s*[^,]+?)?(\s+(?:OUTPUT|OUT|READONLY))?\s*(?:,|$)/gi, header)) {
    params.push({ name: p[1], type: p[2].replace(/\s+/g, ''), def: p[3] ? p[3].replace(/^\s*=\s*/, '').trim() : null, out: !!p[4] });
  }
  return { kind: m[1].toUpperCase(), fullName, name, schema, params, index: m.index, asIndex: asM ? headerEnd : -1 };
}

// Comentarios con código (se excluyen los de cabecera, antes del CREATE/ALTER)
function commentedCode(src, masked, comments) {
  const p = parseProc(src, masked);
  const headerLimit = p ? p.index : 0;
  return comments.filter(c => {
    if (c.start < headerLimit) return false;
    const t = c.text.replace(/^--|^\/\*|\*\/$/g, '');
    const kws = (t.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|EXEC|SET|DECLARE|INTO|ORDER\s+BY|GROUP\s+BY)\b/gi) || []).length;
    return kws >= 2 || /^\s*(SELECT|INSERT|UPDATE|DELETE|EXEC|SET\s+@|DECLARE|AND|OR|INNER|LEFT)\b/i.test(t);
  });
}

function splitTop(s) {
  const out: any[] = []; let d = 0, cur = '';
  for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; }
  if (cur.trim()) out.push(cur); return out;
}
function colAlias(expr) {
  const e = expr.trim();
  let m = /\bAS\s+\[?(\w+)\]?\s*$/i.exec(e); if (m) return m[1];
  m = /^\[?(\w+)\]?\s*=(?!=)/.exec(e); if (m && !/^@/.test(e)) return m[1];
  m = /^(?:\[?\w+\]?\.)*\[?(\w+)\]?$/.exec(e); if (m) return m[1];
  m = /[\s\)]\[?([A-Za-z_]\w*)\]?\s*$/.exec(e); if (m && !RESERVED.has(m[1].toUpperCase())) return m[1];
  return null;
}
function inferType(col, expr) {
  let e = (expr || '').trim();
  e = e.replace(/^\[?\w+\]?\s*=(?!=)\s*/, '');
  e = e.replace(/\)\s+(?:AS\s+)?\[?[A-Za-z_]\w*\]?\s*$/i, ')');
  e = e.toUpperCase().trim();
  let m = /^CAST\s*\([\s\S]*\bAS\s+([A-Z0-9]+(?:\s*\([^)]*\))?)\s*\)$/.exec(e) || /^CONVERT\s*\(\s*([A-Z0-9]+(?:\s*\([^)]*\))?)\s*,/.exec(e);
  if (m) return { t: m[1].replace(/\s+/g, ''), sure: true };
  if (/^(COUNT|ROW_NUMBER|RANK|DENSE_RANK)\s*\(/.test(e)) return { t: 'INT', sure: true };
  if (/^(GETDATE|SYSDATETIME)\s*\(/.test(e)) return { t: 'DATETIME', sure: true };
  if (/^\d+$/.test(e)) return { t: 'INT', sure: true };
  const p = /^([a-z])[A-Z]/.exec(col || '');
  const map: Record<string, string> = { n: 'INT', c: 'VARCHAR(100)', b: 'BIT', d: 'DATETIME', m: 'MONEY' };
  if (p && map[p[1]]) return { t: map[p[1]], sure: false };
  return { t: 'VARCHAR(100)', sure: false };
}
function selectIntos(masked) {
  const res: any[] = [];
  for (const m of allMatches(/\bINTO\s+(#\w+)/gi, masked)) {
    const before = masked.slice(0, m.index);
    if (/\bINSERT\s*$/i.test(before)) continue;
    const sels = allMatches(/\bSELECT\b/gi, before);
    if (!sels.length) continue;
    const sel = sels[sels.length - 1];
    const list = masked.slice(sel.index + 6, m.index);
    if (/\bFROM\b/i.test(list)) continue;
    res.push({ selIdx: sel.index, intoIdx: m.index, intoEnd: m.index + m[0].length, table: m[1], list });
  }
  return res;
}
// Segmenta sentencias a nivel 0 de paréntesis
function needsNolock(x, masked) {
  const r = x.ref;
  if (x.role !== 'read' || r.isTemp) return false;
  if (hintTokens(r.groups).some(isNolockTok)) return false;
  if (r.hint && LOCK_HINT.test(r.hint)) return false;
  return !cteSet(masked).has(r.name.replace(/[\[\]]/g, '').toUpperCase());
}
function cteSet(masked) { return new Set(allMatches(/(?:\bWITH|,)\s*(\w+)\s*(?:\([^)]*\))?\s+AS\s*\(/gi, masked).map(m => m[1].toUpperCase())); }
function statements(masked) {
  const toks = allMatches(/\b[A-Za-z_]+\b|[();]/g, masked);
  const list: any[] = []; let depth = 0, cur: any = null, prev = '';
  const STARTERS = ['INSERT','UPDATE','DELETE','MERGE','DECLARE','IF','WHILE','BEGIN','END','CREATE','ALTER','DROP','EXEC','EXECUTE','RETURN','TRUNCATE','THROW','PRINT','ELSE','RAISERROR','COMMIT','ROLLBACK'];
  for (const t of toks) {
    const w = t[0].toUpperCase();
    if (w === '(') { depth++; prev = w; continue; }
    if (w === ')') { depth--; prev = w; continue; }
    if (depth > 0) { prev = w; continue; }
    if (w === ';') { cur = null; prev = w; continue; }
    let start = false;
    if (STARTERS.includes(w)) start = true;
    if (cur && cur.type === 'MERGE' && (prev === 'THEN' || prev === 'MATCHED')) start = false;
    if (cur && cur.type === 'INSERT' && !cur.sawSelect && (w === 'EXEC' || w === 'EXECUTE')) { cur.sawSelect = true; start = false; }
    if (w === 'SET' && !(cur && (cur.type === 'UPDATE' || cur.type === 'MERGE'))) start = true;
    if (w === 'WITH' && !/^\s*\(/.test(masked.slice(t.index + 4, t.index + 20))) start = true;
    if (w === 'SELECT') {
      if (cur && (cur.type === 'INSERT' || cur.type === 'WITH') && !cur.sawSelect) cur.sawSelect = true;
      else if (['UNION', 'ALL', 'EXCEPT', 'INTERSECT'].includes(prev)) { /* continúa */ }
      else start = true;
    }
    if (start) { cur = { type: w, start: t.index, sawSelect: false }; list.push(cur); }
    prev = w;
  }
  list.forEach((st, i) => { st.end = i + 1 < list.length ? list[i + 1].start : masked.length; });
  return list;
}
// Roles para la política NOLOCK:
//  read      → lectura de tabla física: lleva un único WITH (NOLOCK)
//  target    → tabla que se modifica/elimina (UPDATE/DELETE) o destino de INSERT/MERGE: sin NOLOCK
//  dmlSource → origen de un INSERT/MERGE hacia tabla física: no se agrega NOLOCK
// En UPDATE/DELETE con JOIN, las tablas unidas y las de subconsultas son "read" (sí llevan NOLOCK).
function nolockPlan(masked) {
  const refs = tableRefs(masked);
  const sts = statements(masked);
  const norm = x => (x || '').replace(/[\[\]\s]/g, '').toUpperCase();
  const depthAt = (from, to) => { let d = 0; for (let i = from; i < to; i++) { if (masked[i] === '(') d++; else if (masked[i] === ')') d--; } return d; };
  return refs.map(r => {
    const st = sts.filter(x => x.start <= r.index && r.index < x.end).pop();
    let role = 'read', dml = null;
    if (st && ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(st.type)) {
      dml = st.type;
      const head = masked.slice(st.start, st.end);
      const m = /^INSERT\s+(?:INTO\s+)?([^\s(]+)/i.exec(head) || /^UPDATE\s+(?:TOP\s*\(\s*\d+\s*\)\s*(?:PERCENT\s+)?)?([^\s(]+)/i.exec(head) ||
        /^DELETE\s+(?:TOP\s*\(\s*\d+\s*\)\s*(?:PERCENT\s+)?)?(?:FROM\s+)?([^\s(]+)/i.exec(head) || /^MERGE\s+(?:TOP\s*\(\s*\d+\s*\)\s*)?(?:INTO\s+)?([^\s(]+)/i.exec(head);
      const target = m ? norm(m[1]) : '';
      const inSt = refs.filter(x => x.index >= st.start && x.index < st.end);
      const byAlias = inSt.find(x => x.alias && norm(x.alias) === target);
      const targetName = byAlias ? norm(byAlias.name) : target;
      const targetTemp = /^[#@]/.test(targetName);
      const topLevel = depthAt(st.start, r.index) === 0;
      let isTarget;
      if (byAlias) isTarget = r === byAlias || (!r.alias && norm(r.name) === target);
      else isTarget = topLevel && target !== '' && (norm(r.name) === targetName || norm(r.name).split('.').pop() === targetName.split('.').pop());
      if (isTarget && !r.isTemp) role = 'target';
      else if (targetTemp) role = 'read';
      else if (dml === 'UPDATE' || dml === 'DELETE') role = 'read';
      else role = 'dmlSource';
    }
    return { ref: r, role, dml };
  });
}
const STRING_TYPE = /^(N?VARCHAR|N?CHAR)\b/i;
const COLL = 'SQL_Latin1_General_CP1_CI_AS';
// Columnas de texto sin COLLATE en #temporales / variables tabla
function tempStringCols(masked) {
  const res: any[] = [];
  for (const m of allMatches(/\b(?:CREATE\s+TABLE\s+#\w+|DECLARE\s+@\w+\s+(?:AS\s+)?TABLE)\s*\(/gi, masked)) {
    const open = m.index + m[0].length - 1, close = matchParen(masked, open);
    if (close < 0) continue;
    let pos = open + 1, depth = 0;
    for (let i = open + 1; i <= close; i++) {
      const ch = masked[i];
      if (ch === '(') depth++;
      if (ch === ')' && i < close) depth--;
      if ((ch === ',' && depth === 0) || i === close) {
        const def = masked.slice(pos, i);
        const lead = (def.match(/^\s*/) || [''])[0].length;
        const dm = /^(\[?\w+\]?\s+)(N?VARCHAR|N?CHAR)\b(\s*\(\s*(?:\d+|MAX)\s*\))?/i.exec(def.slice(lead));
        if (dm && !/\bCOLLATE\b/i.test(def) && !/^(CONSTRAINT|PRIMARY|UNIQUE|INDEX)\b/i.test(def.slice(lead)))
          res.push({ at: pos + lead + dm[0].length, col: dm[1].trim(), idx: pos + lead });
        pos = i + 1;
      }
    }
  }
  return res;
}
function createdTemps(masked) {
  return [...new Set([...allMatches(/\bCREATE\s+TABLE\s+(#\w+)/gi, masked).map(m => m[1]), ...selectIntos(masked).map(x => x.table)])];
}
const BARE_JOIN = /(?<!\b(?:INNER|LEFT|RIGHT|FULL|CROSS|OUTER|LOOP|HASH|MERGE)\s+)\bJOIN\b/gi;

const SINGLE_IN = /\b(NOT\s+)?IN\s*\(\s*(N?'[^']*'|-?\d+(?:\.\d+)?|@\w+)\s*\)/gi;
function throwNoSemicolon(masked) {
  const res: any[] = [];
  for (const m of allMatches(/\bTHROW\b/gi, masked)) {
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(masked[i])) i--;
    if (i < 0 || masked[i] === ';') continue;
    const before = masked.slice(Math.max(0, i - 15), i + 1);
    if (/\b(BEGIN\s+CATCH|BEGIN|ELSE|THEN|AS)$/i.test(before)) continue;
    res.push({ idx: m.index, at: i + 1 });
  }
  return res;
}
function* oldDropPatterns(src: string, masked: string): Generator<any> {
  const re = /\bIF\s+OBJECT_ID\s*\(\s*N?'tempdb\.\.(#\w+)'\s*(?:,\s*N?'U'\s*)?\)\s+IS\s+NOT\s+NULL\s+(?:BEGIN\s+)?DROP\s+TABLE\s+(?:tempdb\.\.)?(#\w+)[ \t]*;?(?:\s*END\b)?/gi;
  for (const m of allMatches(re, src)) if (masked.slice(m.index, m.index + 2).toUpperCase() === 'IF') yield { idx: m.index, len: m[0].length, table: m[1], kind: 'objid' };
  for (const m of allMatches(/\bDROP\s+TABLE\s+(?!IF\s+EXISTS)(#\w+(?:\s*,\s*#\w+)*)/gi, masked)) {
    const pre = masked.slice(Math.max(0, m.index - 200), m.index);
    if (/IS\s+NOT\s+NULL\s+(?:BEGIN\s+)?$/i.test(pre)) continue;
    yield { idx: m.index, len: m[0].length, table: m[1], kind: 'plain' };
  }
}

const COUNT_STAR = /\bCOUNT\s*\(\s*\*\s*\)/gi;
const AGG_FN = /\b(COUNT|COUNT_BIG|SUM|MAX|MIN|AVG|STRING_AGG|STDEV|STDEVP|VAR|VARP)\s*\(/i;
function stripSubqueries(t) {
  let guard = 0, m;
  while (guard++ < 50 && (m = /\(\s*SELECT\b/i.exec(t))) {
    const c = matchParen(t, m.index);
    if (c < 0) break;
    t = t.slice(0, m.index) + ' 0 ' + t.slice(c + 1);
  }
  return t;
}
function existsSubqueries(masked) {
  const res: any[] = [];
  for (const m of allMatches(/\bEXISTS\s*\(\s*SELECT\b/gi, masked)) {
    const open = masked.indexOf('(', m.index);
    const close = matchParen(masked, open);
    if (close < 0) continue;
    const selEnd = m.index + m[0].length;
    let depth = 0, fromAt = -1, setOp = false;
    const body = masked.slice(selEnd, close);
    for (const t of allMatches(/[()]|\b(FROM|UNION|EXCEPT|INTERSECT)\b/gi, body)) {
      if (t[0] === '(') { depth++; continue; }
      if (t[0] === ')') { depth--; continue; }
      if (depth !== 0) continue;
      const w = t[1].toUpperCase();
      if (w === 'FROM' && fromAt < 0) fromAt = selEnd + t.index;
      if (w !== 'FROM') setOp = true;
    }
    const listEnd = fromAt >= 0 ? fromAt : -1;
    const list = listEnd >= 0 ? masked.slice(selEnd, listEnd) : '';
    const core = list.trim();
    let status = 'fix', why = '';
    if (listEnd < 0) { status = 'skip'; why = 'sin FROM'; }
    else if (core === '1') status = 'ok';
    else if (setOp) { status = 'skip'; why = 'contiene UNION/EXCEPT/INTERSECT'; }
    else if (/^TOP\s*\(?\s*(0+|@\w+)\s*\)?/i.test(core)) { status = 'skip'; why = 'TOP 0 / TOP (@variable)'; }
    else if (AGG_FN.test(stripSubqueries(core)) && !/\bGROUP\s+BY\b/i.test(masked.slice(listEnd, close))) { status = 'agg'; why = 'agregado sin GROUP BY'; }
    res.push({ idx: m.index, listStart: selEnd, listEnd, list, status, why, isIf: /\bIF\s+(NOT\s+)?$/i.test(masked.slice(Math.max(0, m.index - 12), m.index)) });
  }
  return res;
}

// ---------- Reglas ----------
const SEV = { ALTA: 'Alta', MEDIA: 'Media', BAJA: 'Baja', INFO: 'Info' };

export function analyze(src: string): AnalysisResult {
  const { masked, comments } = mask(src);
  const F: Finding[] = [];
  const add = (id, sev, cat, title, detail, rec, idxs: any[] = [], ref = '', autofix = false) =>
    F.push({ id, sev, cat, title, detail, rec, lines: uniq(idxs.map(i => lineOf(src, i))), ref, autofix });

  const proc = parseProc(src, masked);
  const refs = tableRefs(masked);
  const permRefs = refs.filter(r => !r.isTemp);

  const star = allMatches(/\bSELECT\s+(?:DISTINCT\s+)?(?:TOP\s*\(?\s*\d+\s*\)?\s+(?:PERCENT\s+)?)?(?:\w+\.)?\*/gi, masked)
    .filter(m => !/EXISTS\s*\(\s*$/i.test(masked.slice(Math.max(0, m.index - 30), m.index)));
  if (star.length) add('R01', SEV.ALTA, 'Consultas', 'Uso de SELECT *',
    `Se encontraron ${star.length} sentencia(s) que traen todas las columnas.`,
    'Especificar solo las columnas necesarias. Reduce I/O, memoria concedida y evita romper el PA si la tabla cambia.',
    star.map(m => m.index), 'Manual BP – Consulta con tablas de poco volumen (punto 2)');

  const cur = allMatches(/\bDECLARE\s+\w+\s+(?:INSENSITIVE\s+|SCROLL\s+)?CURSOR\b/gi, masked);
  if (cur.length) add('R02', SEV.ALTA, 'Rendimiento', 'Uso de CURSOR',
    'Los cursores procesan fila por fila y generan bloqueos prolongados.',
    'Reemplazar por lógica basada en conjuntos (SET-BASED): INSERT…SELECT, UPDATE…FROM con JOIN, MERGE o funciones de ventana.',
    cur.map(m => m.index), 'Manual BP – Evitar uso de cursores y sentencia WHILE');

  const wh = allMatches(/\bWHILE\b/gi, masked);
  if (wh.length) add('R03', SEV.ALTA, 'Rendimiento', 'Uso de WHILE (procesamiento fila a fila)',
    `${wh.length} bucle(s) WHILE detectado(s).`,
    'Reemplazar por operaciones basadas en conjuntos solo si no depende del orden, no acumula variables fila a fila, no llama a otros PAs por fila y el estado final es idéntico. Para "repetir N veces por fila" usar una temporal de números generada con CTE recursivo (sin sys.all_objects ni MAXRECURSION) y unirla. Si no es equivalente, mantener y reportar.',
    wh.map(m => m.index), 'SKILL §3 – Sin cursores ni WHILE / §6 Cursor-WHILE → set-based');

  if (proc && !/\bSET\s+NOCOUNT\s+ON\b/i.test(masked)) add('R04', SEV.INFO, 'Configuración', 'Sin SET NOCOUNT ON',
    'El PA no tiene SET NOCOUNT ON.',
    'Agregarlo SOLO si es un PA nuevo. En un PA existente no se agrega (el llamador podría depender del conteo de filas): queda como observación no aplicada.',
    [proc.asIndex > 0 ? proc.asIndex : proc.index], 'SKILL §6 – Nunca cambiar: agregar SET NOCOUNT ON a un PA existente');

  const dyn = allMatches(/\bEXEC(?:UTE)?\s*\(\s*@|\bsp_executesql\b|\bEXEC(?:UTE)?\s+@\w+\s*(?:;|$|\n)/gim, masked);
  if (dyn.length) add('R05', SEV.ALTA, 'Seguridad / Rendimiento', 'Consultas dinámicas',
    'El SQL dinámico impide reutilizar planes, dificulta la revisión y expone a SQL Injection.',
    'Evitar consultas dinámicas: escribir consultas estáticas por escenario. Si es inevitable, usar sp_executesql parametrizado (nunca concatenar parámetros).',
    dyn.map(m => m.index), 'Observación DBA – "Evitar el uso de consultas dinámicas"');

  const stuff = allMatches(/\bFOR\s+XML\s+PATH\s*\(/gi, masked);
  if (stuff.length) add('R06', SEV.MEDIA, 'Funciones SQL 2019', 'Concatenación con STUFF / FOR XML PATH',
    'Patrón antiguo y costoso para concatenar filas.',
    "Usar STRING_AGG. Condiciones: conservar el orden con WITHIN GROUP (ORDER BY …) si el original tenía ORDER BY; si puede superar 8000 bytes avisar (no usar MAX sin aprobación); si el original NO usaba , TYPE).value(...) los caracteres & < > salían escapados (no es equivalente si los datos los contienen); el separador debe coincidir con la longitud quitada por STUFF.",
    stuff.map(m => m.index), 'Manual BP – Nuevas funciones nativas SQL Server 2019', true);

  const trim = allMatches(/\b(LTRIM\s*\(\s*RTRIM|RTRIM\s*\(\s*LTRIM)\s*\(/gi, masked);
  if (trim.length) add('R07', SEV.BAJA, 'Funciones SQL 2019', 'LTRIM(RTRIM()) en lugar de TRIM()',
    `${trim.length} ocurrencia(s).`, 'Reemplazar por TRIM(), cumple ambas funciones y mejora la legibilidad.',
    trim.map(m => m.index), 'Manual BP / Observación DBA', true);

  const refsNl = tableRefs(masked);
  const tmpNl = refsNl.filter(r => r.isTemp && hintTokens(r.groups).some(isNolockTok));
  if (tmpNl.length) add('R08', SEV.BAJA, 'Hints', 'WITH (NOLOCK) en tablas temporales / variables tabla',
    `Tablas: ${[...new Set(tmpNl.map(r => r.name))].join(', ')}.`,
    'Las temporales (#) y variables tabla (@) no llevan NOLOCK: el hint no aporta nada sobre tempdb.',
    tmpNl.map(r => r.index), 'SKILL §3.1 / Observación DBA', true);

  const plan = nolockPlan(masked);
  const noHint = plan.filter(x => needsNolock(x, masked)).map(x => x.ref);
  if (noHint.length) add('R09', SEV.MEDIA, 'Concurrencia', 'Lecturas de tablas físicas sin WITH (NOLOCK)',
    `Tablas: ${[...new Set(noHint.map(r => r.name))].join(', ')}.`,
    'Toda tabla física que solo se lee lleva un único WITH (NOLOCK): SELECT, JOIN, subconsultas, otras bases, orígenes hacia #temporal/@tabla y, en UPDATE/DELETE con JOIN, las tablas unidas (no la que se modifica o elimina).',
    noHint.map(r => r.index), 'Política NOLOCK del área', true);

  const dupNl = plan.filter(x => !x.ref.isTemp && !(x.role === 'target' && (x.dml === 'UPDATE' || x.dml === 'DELETE')) && hintNeedsNormalize(x.ref.groups)).map(x => x.ref);
  if (dupNl.length) add('R65', SEV.BAJA, 'Hints', 'NOLOCK duplicado o con sintaxis antigua',
    `Tablas: ${[...new Set(dupNl.map(r => r.name))].join(', ')}.`,
    'Cada tabla física lleva un solo WITH (NOLOCK). Se unifican hints repetidos (WITH (NOLOCK) WITH (NOLOCK), (NOLOCK) WITH (NOLOCK), NOLOCK + READUNCOMMITTED) y la forma antigua (NOLOCK) sin WITH.',
    dupNl.map(r => r.index), 'Política NOLOCK del área', true);

  const tgtNl = plan.filter(x => x.role === 'target' && (x.dml === 'UPDATE' || x.dml === 'DELETE') && hintTokens(x.ref.groups).some(isNolockTok)).map(x => x.ref);
  const headNl = dmlHeadHints(masked).filter(h => !h.isTemp && hintTokens(h.groups).some(isNolockTok));
  if (tgtNl.length || headNl.length) add('R50', SEV.MEDIA, 'Concurrencia', 'NOLOCK en la tabla que se modifica o elimina',
    `Tablas: ${[...new Set([...tgtNl.map(r => r.name), ...headNl.map(h => h.name)])].join(', ')}.`,
    'En UPDATE/DELETE la tabla destino no lleva NOLOCK; solo las tablas unidas que se leen. SQL Server ignora NOLOCK en la tabla destino (o da error 1065 en la cabecera UPDATE … WITH (NOLOCK)), por lo que quitarlo no cambia el resultado.',
    [...tgtNl.map(r => r.index), ...headNl.map(h => h.index)], 'Política NOLOCK del área', true);

  const insNl = plan.filter(x => (x.dml === 'INSERT' || x.dml === 'MERGE') && (x.role === 'dmlSource' || x.role === 'target') && hintTokens(x.ref.groups).some(isNolockTok)).map(x => x.ref);
  if (insNl.length) add('R66', SEV.ALTA, 'Concurrencia', 'NOLOCK en INSERT/MERGE hacia tabla física',
    `Tablas: ${[...new Set(insNl.map(r => r.name))].join(', ')}.`,
    'Los orígenes de un INSERT/MERGE hacia tabla física no deben llevar NOLOCK (se grabarían datos no confirmados). En un PA existente NO se quita automáticamente: reportarlo.',
    insNl.map(r => r.index), 'SKILL §3.1 – Política de NOLOCK');

  const fnRe = /\b(LEFT|RIGHT|SUBSTRING|CONVERT|CAST|ISNULL|UPPER|LOWER|YEAR|MONTH|DAY|DATEPART|DATEADD|DATEDIFF|LTRIM|RTRIM|TRIM|REPLACE|LEN|COALESCE|FORMAT)\s*\(/gi;
  const nonSarg: any[] = [];
  for (const m of allMatches(fnRe, masked)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(masked, open);
    if (close < 0) continue;
    const inner = masked.slice(open + 1, close).trim();
    const fn = m[1].toUpperCase();
    let arg = inner;
    if (['CONVERT', 'DATEPART', 'DATEADD', 'DATEDIFF'].includes(fn)) arg = inner.split(',').slice(1).join(',').trim();
    if (fn === 'CAST') arg = inner.split(/\bAS\b/i)[0].trim();
    const first = arg.split(',')[0].trim();
    if (!/^(\[?[A-Za-z_]\w*\]?\.)*\[?[A-Za-z_]\w*\]?$/.test(first)) continue;
    if (/^(GETDATE|NULL|SYSDATETIME)$/i.test(first)) continue;
    if (!predicateContext(masked, m.index)) continue;
    const after = masked.slice(close + 1, close + 20);
    const before = masked.slice(Math.max(0, m.index - 12), m.index);
    if (/^\s*(=|<>|!=|>=|<=|>|<|LIKE\b|IN\b|BETWEEN\b|NOT\b)/i.test(after) || /(=|<>|>|<)\s*$/.test(before))
      nonSarg.push({ i: m.index, t: `${fn}(${first}…)` });
  }
  if (nonSarg.length) add('R10', SEV.ALTA, 'Índices', 'Funciones sobre columnas en WHERE / JOIN (no SARGable)',
    `Expresiones: ${[...new Set(nonSarg.map(x => x.t))].slice(0, 8).join(', ')}.`,
    "Reescribir solo con equivalencia exacta: CONVERT(DATE, d) = @dFecha → d >= @dFecha AND d < DATEADD(DAY, 1, @dFecha); ISNULL(n, 0) = 0 → (n = 0 OR n IS NULL); LEFT(col, 1) = 'E' → col LIKE 'E%'. Si no se puede demostrar equivalencia, reportar.",
    nonSarg.map(x => x.i), 'Manual BP – Índices / Conformidad DBA');

  const udf = allMatches(/\b(?:\w+\.)?((?:FN|UFN|UDF)_?\w+|fn[A-Z]\w+|\w*Split\w*)\s*\(/g, masked)
    .filter(m => !/\b(FROM|JOIN|APPLY)\s+(?:\w+\.)?$/i.test(masked.slice(Math.max(0, m.index - 20), m.index)) || /split/i.test(m[1]));
  if (udf.length) {
    const split = udf.filter(m => /split/i.test(m[1]));
    add('R11', SEV.ALTA, 'Rendimiento', 'Uso de funciones definidas por el usuario',
      `Funciones: ${[...new Set(udf.map(m => m[1]))].join(', ')}.`,
      'No usar funciones escalares; consultar directamente el campo de la tabla o usar funciones nativas (CONVERT, IIF, CONCAT).' +
      (split.length ? " dbo.fn_split → STRING_SPLIT siempre: renombrar items → value (o value AS items); usar TRIM(value) si el original recortaba; STRING_SPLIT no garantiza orden en 2019 y solo acepta delimitador de 1 carácter." : '') + ' Si no se conoce el código de la función, pedirlo antes de tocarla.',
      udf.map(m => m.index), 'Observación DBA – "No usar las funciones, consultar directamente el campo"');
  }

  const vmax = allMatches(/\bN?VARCHAR\s*\(\s*MAX\s*\)/gi, masked);
  if (vmax.length) add('R12', SEV.MEDIA, 'Tipos de datos', 'Uso de VARCHAR(MAX)/NVARCHAR(MAX)',
    `${vmax.length} declaración(es).`, 'Estimar la longitud real. Si no hay base para estimar (mensajes, concatenaciones) usar VARCHAR(2000). MAX solo con aprobación explícita, documentando por qué.',
    vmax.map(m => m.index), 'SKILL §3 – Sin VARCHAR(MAX) (code review senior)');

  const subs = allMatches(/\(\s*SELECT\b/gi, masked);
  const scalarSub: any[] = [], inSub: any[] = [], notInSub: any[] = [], maxSub: any[] = [];
  for (const m of subs) {
    const before = masked.slice(Math.max(0, m.index - 40), m.index);
    if (/\bNOT\s+IN\s*$/i.test(before)) notInSub.push(m.index);
    else if (/\bIN\s*$/i.test(before)) inSub.push(m.index);
    else if (/\b(EXISTS|FROM|JOIN|APPLY|AS)\s*$/i.test(before)) continue;
    else {
      const body = masked.slice(m.index, m.index + 80);
      if (/SELECT\s+MAX\s*\(/i.test(body) && /=\s*$/.test(before)) maxSub.push(m.index);
      else if (!/SELECT\s+STRING_AGG\s*\(/i.test(body)) scalarSub.push(m.index);
    }
  }
  if (scalarSub.length) add('R13', SEV.MEDIA, 'Consultas', 'Subconsultas escalares / correlacionadas',
    `${scalarSub.length} subconsulta(s) en lista SELECT, SET o condiciones.`,
    'Preferir OUTER APPLY (SELECT TOP 1 … respetando el ORDER BY original): un JOIN puede duplicar filas si la relación no es única. Ojo: la subconsulta escalar original lanza error si devuelve > 1 fila; mencionar ese cambio.',
    scalarSub, 'Auditoría TI – "Evitar subconsultas, reemplazar por JOIN"');
  if (maxSub.length) add('R14', SEV.MEDIA, 'Consultas', 'Subconsulta MAX() correlacionada para obtener el último registro',
    'Patrón "col = (SELECT MAX(...) WHERE x = y)" se ejecuta por cada fila.',
    'Obtener el último registro una sola vez con ROW_NUMBER() OVER(PARTITION BY … ORDER BY … DESC) o GROUP BY en una temporal y luego hacer JOIN.',
    maxSub, 'Observación DBA (RHCargos)');
  if (notInSub.length) add('R15', SEV.MEDIA, 'Consultas', 'NOT IN (SELECT …)',
    'Si la subconsulta devuelve NULL el resultado es vacío; además suele ser menos eficiente.',
    'NO se cambia automáticamente: NOT IN y NOT EXISTS difieren si hay NULL. Evaluar y reportar como observación.', notInSub, 'SKILL §6 – Nunca cambiar: solo avisar');
  if (inSub.length) add('R16', SEV.BAJA, 'Consultas', 'IN (SELECT …)',
    `${inSub.length} ocurrencia(s).`, 'No cambiar IN ↔ JOIN (puede duplicar filas). Solo avisar.', inSub, 'SKILL §6 – Nunca cambiar: solo avisar');

  const cnt: Record<string, number[]> = {};
  permRefs.forEach(r => { const k = r.name.split('.').pop().replace(/[\[\]]/g, '').toUpperCase(); (cnt[k] = cnt[k] || []).push(r.index); });
  const rep = Object.entries(cnt).filter(([, v]) => v.length >= 3);
  if (rep.length) add('R17', SEV.MEDIA, 'Consultas', 'Misma tabla accedida varias veces',
    rep.map(([k, v]) => `${k} (${v.length} veces)`).join(', ') + '.',
    'Consolidar los accesos en una única lectura (ej. cargar los valores de Constante/ConstSistema necesarios en una variable tabla o temporal una sola vez, filtrando por IN de los códigos) y reutilizar.',
    rep.flatMap(([, v]) => v), 'Observación DBA – Constante con alias T, T1, T2, T3');

  const unused: any[] = [];
  for (const d of allMatches(/\bDECLARE\b/gi, masked)) {
    let seg = masked.slice(d.index + 7);
    const stop = seg.search(/;|\n(?!\s*,)/);
    seg = stop >= 0 ? seg.slice(0, stop) : seg;
    if (/\bCURSOR\b|\bTABLE\b/i.test(seg)) continue;
    for (const v of allMatches(/(?:^|,)\s*(@\w+)/g, seg)) {
      if (allMatches(new RegExp(v[1] + '\\b', 'gi'), masked).length <= 1) unused.push({ name: v[1], i: d.index });
    }
  }
  if (proc) proc.params.forEach(p => {
    if (allMatches(new RegExp(p.name + '\\b', 'gi'), masked).length <= 1) unused.push({ name: p.name + ' (parámetro)', i: proc.index });
  });
  if (unused.length) add('R18', SEV.MEDIA, 'Limpieza', 'Variables/parámetros declarados y no utilizados',
    unused.map(u => u.name).join(', ') + '.', 'Eliminar las declaraciones que no se usan.',
    unused.map(u => u.i), 'Observación DBA (@MONTOCOL)');

  const tc = allMatches(/,\s*\)/g, masked).filter(m => {
    const before = masked.slice(Math.max(0, m.index - 600), m.index);
    return /\b(CREATE\s+TABLE|DECLARE\s+@\w+\s+TABLE)\s*[#\w\[\]\.]*\s*\([^;]*$/i.test(before);
  });
  if (tc.length) add('R19', SEV.ALTA, 'Sintaxis', 'Coma final en definición de tabla',
    'Error de sintaxis por coma antes del paréntesis de cierre.', 'Eliminar la coma final.', tc.map(m => m.index), 'Observación DBA (#TabSalida)', true);

  if (proc) {
    const okName = /^PA_[A-Z][A-Za-z0-9]*_[A-Z][A-Za-z0-9]*(_[A-Z][A-Za-z0-9]*)?$/.test(proc.name);
    if (!okName) add('R20', SEV.BAJA, 'Nomenclatura', 'Nombre del procedimiento fuera del estándar',
      `"${proc.name}" no sigue <Esquema>.PA_<Tabla>_<Acción>_<Finalidad>.`,
      'Para objetos nuevos usar <Esquema>.PA_<Tabla>_<Sel|Upd|Ins|Del|Verbo>_<Finalidad>. Objetos existentes (legado): NUNCA renombrar PA, columnas ni parámetros.',
      [proc.index], 'Manual BP – Procedimientos almacenados');
    if (!proc.schema) add('R21', SEV.BAJA, 'Nomenclatura', 'Procedimiento sin esquema',
      'El objeto no indica esquema.', 'Crear el PA en el esquema del proyecto (ej. COLOCACIONES.PA_…).', [proc.index], 'Manual BP – Ordenamiento por esquemas');
    const typeMap: Record<string, RegExp> = { n: /^(INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|MONEY|SMALLMONEY|FLOAT|REAL)/i, c: /^(N?VARCHAR|N?CHAR|N?TEXT|XML|UNIQUEIDENTIFIER)/i, b: /^BIT/i, d: /^(DATE|DATETIME|DATETIME2|SMALLDATETIME|TIME)/i };
    const badP = proc.params.filter(p => !/^@[a-z][A-Z]/.test(p.name));
    const mism = proc.params.filter(p => /^@[ncbd][A-Z]/.test(p.name) && !typeMap[p.name[1]].test(p.type));
    if (badP.length) add('R22', SEV.BAJA, 'Nomenclatura', 'Parámetros fuera de la nomenclatura',
      badP.map(p => p.name).join(', ') + '.', 'En PA nuevo: prefijo de tipo en minúscula + PascalCase (c texto/xml/uniqueidentifier, n numérico, b bit, d fecha). En PA existente NO renombrar parámetros (la firma no se toca).',
      [proc.index], 'Manual BP – Procedimientos almacenados (parámetros)');
    if (mism.length) add('R23', SEV.MEDIA, 'Tipos de datos', 'Prefijo del parámetro no coincide con su tipo',
      mism.map(p => `${p.name} ${p.type}`).join(', ') + '.', 'No cambiar la firma de un PA existente. Si el tipo provoca conversión implícita contra la columna, declarar una variable local del tipo exacto de la columna, asignarle el parámetro al inicio y usarla en los filtros.', [proc.index], 'SKILL §2 / §6');
  }

  const codeComments = commentedCode(src, masked, comments);
  if (codeComments.length) add('R24', SEV.BAJA, 'Limpieza', 'Código comentado',
    `${codeComments.length} bloque(s) de código comentado dentro del procedimiento (los comentarios de cabecera se conservan).`,
    'Eliminar el código comentado; el historial queda en el control de versiones (Bitbucket).',
    codeComments.map(c => c.start), 'Manual BP – Eliminar el código comentado', true);

  const like = allMatches(/\bLIKE\s+(N?'%|'%'\s*\+)/gi, src).filter(m => masked.slice(m.index, m.index + 4).toUpperCase() === 'LIKE');
  if (like.length) add('R25', SEV.MEDIA, 'Índices', "LIKE con comodín inicial ('%…')",
    'Impide el uso de Index Seek (escaneo completo).', "Usar búsqueda por prefijo (col LIKE @valor + '%') o filtrar primero por campos indexados.", like.map(m => m.index), '');

  const orJoin: any[] = [];
  for (const m of allMatches(/\bON\b/gi, masked)) {
    const seg = masked.slice(m.index, m.index + 600);
    const end = seg.search(/\b(INNER|LEFT|RIGHT|FULL|CROSS|JOIN|WHERE|GROUP|ORDER|UNION|OUTER\s+APPLY)\b/i);
    if (/\bOR\b/i.test(end > 0 ? seg.slice(0, end) : seg)) orJoin.push(m.index);
  }
  if (orJoin.length) add('R27', SEV.MEDIA, 'Consultas', 'OR dentro de condiciones JOIN',
    'Obliga a escaneos y planes ineficientes.', 'Dividir en dos consultas con UNION ALL o normalizar el valor antes del JOIN (en una temporal).', orJoin, '');

  const catchAll = allMatches(/\(\s*@\w+\s+IS\s+NULL\s+OR\b|\bISNULL\s*\(\s*@\w+\s*,\s*[\w\.\[\]]+\s*\)\s*=\s*[\w\.\[\]]+|\b(?:\w+\.)?\w+\s*=\s*CASE\s+WHEN\s+@\w+/gi, masked);
  if (catchAll.length) add('R28', SEV.ALTA, 'Diseño', 'Query multiuso ("Frankenstein") con filtros opcionales',
    `${catchAll.length} condición(es) del tipo (@p IS NULL OR col = @p) / CASE sobre parámetros.`,
    'Crear consultas específicas por escenario (IF … ELSE con queries separados) para que cada una tenga su plan óptimo.',
    catchAll.map(m => m.index), 'Manual BP – Evitar Query Frankenstein multiuso');

  const hints = allMatches(/\bOPTION\s*\(|\bRECOMPILE\b|\bDBCC\b|\bFREEPROCCACHE\b|\bFORCE\s+ORDER\b|\bWITH\s*\(\s*INDEX\b|\bFORCESEEK\b|\bFORCESCAN\b|\b(?:INNER|LEFT)\s+(?:LOOP|HASH|MERGE)\s+JOIN\b|\bMAXDOP\b/gi, masked);
  if (hints.length) add('R29', SEV.MEDIA, 'Hints', 'Hints que fuerzan al optimizador',
    'Se fuerza índice, orden, tipo de JOIN o paralelismo.', 'No agregar hints ni comandos de motor (FORCESEEK, INDEX(), RECOMPILE, DBCC, FREEPROCCACHE, MAXRECURSION). Si el PA existente ya los tiene, NO quitarlos: reportarlos.',
    hints.map(m => m.index), 'Manual BP – Comandos que le dicen al motor qué hacer');

  // Transacciones
  const begins = allMatches(/\bBEGIN\s+TRAN(?:SACTION)?\b/gi, masked);
  const commits = allMatches(/\bCOMMIT\b/gi, masked);
  const rollbacks = allMatches(/\bROLLBACK\b/gi, masked);
  const hasTry = /\bBEGIN\s+TRY\b/i.test(masked);
  if (begins.length && (commits.length < begins.length || !rollbacks.length)) add('R46', SEV.ALTA, 'Transacciones', 'Transacción abierta sin cierre garantizado',
    `${begins.length} BEGIN TRAN, ${commits.length} COMMIT, ${rollbacks.length} ROLLBACK.`,
    'Toda transacción debe cerrarse: COMMIT al finalizar correctamente y ROLLBACK ante error (BEGIN TRY … COMMIT … END TRY BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK; THROW; END CATCH). Una transacción abierta mantiene bloqueos sobre las tablas.',
    begins.map(m => m.index), 'Observación DBA – bloqueos en BD', true);
  else if (begins.length && !hasTry) add('R30', SEV.ALTA, 'Transacciones', 'Transacción sin BEGIN TRY / BEGIN CATCH',
    'Un error intermedio puede dejar la transacción abierta y generar bloqueos.',
    'Envolver en BEGIN TRY … COMMIT … END TRY BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK; THROW; END CATCH.', begins.map(m => m.index), '', true);
  if (/\bSET\s+IMPLICIT_TRANSACTIONS\s+ON\b/i.test(masked)) add('R47', SEV.ALTA, 'Transacciones', 'IMPLICIT_TRANSACTIONS ON',
    'Cada sentencia abre una transacción que queda pendiente hasta un COMMIT explícito.', 'Retirar SET IMPLICIT_TRANSACTIONS ON y usar transacciones explícitas cortas.',
    allMatches(/\bSET\s+IMPLICIT_TRANSACTIONS\s+ON\b/gi, masked).map(m => m.index), '');
  const dml = allMatches(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|DELETE)\s+(?!#|@)(?:\[?\w+\]?\.)*\[?[A-Za-z]\w*/gi, masked)
    .filter(m => !/^UPDATE\s+STATISTICS/i.test(m[0]));
  if (dml.length >= 2 && !begins.length) add('R31', SEV.MEDIA, 'Transacciones', 'Varias operaciones DML sin transacción',
    `${dml.length} sentencias INSERT/UPDATE/DELETE sobre tablas permanentes.`, 'Agrupar en una transacción corta con TRY/CATCH para garantizar atomicidad.', dml.map(m => m.index), '');
  const atErr = allMatches(/@@ERROR\b/gi, masked);
  if (atErr.length) add('R32', SEV.BAJA, 'Transacciones', 'Control de errores con @@ERROR',
    'Patrón obsoleto.', 'Usar TRY/CATCH y THROW.', atErr.map(m => m.index), '');

  const impl: any[] = [];
  for (const m of allMatches(/\b(?:\w+\.)?\[?([nb][A-Z]\w*)\]?\s*(=|<>|!=|>=|<=|>|<)\s*N?'/g, masked)) impl.push({ i: m.index, t: `${m[1]} vs texto` });
  for (const m of allMatches(/\b(?:\w+\.)?\[?([nb][A-Z]\w*)\]?\s+(?:NOT\s+)?IN\s*\(\s*'/g, masked)) impl.push({ i: m.index, t: `${m[1]} IN (texto)` });
  for (const m of allMatches(/\b(?:\w+\.)?\[?(c[A-Z]\w*)\]?\s*(=|<>|!=|>=|<=|>|<)\s*\d/g, masked)) impl.push({ i: m.index, t: `${m[1]} vs número` });
  if (impl.length) add('R33', SEV.ALTA, 'Tipos de datos', 'Posibles conversiones implícitas',
    `Según la nomenclatura de columnas: ${[...new Set(impl.map(x => x.t))].slice(0, 8).join(', ')}.`,
    "Confirmar tipos con los scripts de metadatos (SKILL 0.1). No cambiar la firma: usar una variable local del tipo exacto de la columna. Verificar en el plan la advertencia CONVERT_IMPLICIT y que los JOIN comparen mismo tipo, longitud y collation.",
    impl.map(x => x.i), 'Observación DBA – "Corregir las conversiones implícitas (revisar el plan)"');

  const cnt0 = allMatches(/\bSELECT\s+COUNT\s*\(\s*(?:\*|1)\s*\)[\s\S]{0,400}?\)\s*>\s*0/gi, masked);
  if (cnt0.length) add('R34', SEV.MEDIA, 'Consultas', 'COUNT(*) > 0 para validar existencia',
    'Cuenta todas las filas cuando solo se necesita saber si existe una.', 'Usar IF EXISTS (SELECT 1 FROM … WHERE …).', cnt0.map(m => m.index), '');

  const oldJ = allMatches(/\bFROM\s+(?:\[?\w+\]?\.)*\[?\w+\]?(?:\s+(?:AS\s+)?\w+)?\s*,\s*(?:\[?\w+\]?\.)*\[?[A-Za-z#]\w*/gi, masked);
  if (oldJ.length) add('R35', SEV.MEDIA, 'Consultas', 'JOIN implícito con comas (estilo ANSI-89)',
    'Dificulta la lectura y favorece productos cartesianos accidentales.', 'Reescribir con INNER JOIN … ON ….', oldJ.map(m => m.index), '');

  const mail = allMatches(/\bsp_send_dbmail\b/gi, masked);
  if (mail.length && (wh.length || cur.length)) add('R36', SEV.ALTA, 'Diseño', 'Envío de correos dentro de un bucle',
    'sp_send_dbmail en WHILE/CURSOR satura Database Mail.', 'Seguir el lineamiento de correos masivos: preparar el lote con una consulta y delegar el envío a la aplicación/servicio.', mail.map(m => m.index), 'Manual BP – Correos masivos');

  const un = allMatches(/\bUNION\b(?!\s+ALL)/gi, masked);
  if (un.length) add('R37', SEV.BAJA, 'Consultas', 'UNION sin ALL',
    'UNION aplica un DISTINCT implícito (ordenamiento costoso).', 'No se cambia a UNION ALL automáticamente (cambia duplicados). Solo avisar.', un.map(m => m.index), 'SKILL §6 – Nunca cambiar: solo avisar');

  const isn = allMatches(/\bISNULL\s*\(\s*ISNULL\s*\(/gi, masked);
  if (isn.length) add('R38', SEV.INFO, 'Funciones SQL 2019', 'ISNULL anidado',
    `${isn.length} ocurrencia(s).`, 'Usar COALESCE(a, b, c) para mayor legibilidad.', isn.map(m => m.index), '');
  const conc = allMatches(/\bISNULL\s*\([^()]*,\s*'\s*'\s*\)\s*\+|\+\s*ISNULL\s*\([^()]*,\s*'\s*'\s*\)/gi, masked);
  if (conc.length) add('R39', SEV.INFO, 'Funciones SQL 2019', "Concatenación con ISNULL(x,'') + …",
    '', 'Usar CONCAT() o CONCAT_WS() que tratan NULL como cadena vacía.', conc.map(m => m.index), 'Manual BP – Nuevas funciones nativas');

  const tv = allMatches(/\bDECLARE\s+@\w+\s+TABLE\b/gi, masked);
  if (tv.length) add('R40', SEV.INFO, 'Temporales', 'Uso de variables tipo tabla',
    `${tv.length} variable(s) tabla.`, 'Válido para conjuntos pequeños (< 100 registros). Para volúmenes mayores usar tablas temporales (#) que tienen estadísticas.',
    tv.map(m => m.index), 'Manual BP – Uso de tablas temporales y variables tipo tabla');

  const sel = allMatches(/\bSELECT\b/gi, masked);
  const bigJoins: any[] = [];
  sel.forEach((m, k) => {
    const end = k + 1 < sel.length ? sel[k + 1].index : masked.length;
    if ((masked.slice(m.index, end).match(/\bJOIN\b/gi) || []).length >= 6) bigJoins.push(m.index);
  });
  if (bigJoins.length) add('R41', SEV.MEDIA, 'Diseño', 'Consulta con muchos JOIN',
    'Consultas con 6+ JOIN incrementan el tiempo de compilación y la memoria concedida.',
    'Primero obtener de la tabla de gran volumen solo lo necesario en una tabla temporal y luego realizar los cálculos/JOIN sobre la temporal.',
    bigJoins, 'Manual BP – Consulta con tablas de gran volumen de datos');

  const cteNames = new Set(allMatches(/(?:\bWITH|,)\s*(\w+)\s*(?:\([^)]*\))?\s+AS\s*\(/gi, masked).map(m => m[1].toUpperCase()));
  const noSchema = permRefs.filter(r => !r.name.includes('.') && !cteNames.has(r.name.replace(/[\[\]]/g, '').toUpperCase()));
  if (noSchema.length) add('R42', SEV.BAJA, 'Nomenclatura', 'Tablas referenciadas sin esquema',
    `${[...new Set(noSchema.map(r => r.name))].join(', ')}.`, 'Calificar siempre con el esquema (dbo.Tabla). Evita resoluciones de nombre y recompilaciones.',
    noSchema.map(r => r.index), '', true);

  if (proc && !/sp_(add|update)extendedproperty/i.test(masked)) add('R43', SEV.MEDIA, 'Documentación', 'Procedimiento sin diccionario de datos',
    'No se encontró sp_addextendedproperty para el PA ni sus parámetros.', 'Registrar MS_Description del PA y de cada parámetro. Revisa la pestaña "Diccionario" para el script generado.',
    [proc.index], 'Manual BP – Procedimientos almacenados (diccionario de datos)');

  const xdb = permRefs.filter(r => r.name.split('.').length === 3);
  if (xdb.length) add('R44', SEV.INFO, 'Diseño', 'Referencias a otras bases de datos',
    [...new Set(xdb.map(r => r.name))].join(', ') + '.', 'Minimizar las consultas cross-database; traer solo lo necesario a una temporal una sola vez.', xdb.map(r => r.index), '');

  const ordIns = allMatches(/\bINSERT\s+INTO\s+#\w+[^;]{0,3000}?\bORDER\s+BY\b/gi, masked)
    .filter(m => (m[0].match(/\bSELECT\b/gi) || []).length === 1 && !/\bTOP\b/i.test(m[0]));
  if (ordIns.length) add('R45', SEV.BAJA, 'Rendimiento', 'ORDER BY al insertar en temporal',
    'El orden de inserción no se garantiza y agrega un Sort costoso.', 'Ordenar solo en el SELECT final que se devuelve.', ordIns.map(m => m.index), '');

  const sis = selectIntos(masked);
  if (sis.length) add('R48', SEV.MEDIA, 'Temporales', 'SELECT … INTO #temporal (tabla sin definir)',
    `Tablas: ${[...new Set(sis.map(x => x.table))].join(', ')}.`,
    'Nunca SELECT … INTO #T: CREATE TABLE #T (tipos exactos de las columnas de origen + COLLATE SQL_Latin1_General_CP1_CI_AS en texto) e INSERT INTO #T (columnas) SELECT …. Si no se conocen los tipos, pedir los scripts de metadatos.',
    sis.map(x => x.selIdx), 'SKILL §3.2 – Tablas temporales', true);

  const bare = allMatches(BARE_JOIN, masked);
  if (bare.length) add('R49', SEV.BAJA, 'Estilo', 'JOIN sin tipo explícito',
    `${bare.length} JOIN sin especificar.`, 'Escribir INNER JOIN de forma explícita para mayor legibilidad y uniformidad.', bare.map(m => m.index), 'Estándar de codificación', true);

  // R51 RAISERROR → THROW
  const rse = allMatches(/\bRAISERROR\b/gi, masked);
  if (rse.length) add('R51', SEV.MEDIA, 'Errores', 'RAISERROR en lugar de THROW',
    `${rse.length} ocurrencia(s).`,
    'En el CATCH usar THROW; para relanzar el error original (la sentencia anterior debe terminar en ;). Al migrar avisar que cambia el número/severidad (RAISERROR con mensaje daba 50000) y revisar si el llamador depende de ello.',
    rse.map(m => m.index), 'SKILL §3 – Errores con THROW (DBA)');
  const thr = throwNoSemicolon(masked);
  if (thr.length) add('R52', SEV.ALTA, 'Errores', 'Sentencia previa a THROW sin punto y coma',
    'SQL Server interpreta THROW como alias de la sentencia anterior y falla.', 'Terminar en ; la sentencia anterior a THROW.',
    thr.map(x => x.idx), 'SKILL §3 – Errores con THROW', true);
  const sIn = allMatches(SINGLE_IN, masked);
  if (sIn.length) add('R53', SEV.BAJA, 'Consultas', 'IN / NOT IN con un solo valor',
    `${sIn.length} ocurrencia(s).`, 'Escribir = x / <> x (equivalente también con NULL), respetando el tipo del literal original.',
    sIn.map(m => m.index), 'SKILL §3 – Un solo valor → = / <> (code review senior)', true);
  const dOld = [...oldDropPatterns(src, masked)];
  if (dOld.length) add('R54', SEV.BAJA, 'Temporales', 'DROP TABLE sin IF EXISTS / patrón IF OBJECT_ID',
    `${dOld.length} ocurrencia(s).`, 'Usar DROP TABLE IF EXISTS #T (varias en una sola sentencia si se quiere).',
    dOld.map(x => x.idx), 'SKILL §3 / §6 – DROP TABLE IF EXISTS', true);
  const tmpsCreated = createdTemps(masked);
  const dropped = new Set(allMatches(/\bDROP\s+TABLE\s+IF\s+EXISTS\s+([#\w\s,]+)/gi, masked).flatMap(m => m[1].split(',').map(x => x.trim().toUpperCase())));
  const notDropped = tmpsCreated.filter(t => !dropped.has(t.toUpperCase()));
  if (proc && notDropped.length) add('R55', SEV.BAJA, 'Temporales', 'Temporales sin limpieza con DROP TABLE IF EXISTS',
    notDropped.join(', ') + '.',
    'Limpiar con DROP TABLE IF EXISTS al inicio del PA (antes de los CREATE TABLE), al final dentro del TRY y también en el CATCH antes del THROW. No borrar temporales creadas por el llamador.',
    allMatches(/\bCREATE\s+TABLE\s+#\w+/gi, masked).map(m => m.index), 'SKILL §3.2');
  const tsc = tempStringCols(masked);
  if (tsc.length) add('R56', SEV.MEDIA, 'Temporales', 'Columnas de texto sin COLLATE en temporales / variables tabla',
    `Columnas: ${tsc.map(x => x.col).join(', ')}.`,
    `Toda columna char/varchar/nchar/nvarchar en #temporales y variables tabla lleva COLLATE ${COLL}.`,
    tsc.map(x => x.idx), 'SKILL §3.2 – Collation obligatorio', true);
  const colP = allMatches(/\bCOLLATE\s+\w+/gi, masked).filter(m => predicateContext(masked, m.index));
  if (colP.length) add('R57', SEV.MEDIA, 'Índices', 'COLLATE en WHERE / JOIN',
    'Impide el uso de índices.', 'No usar COLLATE en predicados (se define en la columna). Si es un JOIN entre bases distintas (DBCMACICA, DBRCC…) NO quitarlo: suele resolver un conflicto real; solo avisar.',
    colP.map(m => m.index), 'SKILL §3 / §6');
  const ctes = allMatches(/(?:\bWITH|,)\s*(\w+)\s*(?:\([^)]*\))?\s+AS\s*\(/gi, masked).filter(m => {
    const open = m.index + m[0].length - 1, close = matchParen(masked, open);
    return close > 0 && !new RegExp('\\b' + m[1] + '\\b', 'i').test(masked.slice(open + 1, close));
  });
  if (ctes.length) add('R58', SEV.INFO, 'Temporales', 'CTE no recursivo',
    ctes.map(m => m[1]).join(', ') + '.', 'Preferir tablas temporales declaradas; CTE solo recursivos o casos muy simples de un solo uso. Al reemplazar, verificar mismo resultado.',
    ctes.map(m => m.index), 'SKILL §3.2');
  const calif = allMatches(/\bCalif_[1-4]\b/gi, masked);
  if (calif.length) add('R59', SEV.MEDIA, 'Negocio', 'Recalcular calificación con Calif_1..Calif_4',
    '', 'En DBRCC (RCCTOTAL / RCCTOTALULT) usar las columnas Calif20 (calificación ≥ 20) y Calif (calificación > 0) en lugar del CASE sobre Calif_1..Calif_4.',
    calif.map(m => m.index), 'SKILL §3 – DBRCC');
  const execs = allMatches(/\bEXEC(?:UTE)?\s+(?!@|\(|sp_executesql|sys\.sp_)((?:\[?\w+\]?\.){0,2}\[?\w+\]?)/gi, masked);
  if (execs.length) add('R61', SEV.INFO, 'Contexto', 'Llama a otros procedimientos',
    [...new Set(execs.map(m => m[1]))].join(', ') + '.', 'No tocar a ciegas lo que depende de esos PAs: pedir su código si el cambio los involucra (regla de oro).',
    execs.map(m => m.index), 'SKILL §0 – Falta de contexto');

  const cStar = allMatches(COUNT_STAR, masked);
  if (cStar.length) add('R62', SEV.BAJA, 'Estándar', 'COUNT(*) en lugar de COUNT(1)',
    `${cStar.length} ocurrencia(s).`, 'Usar COUNT(1) como estándar del área. Es equivalente: ambos cuentan todas las filas, incluidas las que tienen NULL.',
    cStar.map(m => m.index), 'Estándar del área', true);
  const exq = existsSubqueries(masked);
  const exFix = exq.filter(x => x.status === 'fix');
  if (exFix.length) add('R63', SEV.BAJA, 'Estándar', 'EXISTS sin SELECT 1',
    `${exFix.length} subconsulta(s) EXISTS / NOT EXISTS con lista de columnas (${exFix.filter(x => x.isIf).length} en IF EXISTS).`,
    'Escribir IF EXISTS (SELECT 1 FROM … WHERE …). EXISTS solo evalúa si hay filas; la lista de columnas, DISTINCT y TOP n (n ≥ 1) no influyen.',
    exFix.map(x => x.idx), 'Buena práctica del área', true);
  const exAgg = exq.filter(x => x.status === 'agg');
  if (exAgg.length) add('R64', SEV.ALTA, 'Lógica', 'EXISTS con función agregada sin GROUP BY',
    'Un SELECT COUNT/SUM/MAX… sin GROUP BY devuelve siempre una fila, por lo que el EXISTS siempre es verdadero.',
    'No se cambia a SELECT 1 automáticamente porque cambiaría el resultado. Revisar la intención: probablemente debía ser IF EXISTS (SELECT 1 FROM … WHERE …) o IF (SELECT COUNT(1) …) > 0.',
    exAgg.map(x => x.idx), 'Regla de oro – no alterar la lógica');

  const order: Record<string, number> = { Alta: 0, Media: 1, Baja: 2, Info: 3 };
  F.sort((a, b) => order[a.sev] - order[b.sev] || a.id.localeCompare(b.id));
  const w: Record<string, number> = { Alta: 6, Media: 3, Baja: 1, Info: 0 };
  const score = Math.max(0, 100 - F.reduce((s, f) => s + w[f.sev], 0));
  return { findings: F, proc, score, stats: { lines: src.split('\n').length, tables: [...new Set(permRefs.map(r => r.name))], temps: [...new Set(refs.filter(r => r.isTemp).map(r => r.name))] } };
}

// ---------- Correcciones automáticas ----------
const fixes: Record<string, (src: string) => { src: string; count: number }> = {
  trim(src) {
    let count = 0, guard = 0;
    while (guard++ < 500) {
      const { masked } = mask(src);
      const m = /\b(LTRIM\s*\(\s*RTRIM|RTRIM\s*\(\s*LTRIM)\s*\(/i.exec(masked);
      if (!m) break;
      const innerOpen = m.index + m[0].length - 1;
      const innerClose = matchParen(masked, innerOpen);
      if (innerClose < 0) break;
      const ws = /^\s*\)/.exec(masked.slice(innerClose + 1));
      if (!ws) break;
      const outerClose = innerClose + ws[0].length;
      src = src.slice(0, m.index) + 'TRIM(' + src.slice(innerOpen + 1, innerClose) + ')' + src.slice(outerClose + 1);
      count++;
    }
    return { src, count };
  },
  stringAgg(src) {
    let count = 0, guard = 0;
    while (guard++ < 100) {
      const { masked } = mask(src);
      const re = /STUFF\s*\(\s*\(\s*SELECT\s+(N?'[^']*')\s*\+\s*([\s\S]+?)\s+FROM\b([\s\S]*?)\bFOR\s+XML\s+PATH\s*\(\s*N?'\s*'\s*\)\s*\)\s*,\s*1\s*,\s*\d+\s*,\s*N?'\s*'\s*\)/i;
      const m = re.exec(masked);
      if (!m || /\bORDER\s+BY\b|\bTYPE\b/i.test(m[3]) || /\bDISTINCT\b/i.test(masked.slice(m.index, m.index + 60))) break;
      const sepStart = m.index + m[0].indexOf(m[1]);
      const sep = src.slice(sepStart, sepStart + m[1].length);
      const exprStart = m.index + m[0].indexOf(m[2], m[0].indexOf(m[1]) + m[1].length);
      const expr = src.slice(exprStart, exprStart + m[2].length);
      const fromStart = m.index + m[0].search(/\bFROM\b/i);
      const fromBody = src.slice(fromStart, fromStart + 4 + m[3].length).trimEnd();
      src = src.slice(0, m.index) + `(SELECT STRING_AGG(${expr}, ${sep}) ${fromBody})` + src.slice(m.index + m[0].length);
      count++;
    }
    return { src, count };
  },
  sargLeft(src) {
    let count = 0;
    const { masked } = mask(src);
    const ms = allMatches(/\bLEFT\s*\(\s*((?:\[?\w+\]?\.)?\[?[A-Za-z_]\w*\]?)\s*,\s*(\d+)\s*\)\s*=\s*'([^']*)'/gi, masked).reverse();
    for (const m of ms) {
      const lit = (src.slice(m.index, m.index + m[0].length).match(/'([^']*)'\s*$/) || ['', ''])[1];
      if (lit.length !== +m[2] || /[%_\[]/.test(lit) || / $/.test(lit)) continue;
      src = src.slice(0, m.index) + `${m[1]} LIKE '${lit}%'` + src.slice(m.index + m[0].length); count++;
    }
    return { src, count };
  },
  nolockTemp(src) {
    const { masked } = mask(src);
    const edits: any[] = [];
    for (const r of tableRefs(masked)) {
      if (!r.isTemp || !r.groups.length) continue;
      const toks = hintTokens(r.groups);
      if (!toks.some(isNolockTok)) continue;
      edits.push(hintEdit(src, r.groups, toks.filter(t => !isNolockTok(t))));
    }
    return { src: applyEdits(src, edits), count: edits.length };
  },
  nocount(src) {
    const { masked } = mask(src);
    const p = parseProc(src, masked);
    if (!p || p.asIndex < 0 || /\bSET\s+NOCOUNT\s+ON\b/i.test(masked)) return { src, count: 0 };
    let pos = p.asIndex + 2;
    const b = /^\s*BEGIN\b/i.exec(masked.slice(pos));
    if (b) pos += b[0].length;
    src = src.slice(0, pos) + '\n    SET NOCOUNT ON;' + src.slice(pos);
    return { src, count: 1 };
  },
  trailingComma(src) {
    let count = 0;
    const { masked } = mask(src);
    const ms = allMatches(/,(\s*)\)/g, masked).filter(m => {
      const before = masked.slice(Math.max(0, m.index - 600), m.index);
      return /\b(CREATE\s+TABLE|DECLARE\s+@\w+\s+TABLE)\s*[#\w\[\]\.]*\s*\([^;]*$/i.test(before);
    }).reverse();
    for (const m of ms) { src = src.slice(0, m.index) + src.slice(m.index + 1); count++; }
    return { src, count };
  },
  removeCommentedCode(src) {
    const { masked, comments } = mask(src);
    const cc = commentedCode(src, masked, comments).reverse();
    for (const c of cc) {
      let s = c.start, e = c.end;
      const ls = src.lastIndexOf('\n', s - 1) + 1;
      let le = src.indexOf('\n', e); if (le === -1) le = src.length;
      if (src.slice(ls, s).trim() === '' && src.slice(e, le).trim() === '') { s = ls; e = Math.min(le + 1, src.length); }
      else { while (s > 0 && /[ \t]/.test(src[s - 1])) s--; }
      src = src.slice(0, s) + src.slice(e);
    }
    return { src, count: cc.length };
  },
  // Política NOLOCK: exactamente un WITH (NOLOCK) por tabla física que se lee; ninguno en la tabla que se
  // modifica/elimina en UPDATE/DELETE; las tablas unidas en UPDATE/DELETE sí lo llevan.
  addNolock(src) {
    const { masked } = mask(src);
    const edits: any[] = [];
    for (const x of nolockPlan(masked)) {
      const r = x.ref;
      if (r.isTemp) continue;
      const toks = hintTokens(r.groups);
      const hasNl = toks.some(isNolockTok);
      if (needsNolock(x, masked)) {
        if (!r.groups.length) edits.push({ start: r.aliasEnd, end: r.aliasEnd, text: ' WITH (NOLOCK)' });
        else edits.push(hintEdit(src, r.groups, dedupeNolock([...toks, 'NOLOCK'])));
      } else if (x.role === 'target' && (x.dml === 'UPDATE' || x.dml === 'DELETE') && hasNl) {
        edits.push(hintEdit(src, r.groups, toks.filter(t => !isNolockTok(t))));
      } else if (hasNl && hintNeedsNormalize(r.groups)) {
        edits.push(hintEdit(src, r.groups, dedupeNolock(toks)));
      }
    }
    for (const h of dmlHeadHints(masked)) {
      if (h.isTemp) continue;
      const toks = hintTokens(h.groups);
      if (toks.some(isNolockTok)) edits.push(hintEdit(src, h.groups, toks.filter(t => !isNolockTok(t))));
    }
    return { src: applyEdits(src, edits), count: edits.length };
  },
  schemaPrefix(src) {
    let count = 0;
    const { masked } = mask(src);
    const cte = new Set(allMatches(/(?:\bWITH|,)\s*(\w+)\s*(?:\([^)]*\))?\s+AS\s*\(/gi, masked).map(m => m[1].toUpperCase()));
    const refs = tableRefs(masked).filter(r => !r.isTemp && !r.name.includes('.') && !cte.has(r.name.replace(/[\[\]]/g, '').toUpperCase())).reverse();
    for (const r of refs) { src = src.slice(0, r.nameIndex) + 'dbo.' + src.slice(r.nameIndex); count++; }
    return { src, count };
  },
  innerJoin(src) {
    const { masked } = mask(src);
    const ms = allMatches(BARE_JOIN, masked).reverse();
    for (const m of ms) src = src.slice(0, m.index) + (src.slice(m.index, m.index + 4) === 'join' ? 'inner join' : 'INNER JOIN') + src.slice(m.index + 4);
    return { src, count: ms.length };
  },
  selectInto(src) {
    let count = 0, guard = 0; const skipped = new Set();
    while (guard++ < 100) {
      const { masked } = mask(src);
      const list = selectIntos(masked).filter(x => !skipped.has(x.selIdx));
      if (!list.length) break;
      const x = list[0];
      const cols = splitTop(src.slice(x.selIdx + 6, x.intoIdx).replace(/^\s*(DISTINCT\s+)?(TOP\s*\(?\s*\d+\s*\)?\s+)?/i, ''));
      const parsed = cols.map(c => ({ expr: c.trim(), name: colAlias(c) }));
      if (!parsed.length || parsed.some(c => !c.name || /\*$/.test(c.expr))) { skipped.add(x.selIdx); continue; }
      const lineStart = src.lastIndexOf('\n', x.selIdx - 1) + 1;
      const ind = (src.slice(lineStart, x.selIdx).match(/^\s*/) || [''])[0];
      let insertAt = /^\s*$/.test(src.slice(lineStart, x.selIdx)) ? lineStart : x.selIdx;
      const pre = masked.slice(Math.max(0, x.selIdx - 3000), x.selIdx);
      const w = /;?\s*\bWITH\s+\w+\s*(\([^)]*\))?\s*AS\s*\([\s\S]*\)\s*$/i.exec(pre);
      if (w) { const wi = x.selIdx - pre.length + w.index + w[0].search(/WITH/i); insertAt = src.lastIndexOf('\n', wi - 1) + 1; }
      const defs = parsed.map((c, i) => { const t = inferType(c.name, c.expr);
        const coll = STRING_TYPE.test(t.t) ? ` COLLATE ${COLL}` : '';
        return `${ind}    ${c.name} ${t.t}${coll}${i < parsed.length - 1 ? ',' : ''}${t.sure ? '' : ' -- TODO: validar tipo/longitud (scripts de metadatos)'}`; });
      const create = `${ind}CREATE TABLE ${x.table}\n${ind}(\n${defs.join('\n')}\n${ind});\n\n`;
      let s2 = src.slice(0, x.intoIdx) + src.slice(x.intoEnd);
      s2 = s2.replace(/\n[ \t]*\n(?=[ \t]*FROM\b)/i, '\n');
      s2 = s2.slice(0, x.selIdx) + `INSERT INTO ${x.table} (${parsed.map(c => c.name).join(', ')})\n${ind}` + s2.slice(x.selIdx);
      src = s2.slice(0, insertAt) + create + s2.slice(insertAt);
      count++;
    }
    return { src, count };
  },
  closeTran(src) {
    const { masked } = mask(src);
    const begins = allMatches(/\bBEGIN\s+TRAN(?:SACTION)?\b/gi, masked);
    if (!begins.length) return { src, count: 0 };
    const commits = allMatches(/\bCOMMIT\b/gi, masked).length;
    const hasTry = /\bBEGIN\s+TRY\b/i.test(masked), hasRb = /\bROLLBACK\b/i.test(masked);
    if (commits >= begins.length && hasTry && hasRb) return { src, count: 0 };
    const p = parseProc(src, masked);
    let endIdx = masked.length;
    const ends = allMatches(/\bEND\b/gi, masked);
    if (p && /^\s*BEGIN\b/i.test(masked.slice(p.asIndex + 2)) && ends.length) endIdx = ends[ends.length - 1].index;
    const b = begins[0];
    const ls = src.lastIndexOf('\n', b.index - 1) + 1;
    const ind = (src.slice(ls, b.index).match(/^\s*/) || [''])[0];
    if (hasTry) {
      let out = src;
      if (commits < begins.length) {
        const et = allMatches(/\bEND\s+TRY\b/gi, mask(out).masked);
        if (et.length) { const i = et[et.length - 1].index; out = out.slice(0, i) + 'COMMIT TRANSACTION;\n' + ind + out.slice(i); }
      }
      if (!hasRb) {
        const bc = allMatches(/\bBEGIN\s+CATCH\b/gi, mask(out).masked);
        if (bc.length) { const i = bc[bc.length - 1].index + bc[bc.length - 1][0].length; out = out.slice(0, i) + `\n${ind}    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;` + out.slice(i); }
      }
      return { src: out, count: out !== src ? 1 : 0 };
    }
    const body = src.slice(ls, endIdx).replace(/\s+$/, '');
    const indented = body.split('\n').map(l => l.trim() ? '    ' + l : l).join('\n');
    const ci = ind + '    ';
    const tmps = createdTemps(masked);
    const dropC = tmps.length ? `${ind}    DROP TABLE IF EXISTS ${tmps.join(', ')};\n` : '';
    const block = `${ind}BEGIN TRY\n${indented}\n${commits < begins.length ? `${ci}COMMIT TRANSACTION;\n` : ''}${ind}END TRY\n${ind}BEGIN CATCH\n${ind}    IF @@TRANCOUNT > 0\n${ind}        ROLLBACK TRANSACTION;\n${dropC}${ind}    THROW;\n${ind}END CATCH\n`;
    return { src: src.slice(0, ls) + block + src.slice(endIdx), count: 1 };
  },
  singleIn(src) {
    const { masked } = mask(src);
    const ms = allMatches(SINGLE_IN, masked).reverse();
    for (const m of ms) {
      const lit = src.slice(m.index, m.index + m[0].length).replace(/^[\s\S]*?\(\s*/, '').replace(/\s*\)$/, '');
      src = src.slice(0, m.index) + (m[1] ? '<> ' : '= ') + lit + src.slice(m.index + m[0].length);
    }
    return { src, count: ms.length };
  },
  dropIfExists(src) {
    const { masked } = mask(src);
    const list = [...oldDropPatterns(src, masked)].sort((a, b) => b.idx - a.idx);
    for (const x of list) {
      const txt = src.slice(x.idx, x.idx + x.len);
      const semi = /;\s*$/.test(txt) ? ';' : (x.kind === 'objid' ? ';' : '');
      src = src.slice(0, x.idx) + `DROP TABLE IF EXISTS ${x.kind === 'objid' ? x.table : x.table.replace(/\s+/g, ' ')}${semi}` + src.slice(x.idx + x.len);
    }
    return { src, count: list.length };
  },
  throwSemicolon(src) {
    const { masked } = mask(src);
    const list = throwNoSemicolon(masked).reverse();
    for (const x of list) src = src.slice(0, x.at) + ';' + src.slice(x.at);
    return { src, count: list.length };
  },
  collateTemp(src) {
    const { masked } = mask(src);
    const list = tempStringCols(masked).reverse();
    for (const x of list) src = src.slice(0, x.at) + ` COLLATE ${COLL}` + src.slice(x.at);
    return { src, count: list.length };
  },
  countOne(src) {
    const { masked } = mask(src);
    const ms = allMatches(COUNT_STAR, masked).reverse();
    for (const m of ms) src = src.slice(0, m.index) + (src.slice(m.index, m.index + 5) === 'count' ? 'count(1)' : 'COUNT(1)') + src.slice(m.index + m[0].length);
    return { src, count: ms.length };
  },
  existsOne(src) {
    const { masked } = mask(src);
    const list = existsSubqueries(masked).filter(x => x.status === 'fix').reverse();
    for (const x of list) {
      const trail = (x.list.match(/\s*$/) || [''])[0] || ' ';
      src = src.slice(0, x.listStart) + ' 1' + trail + src.slice(x.listEnd);
    }
    return { src, count: list.length };
  },
  upperKeywords(src) {
    const KW = new Set(('select from where join inner left right full cross outer on and or group order by having union all insert into update delete set values as with nolock exists in not null is case when then else end begin if while declare exec execute return top distinct apply option merge using output table procedure proc create alter drop truncate commit rollback tran transaction try catch throw like between over partition asc desc count sum max min avg isnull coalesce convert cast trim ltrim rtrim string_agg string_split concat iif getdate nocount int bigint smallint tinyint bit varchar nvarchar char nchar date datetime decimal numeric money print').split(' '));
    const { masked } = mask(src);
    let count = 0; const out = src.split('');
    for (const m of allMatches(/\b[A-Za-z_]+\b/g, masked)) {
      if (m.index > 0 && /[@#\.\[]/.test(masked[m.index - 1])) continue;
      if (KW.has(m[0].toLowerCase()) && m[0] !== m[0].toUpperCase()) {
        for (let k = 0; k < m[0].length; k++) out[m.index + k] = m[0][k].toUpperCase();
        count++;
      }
    }
    return { src: out.join(''), count };
  }
};

const FIXMETA: Record<string, string[]> = {
  removeCommentedCode: ['Eliminar lógica SQL comentada (cabecera conservada)', 'SKILL §3 – Comentarios / código muerto', 'Es código que no se ejecuta.'],
  trailingComma: ['Quitar coma final en definición de tabla', 'Error de sintaxis', 'Solo corrige sintaxis; no cambia la estructura.'],
  innerJoin: ['JOIN → INNER JOIN', 'Estándar de formato', 'JOIN sin tipo es INNER JOIN en SQL Server.'],
  selectInto: ['SELECT … INTO # → CREATE TABLE + INSERT INTO', 'SKILL §3.2 – Declaración explícita', 'Mismas columnas y filas. Validar tipos marcados con TODO.'],
  collateTemp: [`COLLATE ${COLL} en texto de temporales`, 'SKILL §3.2 – Collation obligatorio', 'Evita conflictos de collation con tempdb; no cambia datos.'],
  closeTran: ['Transacción cerrada con TRY/CATCH, COMMIT, ROLLBACK y THROW', 'Transacción abierta (bloqueos)', 'Mismas sentencias; ante error se revierte y se relanza el error original.'],
  dropIfExists: ['DROP TABLE / IF OBJECT_ID → DROP TABLE IF EXISTS', 'SKILL §6 – Seguras', 'Equivalente directo.'],
  throwSemicolon: ['; antes de THROW', 'SKILL §3 – THROW', 'Evita que THROW se interprete como alias.'],
  singleIn: ['IN (x) / NOT IN (x) → = x / <> x', 'SKILL §3 – Un solo valor (code review senior)', 'Equivalente también con NULL; se respeta el tipo del literal.'],
  trim: ['LTRIM(RTRIM(x)) → TRIM(x)', 'SKILL §3 – Funciones nativas 2019', 'Equivalente directo.'],
  stringAgg: ['STUFF/FOR XML PATH → STRING_AGG', 'SKILL §3 – Funciones nativas 2019', 'Equivalente si los datos no contienen & < > y no superan 8000 bytes.'],
  sargLeft: ["LEFT(col,n) = 'x' → col LIKE 'x%'", 'Predicado SARGable (Index Seek)', 'Mismo filtro: prefijo exacto de n caracteres.'],
  nolockTemp: ['Quitar WITH (NOLOCK) de temporales', 'SKILL §3.1 – # y @ no llevan NOLOCK', 'El hint no tiene efecto en temporales.'],
  schemaPrefix: ['Agregar esquema dbo.', 'Calificar objetos', 'Mismo objeto si el esquema por defecto es dbo.'],
  addNolock: ['Política WITH (NOLOCK): uno por tabla física', 'Política NOLOCK del área', 'Solo cambia hints: agrega NOLOCK en lecturas que no lo tienen, deja uno solo por tabla y lo quita de la tabla que se modifica en UPDATE/DELETE (SQL Server lo ignora ahí).'],
  nocount: ['SET NOCOUNT ON', 'Solo PA nuevo', 'No aplicar a PA existente.'],
  upperKeywords: ['Palabras reservadas en MAYÚSCULA', 'SKILL §5 – Formato', 'Solo formato.'],
  countOne: ['COUNT(*) → COUNT(1)', 'Estándar del área', 'Equivalente: ambos cuentan todas las filas.'],
  existsOne: ['EXISTS (SELECT …) → EXISTS (SELECT 1 …)', 'Buena práctica del área', 'EXISTS solo evalúa si hay filas; se omiten los casos con agregado sin GROUP BY, UNION o TOP 0.']
};
export function optimize(src: string, opts: OptimizeOptions, plan?: PlanAnalysis | null): OptimizeResult {
  const pf = applyPlanFixes(src, plan, opts || {});
  src = pf.src;
  const applied = [...pf.applied];
  const run = (key) => { const r = fixes[key](src); if (r.count) { const m = FIXMETA[key]; applied.push({ key, label: `${m[0]} (${r.count})`, count: r.count, motivo: m[1], seguro: m[2] }); } src = r.src; };
  if (opts.removeComments) run('removeCommentedCode');
  if (opts.trailingComma) run('trailingComma');
  if (opts.innerJoin) run('innerJoin');
  if (opts.selectInto) run('selectInto');
  if (opts.closeTran) run('closeTran');
  if (opts.collateTemp) run('collateTemp');
  if (opts.dropIfExists) run('dropIfExists');
  if (opts.singleIn) run('singleIn');
  if (opts.countOne) run('countOne');
  if (opts.existsOne) run('existsOne');
  if (opts.trim) run('trim');
  if (opts.stringAgg) run('stringAgg');
  if (opts.sarg) run('sargLeft');
  if (opts.nolockTemp) run('nolockTemp');
  if (opts.schema) run('schemaPrefix');
  if (opts.addNolock) run('addNolock');
  if (opts.nocount) run('nocount');
  if (opts.upper) run('upperKeywords');
  if (opts.throwSemicolon) run('throwSemicolon');
  if (opts.reviewNotes) {
    const a = analyze(src);
    const lines = src.split('\n');
    const notes: Record<number, string[]> = {};
    a.findings.filter(f => !f.autofix && f.sev !== 'Info').forEach(f => f.lines.forEach(l => { (notes[l] = notes[l] || []).push(`${f.id} ${f.title}`); }));
    Object.keys(notes).map(Number).sort((x, y) => y - x).forEach(l => {
      const ind = (lines[l - 1].match(/^\s*/) || [''])[0];
      lines.splice(l - 1, 0, `${ind}-- [REVISAR] ${[...new Set(notes[l])].join(' | ')}`);
    });
    src = lines.join('\n');
    if (Object.keys(notes).length) applied.push({ key: 'notes', label: `Notas -- [REVISAR] insertadas (${Object.keys(notes).length})`, motivo: 'Ayuda de revisión', seguro: 'Solo comentarios.' });
  }
  return { src, applied, planFixed: pf.fixed };
}

export function dictionary(src: string): string {
  const { masked } = mask(src);
  const p = parseProc(src, masked);
  if (!p) return '-- No se encontró CREATE/ALTER PROCEDURE en el script.';
  const sch = p.schema || 'dbo';
  const blk = (lvl2t, lvl2n, desc) => `IF NOT EXISTS (\n    SELECT 1\n    FROM sys.fn_listextendedproperty(\n        N'MS_Description', N'SCHEMA', N'${sch}',\n        N'PROCEDURE', N'${p.name}', ${lvl2t ? `N'${lvl2t}', N'${lvl2n}'` : 'NULL, NULL'})\n)\n    EXEC sys.sp_addextendedproperty\n        @name = N'MS_Description',\n        @value = N'${desc}',\n        @level0type = N'SCHEMA', @level0name = N'${sch}',\n        @level1type = N'PROCEDURE', @level1name = N'${p.name}'${lvl2t ? `,\n        @level2type = N'${lvl2t}', @level2name = N'${lvl2n}'` : ''};\nGO\n\n`;
  let s = `-- Diccionario de datos (idempotente): ${sch}.${p.name}\n`;
  s += blk(null, null, '<Describir con detalle la función que cumple el procedimiento en el proyecto/módulo>');
  p.params.forEach(pr => { s += blk('PARAMETER', pr.name, `<Descripción de ${pr.name} (${pr.type})${pr.out ? ' - OUTPUT' : ''}. Si es opción, listar valores o tabla de origen>`); });
  s += `-- Para cambiar una descripción existente: sys.sp_updateextendedproperty con los mismos niveles.\n`;
  return s;
}

export function metadataScripts(src: string): string {
  const { masked } = mask(src);
  const p = parseProc(src, masked);
  const tables = [...new Set(tableRefs(masked).filter(r => !r.isTemp).map(r => r.name.replace(/[\[\]]/g, '').split('.').pop()))];
  const pn = p ? `${p.schema || 'dbo'}.${p.name}` : '<Esquema>.<NombrePA>';
  return `-- Paso 1: objetos que usa el PA (tablas, funciones, otros PAs, incluso de otras bases)\nSELECT DISTINCT\n    ISNULL(D.referenced_database_name, DB_NAME()) AS cBaseDatos,\n    ISNULL(D.referenced_schema_name, 'dbo') AS cEsquema,\n    D.referenced_entity_name AS cObjeto\nFROM sys.sql_expression_dependencies AS D\nWHERE D.referencing_id = OBJECT_ID(N'${pn}');\n\n-- Paso 2: columnas de esas tablas (ejecutar en cada base del paso 1)\nSELECT\n    C.TABLE_SCHEMA,\n    C.TABLE_NAME,\n    C.COLUMN_NAME,\n    C.DATA_TYPE,\n    C.CHARACTER_MAXIMUM_LENGTH,\n    C.NUMERIC_PRECISION,\n    C.NUMERIC_SCALE,\n    C.IS_NULLABLE,\n    C.COLLATION_NAME\nFROM INFORMATION_SCHEMA.COLUMNS AS C\nWHERE C.TABLE_NAME IN (${tables.length ? tables.map(t => `N'${t}'`).join(', ') : "N'<Tabla1>', N'<Tabla2>'"})\nORDER BY C.TABLE_NAME, C.ORDINAL_POSITION;\n-- CHARACTER_MAXIMUM_LENGTH = -1 significa MAX.\n`;
}


// =====================================================================
//  PLAN DE EJECUCIÓN (.sqlplan / Showplan XML)
// =====================================================================
const XML_ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function xmlDecode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : (XML_ENT[e] !== undefined ? XML_ENT[e] : m));
}
// Parser XML mínimo (sin dependencias) suficiente para Showplan
function parseXml(xml) {
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m, count = 0;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (!m[2]) continue;
    const attrs: Record<string, string> = {};
    const are = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let a;
    while ((a = are.exec(m[3])) !== null) attrs[a[1].split(':').pop()] = xmlDecode(a[2] !== undefined ? a[2] : a[3]);
    const node: XNode = { name: m[2].split(':').pop() || '', attrs, children: [] };
    stack[stack.length - 1].children.push(node); count++;
    if (!m[4]) stack.push(node);
  }
  return { root, count };
}
const xAll = (node: any, name: string, out: any[] = []): any[] => { for (const c of node.children) { if (c.name === name) out.push(c); xAll(c, name, out); } return out; };
const xKid = (node: any, name: string): any => node.children.find(c => c.name === name) || null;
const xNum = (v: any): number | null => (v === undefined || v === null || v === '' ? null : Number(v));
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmtKB = (kb: number | null) => kb == null ? '—' : kb >= 1048576 ? (kb / 1048576).toFixed(2) + ' GB' : kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB';
const fmtN = (n: number | null) => n == null ? '—' : Math.round(n).toLocaleString('es-PE');

/** Decodifica los bytes de un .sqlplan (SSMS suele guardarlos en UTF-16). */
export function decodePlanBytes(bytes: Uint8Array): string {
  let enc = 'utf-8';
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) enc = 'utf-16le';
  else if (bytes[0] === 0xFE && bytes[1] === 0xFF) enc = 'utf-16be';
  else if (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0) enc = 'utf-16le';
  else if (bytes.length > 3 && bytes[0] === 0 && bytes[2] === 0) enc = 'utf-16be';
  return new TextDecoder(enc).decode(bytes).replace(/^\uFEFF/, '');
}

// Ubica el texto de una sentencia del plan dentro del procedimiento (ignora espacios y mayúsculas)
function locateInSource(src, text) {
  if (!src || !text) return -1;
  const map: any[] = []; let ns = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/\s/.test(ch)) { if (ns.length && ns[ns.length - 1] !== ' ') { ns += ' '; map.push(i); } }
    else { ns += ch.toUpperCase(); map.push(i); }
  }
  const t = text.replace(/\s+/g, ' ').trim().toUpperCase();
  for (const len of [120, 70, 40]) {
    const k = t.slice(0, Math.min(len, t.length));
    if (k.length < 12) break;
    const p = ns.indexOf(k);
    if (p >= 0) { let q = map[p]; while (q < src.length && /\s/.test(src[q])) q++; return q; }
  }
  return -1;
}

// "[DB].[dbo].[Tabla].[Col] as [A].[Col]" → partes
function parseColRef(s) {
  const [main, alias] = s.split(/\s+as\s+/i);
  const parts = (main.match(/\[[^\]]*\]/g) || []).map(p => p.slice(1, -1));
  const aparts = alias ? (alias.match(/\[[^\]]*\]/g) || []).map(p => p.slice(1, -1)) : [];
  const column = parts[parts.length - 1] || '';
  const table = (parts.length >= 2 ? parts[parts.length - 2] : '').replace(/_{3,}[0-9A-F]*$/i, '');
  return { table, column, alias: aparts.length >= 2 ? aparts[aparts.length - 2] : '', db: parts.length >= 4 ? parts[0] : '',
    isVar: parts.length === 1 && /^@/.test(column), isTemp: /^#/.test(table), isTableVar: /^@/.test(table) };
}
const CONV_RE = /CONVERT_IMPLICIT\(\s*([a-z0-9_]+(?:\s*\(\s*(?:\d+|max)\s*(?:,\s*\d+\s*)?\))?)\s*,\s*((?:\[[^\]]*\]\.?)+(?:\s+as\s+(?:\[[^\]]*\]\.?)+)?)\s*,\s*\d+\s*\)/gi;

// Columnas de #temporales y variables tabla: { '#t': { col: {type, typeStart} } }
function tableColumnDefs(masked) {
  const res: Record<string, Record<string, any>> = {};
  for (const m of allMatches(/\b(?:CREATE\s+TABLE\s+(#\w+)|DECLARE\s+(@\w+)\s+(?:AS\s+)?TABLE)\s*\(/gi, masked)) {
    const name = (m[1] || m[2]).toLowerCase();
    const open = m.index + m[0].length - 1, close = matchParen(masked, open);
    if (close < 0) continue;
    const cols = res[name] = res[name] || {};
    for (const d of allMatches(/(?:\(|,)\s*\[?(\w+)\]?\s+((?:N?VARCHAR|N?CHAR|VARCHAR|CHAR|\w+)(?:\s*\(\s*(?:\d+|MAX)\s*(?:,\s*\d+\s*)?\))?)/gi, masked.slice(open, close + 1))) {
      if (/^(CONSTRAINT|PRIMARY|UNIQUE|INDEX)$/i.test(d[1])) continue;
      const typeStart = open + d.index + d[0].length - d[2].length;
      cols[d[1].toLowerCase()] = { type: d[2], typeStart, typeEnd: typeStart + d[2].length };
    }
  }
  return res;
}
// Variables locales DECLARE @x NVARCHAR(..) (fuera de la cabecera del PA)
function localDeclares(masked, proc) {
  const res: Record<string, any> = {};
  for (const m of allMatches(/(?:\bDECLARE\s+|,\s*)(@\w+)\s+(?:AS\s+)?((?:N?VARCHAR|N?CHAR|\w+)(?:\s*\(\s*(?:\d+|MAX)\s*(?:,\s*\d+\s*)?\))?)/gi, masked)) {
    if (proc && m.index > proc.index && m.index < (proc.asIndex > 0 ? proc.asIndex : proc.index)) continue;
    if (/^TABLE$/i.test(m[2])) continue;
    const typeStart = m.index + m[0].length - m[2].length;
    res[m[1].toLowerCase()] = { type: m[2], typeStart };
  }
  return res;
}
function bodyInsertPos(masked, proc) {
  if (!proc || proc.asIndex < 0) return -1;
  let pos = proc.asIndex + 2;
  const b = /^\s*BEGIN\b/i.exec(masked.slice(pos)); if (b) pos += b[0].length;
  const nc = /^\s*SET\s+NOCOUNT\s+ON\s*;?/i.exec(masked.slice(pos)); if (nc) pos += nc[0].length;
  return pos;
}
// Comparaciones de la columna convertida con otro operando en el código
function columnComparisons(masked, conv) {
  const col = escRe(conv.column);
  const colPat = conv.alias ? `\\b${escRe(conv.alias)}\\s*\\.\\s*\\[?${col}\\]?(?![\\w.])` : `(?<![\\w.@#])(?:\\[?\\w+\\]?\\s*\\.\\s*)?\\[?${col}\\]?(?![\\w.])`;
  const OPND = String.raw`(@\w+(?![\w.])|N'[^']*'|\[?[#@]?\w+\]?\s*\.\s*\[?\w+\]?)`;
  const OP = String.raw`\s*(?:=|<>|!=|>=|<=|>|<)\s*`;
  const res: any[] = [];
  for (const m of allMatches(new RegExp(colPat + OP + OPND, 'gi'), masked)) res.push({ other: m[1], otherIdx: m.index + m[0].length - m[1].length, idx: m.index });
  for (const m of allMatches(new RegExp(OPND + OP + colPat, 'gi'), masked)) res.push({ other: m[1], otherIdx: m.index, idx: m.index });
  return res;
}
// Ediciones que eliminan una conversión implícita (solo casos equivalentes: unicode → no unicode)
function convertEdits(src, masked, conv, extParams?: any[]) {
  const out: { edits: any[]; decls: any[]; notes: string[] } = { edits: [], decls: [], notes: [] };
  if (!/^n(var)?char/i.test(conv.type)) return out;
  const proc = parseProc(src, masked);
  const declared = localDeclares(masked, proc);
  const tdefs = tableColumnDefs(masked);
  const refs = tableRefs(masked);
  const seen = new Set();
  for (const c of columnComparisons(masked, conv)) {
    const o = c.other.replace(/\s+/g, '');
    if (o[0] === '@' && !o.includes('.')) {
      const p = (proc && proc.params.find(x => x.name.toLowerCase() === o.toLowerCase())) || (!proc && extParams ? extParams.find(x => x.name.toLowerCase() === o.toLowerCase()) : null);
      if (p && /^N(VAR)?CHAR/i.test(p.type)) {
        const local = o + 'Local';
        out.edits.push({ start: c.otherIdx, end: c.otherIdx + o.length, text: local });
        if (!out.decls.some(d => d.name === local)) out.decls.push({ name: local, type: p.type.replace(/^N/i, '').toUpperCase(), param: o });
        out.notes.push(`variable local ${local} ${p.type.replace(/^N/i, '').toUpperCase()} (sin cambiar la firma)`);
      } else if (declared[o.toLowerCase()] && /^N(VAR)?CHAR/i.test(declared[o.toLowerCase()].type)) {
        const d = declared[o.toLowerCase()];
        if (!seen.has(d.typeStart)) { seen.add(d.typeStart); out.edits.push({ start: d.typeStart, end: d.typeStart + 1, text: '' }); out.notes.push(`${o} declarada como ${d.type.slice(1).toUpperCase()}`); }
      }
    } else if (/^N'/i.test(o)) {
      const lit = src.slice(c.otherIdx, c.otherIdx + c.other.length);
      if (/^N'[\x00-\xFF]*'$/i.test(lit)) { out.edits.push({ start: c.otherIdx, end: c.otherIdx + 1, text: '' }); out.notes.push(`literal ${lit.slice(1)} sin prefijo N`); }
    } else {
      const [al, cn] = o.split('.').map(x => x.replace(/[\[\]]/g, ''));
      const ref = refs.find(r => (r.alias && r.alias.replace(/[\[\]]/g, '').toLowerCase() === al.toLowerCase()) || r.name.replace(/[\[\]]/g, '').toLowerCase() === al.toLowerCase());
      const tname = ref ? ref.name.replace(/[\[\]]/g, '').toLowerCase() : (/^[#@]/.test(al) ? al.toLowerCase() : '');
      const def = tname && tdefs[tname] && tdefs[tname][cn.toLowerCase()];
      if (def && /^N(VAR)?CHAR/i.test(def.type) && !seen.has(def.typeStart)) {
        seen.add(def.typeStart);
        out.edits.push({ start: def.typeStart, end: def.typeStart + 1, text: '' });
        out.notes.push(`${tname}.${cn} definida como ${def.type.slice(1).toUpperCase()}`);
      }
    }
  }
  return out;
}
function applyConvert(src, conv, extParams?: any[]) {
  const { masked } = mask(src);
  const r = convertEdits(src, masked, conv, extParams);
  if (!r.edits.length) return { src, count: 0, notes: [] };
  const proc = parseProc(src, masked);
  const edits = [...r.edits];
  const pos = bodyInsertPos(masked, proc);
  const newDecl = r.decls.filter(d => !new RegExp('\\bDECLARE\\s+' + escRe(d.name) + '\\b', 'i').test(masked));
  if (newDecl.length) {
    if (!proc) edits.push({ start: 0, end: 0, text: newDecl.map(d => `DECLARE ${d.name} ${d.type} = ${d.param}; -- Plan: evita CONVERT_IMPLICIT sobre ${conv.table}.${conv.column} (validar tipo exacto de la columna)\n`).join('') });
    else if (pos < 0) return { src, count: 0, notes: [] };
    else edits.push({ start: pos, end: pos, text: newDecl.map(d => `\n    DECLARE ${d.name} ${d.type} = ${d.param}; -- Plan: evita CONVERT_IMPLICIT sobre ${conv.table}.${conv.column} (validar tipo exacto de la columna)`).join('') });
  }
  return { src: applyEdits(src, edits), count: 1, notes: r.notes };
}

// Quita ORDER BY de un INSERT INTO #temporal cuyo Sort aparece en el plan
function insertOrderByEdit(src, masked, at, sortCols) {
  const st = statements(masked).filter(x => x.start <= at && at < x.end).pop();
  if (!st || st.type !== 'INSERT') return null;
  const body = masked.slice(st.start, st.end);
  const tm = /^INSERT\s+(?:INTO\s+)?(#\w+)/i.exec(body);
  if (!tm) return null;
  let depth = 0, ob = -1, stop = -1;
  for (const t of allMatches(/[()]|\bORDER\s+BY\b|\bTOP\b|\bOFFSET\b|\bOPTION\b/gi, body)) {
    if (t[0] === '(') { depth++; continue; }
    if (t[0] === ')') { depth--; continue; }
    if (depth !== 0) continue;
    const w = t[0].toUpperCase();
    if (w === 'TOP' || w === 'OFFSET') return null;
    if (/^ORDER/.test(w)) ob = t.index;
    if (w === 'OPTION' && ob >= 0) stop = t.index;
  }
  if (ob < 0) return null;
  const def = new RegExp('\\bCREATE\\s+TABLE\\s+' + escRe(tm[1]) + '\\s*\\(', 'i').exec(masked);
  if (def) { const c = matchParen(masked, def.index + def[0].length - 1); if (/\bIDENTITY\b/i.test(masked.slice(def.index, c))) return null; }
  if (new RegExp('\\bALTER\\s+TABLE\\s+' + escRe(tm[1]) + '\\b[^;]*\\bIDENTITY\\b', 'i').test(masked)) return null;
  let end = stop >= 0 ? stop : body.length;
  const clause = body.slice(ob, end);
  if (sortCols && sortCols.length && !sortCols.some(c => new RegExp('\\b' + escRe(c) + '\\b', 'i').test(clause))) return null;
  let s0 = st.start + ob; while (s0 > 0 && /\s/.test(masked[s0 - 1])) s0--;
  let e0 = st.start + end; while (e0 > s0 && /\s/.test(masked[e0 - 1])) e0--;
  if (masked[e0 - 1] === ';') e0--;
  return { start: s0, end: e0, text: '' };
}
// VARCHAR(MAX) en temporales / variables tabla → VARCHAR(2000) (sobreestimación de memoria)
function maxColumnEdits(masked) {
  const edits: any[] = [];
  for (const [, cols] of Object.entries(tableColumnDefs(masked)))
    for (const d of Object.values(cols))
      if (/^N?VARCHAR\s*\(\s*MAX\s*\)$/i.test(d.type))
        edits.push({ start: d.typeStart, end: d.typeEnd, text: d.type.replace(/\(\s*MAX\s*\)/i, '(2000)') + ' /* TODO: validar longitud máxima real (plan: sobreestimación de memoria) */' });
  return edits;
}

// ---------- Propuestas de mejora del plan ----------
function planTables(node) {
  const out = new Map<string, any>();
  for (const o of xAll(node, 'Object')) {
    const t = (o.attrs.Table || '').replace(/[\[\]]/g, '').replace(/_{3,}[0-9A-F]*$/i, '');
    if (!t || /^[#@]/.test(t) || /tempdb/i.test(o.attrs.Database || '')) continue;
    const sch = (o.attrs.Schema || '[dbo]').replace(/[\[\]]/g, '');
    const db = (o.attrs.Database || '').replace(/[\[\]]/g, '');
    out.set(`${db}.${sch}.${t}`.toLowerCase(), { schema: sch, table: t, db });
  }
  return [...out.values()];
}
function statsScript(tables) {
  return tables.map(t => `${t.db ? `USE [${t.db}];\n` : ''}UPDATE STATISTICS [${t.schema}].[${t.table}] WITH FULLSCAN;`).join('\n');
}
function parentMap(root) {
  const m = new Map<any, any>();
  (function walk(n) { for (const c of n.children) { m.set(c, n); walk(c); } })(root);
  return m;
}
/** Fragmento "-- Antes / -- Después" con solo las líneas que cambian. */
function changedSnippet(a, b) {
  if (a === b) return '';
  const A = a.replace(/\r/g, '').split('\n'), B = b.replace(/\r/g, '').split('\n');
  const sa = new Set(A.map(x => x.trim())), sb = new Set(B.map(x => x.trim()));
  const del = A.filter(x => x.trim() && !sb.has(x.trim())).slice(0, 8);
  const ad = B.filter(x => x.trim() && !sa.has(x.trim())).slice(0, 10);
  const dedent = (t: string[]) => { if (!t.length) return t; const ind = Math.min(...t.map(x => (x.match(/^\s*/) || [''])[0].length)); return t.map(x => x.slice(ind)); };
  return `-- Antes\n${dedent(del).join('\n') || '(sin líneas eliminadas)'}\n-- Después\n${dedent(ad).join('\n') || '(se elimina)'}`;
}
const idxName = (t, cols) => `IX_${t}_${cols.map(c => c.replace(/[\[\]]/g, '')).slice(0, 3).join('_')}`;

/**
 * Analiza un Showplan XML. Si se envía el código del PA, ubica cada hallazgo en sus líneas
 * y calcula qué correcciones se pueden aplicar.
 */
export function analyzePlan(xml: string, src?: string): PlanAnalysis {
  const F: Finding[] = [];
  const res: PlanAnalysis = { ok: false, error: '', build: '', isActual: false, statements: [], findings: F, missingIndexes: [], fixes: { converts: [], convertsAll: [], sorts: [], excessiveGrant: false } };
  if (!xml || !xml.trim()) { res.error = 'Plan vacío.'; return res; }
  let doc: { root: XNode; count: number };
  try { doc = parseXml(xml); } catch (e) { res.error = 'No se pudo leer el XML.'; return res; }
  const showplan = xAll(doc.root, 'ShowPlanXML')[0];
  if (!showplan) { res.error = 'El archivo no es un plan de ejecución de SQL Server (falta <ShowPlanXML>). Guárdalo desde SSMS con "Guardar plan de ejecución como…" (.sqlplan).'; return res; }
  res.ok = true;
  res.build = showplan.attrs.Build || '';
  src = src || '';
  const masked = src ? mask(src).masked : '';
  const add = (key, id, sev, cat, title, detail, rec, lines, ref, autofix = false, extra = {}) =>
    F.push(Object.assign({ key, id, sev, cat, title, detail, rec, lines: uniq(lines.filter(l => l > 0)), ref, autofix, source: 'plan' as const }, extra));
  const sts = src ? statements(masked) : [];
  const colLines = (names, at) => {
    if (!src || !names.length || at < 0) return [];
    const st = sts.filter(x => x.start <= at && at < x.end).pop();
    if (!st) return [];
    const seg = masked.slice(st.start, st.end), out: any[] = [];
    for (const n of names) for (const m of allMatches(new RegExp('\\b' + escRe(n) + '\\b', 'gi'), seg)) out.push(lineOf(src, st.start + m.index));
    return out;
  };

  const stmts = xAll(showplan, 'StmtSimple').filter(s => xKid(s, 'QueryPlan'));
  stmts.forEach((s, si) => {
    const qp = xKid(s, 'QueryPlan');
    const a = s.attrs;
    const n = si + 1;
    const text = (a.StatementText || '').trim();
    const at = locateInSource(src, text);
    const line = at >= 0 ? lineOf(src, at) : 0;
    const L = line ? [line] : [];
    const short = text.replace(/\s+/g, ' ').slice(0, 90) + (text.length > 90 ? '…' : '');
    const where = `Sentencia ${n}${line ? ` (línea ${line})` : ''}`;
    const mg = xKid(qp, 'MemoryGrantInfo');
    const g = mg ? mg.attrs : {};
    const qts = xKid(qp, 'QueryTimeStats');
    const st: any = { n, type: a.StatementType || '', text: short, fullText: text, line, at, cost: xNum(a.StatementSubTreeCost), estRows: xNum(a.StatementEstRows),
      grantedKB: xNum(g.GrantedMemory), usedKB: xNum(g.MaxUsedMemory), desiredKB: xNum(g.SerialDesiredMemory) ?? xNum(qp.attrs.MemoryGrant),
      waitMs: xNum(g.GrantWaitTime), elapsedMs: qts ? xNum(qts.attrs.ElapsedTime) : null, cpuMs: qts ? xNum(qts.attrs.CpuTime) : null,
      dop: xNum(qp.attrs.DegreeOfParallelism), spills: 0, converts: 0, warnings: 0, timeout: a.StatementOptmEarlyAbortReason === 'TimeOut' };
    const pl = xKid(qp, 'ParameterList');
    st.params = pl ? pl.children.filter(c => c.name === 'ColumnReference' && c.attrs.Column).map(c => ({
      name: c.attrs.Column, type: (c.attrs.ParameterDataType || '').toUpperCase(),
      compiled: c.attrs.ParameterCompiledValue, runtime: c.attrs.ParameterRuntimeValue })) : [];
    res.statements.push(st);
    const parents = parentMap(qp);
    const stTables = planTables(qp);

    // --- Parameter sniffing ---
    const sniff = st.params.filter(p => p.compiled != null && p.runtime != null && p.compiled !== p.runtime);
    if (sniff.length) add(`P14|${n}`, 'P14', 'Media', 'Plan · Parámetros', 'Plan compilado con otros valores de parámetros (parameter sniffing)',
      `${where}: ${sniff.map(p => `${p.name} compilado con ${p.compiled} y ejecutado con ${p.runtime}`).join('; ')}.`,
      'Si el rendimiento cambia mucho según el valor, el plan reutilizado no es el adecuado para todos los casos.', L, 'Plan – ParameterCompiledValue vs ParameterRuntimeValue', false,
      { stmt: n, proposal: { text: 'Comparar el plan con ambos valores. Si los volúmenes son muy distintos, separar en consultas por escenario (IF … ELSE) para que cada una tenga su plan. No agregar OPTION (RECOMPILE) ni OPTIMIZE FOR sin aprobación del DBA (SKILL: sin hints).' } });

    // --- RelOps ---
    const relops = xAll(qp, 'RelOp');
    const actualOf = r => {
      const rti = xKid(r, 'RunTimeInformation');
      if (!rti) return null;
      res.isActual = true;
      let rows = 0, execs = 0, read = 0, hasRead = false;
      for (const t of rti.children.filter(c => c.name === 'RunTimeCountersPerThread')) {
        rows += xNum(t.attrs.ActualRows) || 0; execs = Math.max(execs, xNum(t.attrs.ActualExecutions) || 0);
        if (t.attrs.ActualRowsRead !== undefined) { hasRead = true; read += xNum(t.attrs.ActualRowsRead) || 0; }
      }
      return { rows, execs, read: hasRead ? read : null };
    };
    const opCols = r => {
      const cols = new Set();
      for (const c of xAll(r, 'ColumnReference')) if (c.attrs.Column && !/^(@|Expr|Bmk|Chk|Uniq)/i.test(c.attrs.Column)) cols.add(c.attrs.Column);
      return [...cols];
    };
    const deviations: any[] = [];
    for (const r of relops) {
      const ra = r.attrs, op = ra.PhysicalOp || '', node = ra.NodeId;
      const act = actualOf(r);
      const est = xNum(ra.EstimateRows);
      const w = xKid(r, 'Warnings');
      // Spills
      if (w) {
        const spill = xKid(w, 'SpillToTempDb');
        const sd = xKid(w, 'SortSpillDetails') || xKid(w, 'HashSpillDetails') || xKid(w, 'ExchangeSpillDetails');
        if (spill || sd) {
          st.spills++;
          let cols: any[] = [];
          if (op.includes('Sort')) { const ob = xAll(r, 'OrderBy')[0]; if (ob) cols = xAll(ob, 'ColumnReference').map(c => c.attrs.Column).filter(Boolean); }
          else if (op.includes('Hash')) { const hk = xAll(r, 'HashKeysBuild')[0] || xAll(r, 'HashKeysProbe')[0]; if (hk) cols = xAll(hk, 'ColumnReference').map(c => c.attrs.Column).filter(Boolean); }
          const sda = sd ? sd.attrs : {};
          const det = `${where}: ${op} (nodo ${node}) derramó a tempdb${spill && spill.attrs.SpillLevel ? ` — nivel ${spill.attrs.SpillLevel}` : ''}` +
            `${sda.WritesToTempDb ? `, ${fmtN(xNum(sda.WritesToTempDb))} páginas escritas` : ''}` +
            `${sda.GrantedMemoryKb ? `. Memoria del operador: ${fmtKB(xNum(sda.GrantedMemoryKb))} concedidos / ${fmtKB(xNum(sda.UsedMemoryKb))} usados` : ''}` +
            `${act && est != null ? `. Filas estimadas ${fmtN(est * Math.max(1, act.execs))} vs reales ${fmtN(act.rows)}` : ''}.`;
          let fixable = false;
          if (op === 'Sort' && src && at >= 0 && /^INSERT$/i.test(st.type)) fixable = !!insertOrderByEdit(src, masked, at, cols);
          let snip = '';
          if (op === 'Sort' && /^INSERT/i.test(st.type)) { const e = insertOrderByEdit(text, mask(text).masked, 0, cols); if (e) snip = changedSnippet(text, applyEdits(text, [e])); }
          if (op === 'Sort') res.fixes.sorts.push({ at, cols, stmt: n, node, key: `P01|${n}|${node}` });
          const spT = planTables(r);
          const proposal = op === 'Sort' && snip
            ? { text: 'Quitar el ORDER BY del INSERT a la temporal: el orden de inserción no se garantiza y elimina el Sort que derrama. Ordenar solo en el SELECT final.', sql: snip }
            : { text: `Reducir las filas que llegan al ${op} (filtrar antes en una #temporal, sin columnas innecesarias) y actualizar estadísticas de las tablas que alimentan la estimación (${fmtN(est)} estimadas).`, sql: statsScript(spT) };
          const rec = op.includes('Sort')
            ? 'El Sort no tuvo memoria suficiente (estimación de filas baja). ' + (fixable ? 'Se quita el ORDER BY del INSERT a la temporal (el orden de inserción no se garantiza y la temporal no tiene IDENTITY). ' : 'Evitar ordenar si no es necesario (ordenar solo en el SELECT final). ') + 'Filtrar antes de ordenar, actualizar estadísticas de las tablas involucradas y corregir predicados no SARGables o conversiones que distorsionan la estimación.'
            : op.includes('Hash') ? 'El Hash Match no tuvo memoria suficiente: reducir filas antes del JOIN/GROUP BY (filtrar primero en una temporal), corregir estimaciones (estadísticas, conversiones implícitas, funciones sobre columnas) y evaluar un índice que permita Nested Loops / Merge.'
            : 'Spill en un operador de paralelismo: revisar el desbalance de filas entre hilos y las estimaciones; normalmente se corrige al mejorar la estimación de filas.';
          add(`P01|${n}|${node}`, 'P01', 'Alta', 'Plan · Spill (crítico)', `⚠ Spill a tempdb en ${op}`, det, rec, L, 'Plan real – SpillToTempDb', fixable || !!snip, { stmt: n, proposal });
        }
        if (w.attrs.NoJoinPredicate === 'true' || w.attrs.NoJoinPredicate === '1') {
          st.warnings++;
          add(`P10|${n}|${node}`, 'P10', 'Alta', 'Plan · Lógica', 'JOIN sin predicado (producto cartesiano)', `${where}: ${op} (nodo ${node}) sin condición de unión.`,
            'Revisar las condiciones ON / JOIN implícitos con comas: falta relacionar tablas. Verificar que el resultado esperado no dependa del producto cartesiano.', L, 'Plan – NoJoinPredicate', false,
            { stmt: n, proposal: { text: 'Escribir todos los JOIN con INNER JOIN … ON y relacionar cada tabla con su clave. Si el producto cartesiano es intencional (p. ej. una sola fila de parámetros), usar CROSS JOIN explícito.' } });
        }
        const cns = xKid(w, 'ColumnsWithNoStatistics');
        if (cns) {
          const crefs = xAll(cns, 'ColumnReference');
          const cols = crefs.map(c => `${(c.attrs.Table || '').replace(/[\[\]]/g, '')}.${c.attrs.Column}`);
          const sql = crefs.map(c => { const t = (c.attrs.Table || '').replace(/[\[\]]/g, ''), sc = (c.attrs.Schema || '[dbo]').replace(/[\[\]]/g, ''), cn = (c.attrs.Column || '').replace(/[\[\]]/g, '');
            return `CREATE STATISTICS ST_${t}_${cn} ON [${sc}].[${t}] ([${cn}]) WITH FULLSCAN;`; }).join('\n');
          add(`P12|${n}|${node}`, 'P12', 'Baja', 'Plan · Estadísticas', 'Columnas sin estadísticas', `${where}: ${cols.join(', ')}.`,
            'Sin estadísticas el optimizador adivina la cantidad de filas.', L, 'Plan – ColumnsWithNoStatistics', false,
            { stmt: n, proposal: { text: 'Crear las estadísticas (validar con el DBA si AUTO_CREATE_STATISTICS está desactivado):', sql } });
        }
      }
      // Key / RID Lookup
      if (/^(Key Lookup|RID Lookup)$/.test(op)) {
        const obj = xAll(r, 'Object')[0];
        const tbl = obj ? (obj.attrs.Table || '').replace(/[\[\]]/g, '') : '';
        const execs = act ? act.execs : (xNum(ra.EstimateRebinds) || 0) + (xNum(ra.EstimateRewinds) || 0) + 1;
        if ((execs || 0) >= 1000 || (act && act.rows >= 1000)) {
          const cols = opCols(xKid(r, 'OutputList') || r);
          // Índice usado por el operador hermano (Seek/Scan) del Nested Loops
          let par = parents.get(r); while (par && par.name !== 'RelOp' && parents.get(par)) par = parents.get(par);
          const sameT = x => { const o = xAll(x, 'Object')[0]; return o && (o.attrs.Table || '').replace(/[\[\]]/g, '') === tbl; };
          const sib = par ? xAll(par, 'RelOp').find(x => x !== r && /(Seek|Scan)$/.test(x.attrs.PhysicalOp || '') && !/Lookup/.test(x.attrs.PhysicalOp || '') && sameT(x)) : null;
          const sObj = sib ? xAll(sib, 'Object')[0] : null;
          const sIdx = sObj && sObj.attrs.Index ? sObj.attrs.Index.replace(/[\[\]]/g, '') : '';
          const sKeys = sib ? [...new Set(xAll(xAll(sib, 'SeekPredicates')[0] || { children: [] }, 'ColumnReference').map(c => c.attrs.Column).filter(c => c && !/^@/.test(c)))] : [];
          const sch = obj ? (obj.attrs.Schema || '[dbo]').replace(/[\[\]]/g, '') : 'dbo';
          const keySql = sKeys.length ? sKeys.map(c => `[${c}]`).join(', ') : '/* columnas clave actuales del índice */';
          const proposal = { text: sIdx && !/^PK_|^CL/i.test(sIdx)
              ? `Agregar las columnas leídas por el ${op} como INCLUDE en el índice ${sIdx} para eliminar las ${fmtN(execs)} búsquedas (validar con el DBA el tamaño y el costo de escritura). Alternativa: no seleccionar esas columnas si no se usan.`
              : `Crear un índice que cubra el filtro y las columnas leídas (validar con el DBA). Alternativa: no seleccionar esas columnas si no se usan.`,
            sql: sIdx && !/^PK_|^CL/i.test(sIdx)
              ? `CREATE NONCLUSTERED INDEX [${sIdx}]\nON [${sch}].[${tbl}] (${keySql})\nINCLUDE (${cols.map(c => `[${c}]`).join(', ')})\nWITH (DROP_EXISTING = ON);`
              : `CREATE NONCLUSTERED INDEX ${idxName(tbl, sKeys.length ? sKeys : ['Filtro'])}\nON [${sch}].[${tbl}] (${keySql})\nINCLUDE (${cols.map(c => `[${c}]`).join(', ')});` };
          add(`P07|${n}|${node}`, 'P07', 'Media', 'Plan · Índices', `${op} en ${tbl}`, `${where}: ${fmtN(execs)} búsquedas adicionales para obtener ${cols.slice(0, 6).join(', ') || 'columnas no incluidas en el índice'}.`,
            'El índice usado no cubre las columnas que se leen: por cada fila se hace una búsqueda adicional en la tabla.', [...L, ...colLines(cols.slice(0, 3), at)], 'Plan – Key Lookup', false, { stmt: n, proposal });
        }
      }
      // ---- Table Scan (tabla sin índice clustered) y lectura residual elevada ----
      const objR = xAll(r, 'Object')[0];
      const tblR = objR ? (objR.attrs.Table || '').replace(/[\[\]]/g, '').replace(/_{3,}[0-9A-F]*$/i, '') : '';
      const isTempR = /^[#@]/.test(tblR) || /tempdb/i.test(objR ? objR.attrs.Database || '' : '');
      const schR = objR ? (objR.attrs.Schema || '[dbo]').replace(/[\[\]]/g, '') : 'dbo';
      const readR = act && act.read != null ? act.read : xNum(ra.EstimatedRowsRead);
      const rowsR = act ? act.rows : est;
      const predR = xAll(r, 'Predicate')[0];
      const pstrR = predR ? ((xAll(predR, 'ScalarOperator')[0] || { attrs: {} }).attrs.ScalarString || '') : '';
      let pcolsR = predR ? [...new Set(xAll(predR, 'ColumnReference').filter(c => (c.attrs.Table || '').replace(/[\[\]]/g, '').replace(/_{3,}[0-9A-F]*$/i, '') === tblR).map(c => c.attrs.Column))] : [];
      if (!pcolsR.length && pstrR && tblR) pcolsR = [...new Set(allMatches(new RegExp('\\[' + escRe(tblR) + '\\]\\.\\[(\\w+)\\]', 'gi'), pstrR).map(m => m[1]))];
      const fnR = /\b(CONVERT_IMPLICIT|CONVERT|CAST|isnull|substring|left|right|datepart|year|month|day|upper|lower|ltrim|rtrim|dateadd|datediff)\s*\(/i.exec(pstrR);
      const shortR = pstrR.replace(/\[[^\]]*\]\.\[[^\]]*\]\.\[([^\]]*)\]\.\[([^\]]*)\]( as \[[^\]]*\]\.\[[^\]]*\])?/g, '$1.$2').slice(0, 300);
      const predProposal = (what) => fnR
        ? { text: `El filtro aplica ${fnR[1].toUpperCase()} sobre la columna, por eso se ${what}. Reescribirlo para que la columna quede "limpia" (aplicar la función al valor, no a la columna)${/CONVERT_IMPLICIT/i.test(fnR[1]) ? '; ver la conversión implícita de esta sentencia' : ''}.`, sql: `-- Predicado actual del plan:\n-- ${shortR}` }
        : { text: `El filtro no tiene un índice que lo soporte, por eso se ${what}. Proponer al DBA un índice con las columnas del filtro${pcolsR.length ? '' : ' (no visibles en el plan)'}.`,
            sql: `${shortR ? `-- Predicado actual del plan:\n-- ${shortR}\n` : ''}${pcolsR.length ? `CREATE NONCLUSTERED INDEX ${idxName(tblR, pcolsR)}\nON [${schR}].[${tblR}] (${pcolsR.map(c => c.startsWith('[') ? c : `[${c}]`).join(', ')});` : ''}` };
      const residualHigh = readR != null && rowsR != null && readR >= 10000 && readR >= Math.max(rowsR, 1) * 10;
      if (op === 'Table Scan' && tblR && !isTempR) {
        const card = xNum(ra.TableCardinality) || readR || 0;
        if (card >= 1000) {
          const colsSql = pcolsR.length ? pcolsR.map(c => c.startsWith('[') ? c : `[${c}]`).join(', ') : '/* columna clave o de búsqueda */';
          const proposal = {
            text: `La tabla ${schR}.${tblR} no tiene índice clustered (es un heap) y se recorre completa en cada ejecución. ` +
              (fnR ? `Además el filtro aplica ${fnR[1].toUpperCase()} sobre la columna: corregirlo para que pueda usar un índice. ` : '') +
              `Proponer al DBA un índice clustered${pcolsR.length ? ' sobre la columna del filtro' : ''} (o sobre la clave primaria si ya existe una) para que el motor haga un Seek.`,
            sql: `${shortR ? `-- Predicado actual del plan:\n-- ${shortR}\n` : ''}-- Validar con el DBA la columna clave y el impacto en escrituras\nCREATE CLUSTERED INDEX CIX_${tblR}\nON [${schR}].[${tblR}] (${colsSql});` };
          add(`P15|${n}|${node}`, 'P15', card >= 100000 ? 'Alta' : 'Media', 'Plan · Table Scan', `Table Scan en ${schR}.${tblR}`,
            `${where}: Table Scan (nodo ${node}) sobre una tabla sin índice clustered de ${fmtN(card)} filas${readR != null ? `; leyó ${fmtN(readR)} y devolvió ${fmtN(rowsR)}` : ''}${act && act.execs > 1 ? ` en ${fmtN(act.execs)} ejecuciones` : ''}.`,
            'Un Table Scan lee todas las páginas de la tabla en cada ejecución y no puede aprovechar índices de búsqueda.', L, 'Plan – Table Scan', false, { stmt: n, proposal, node: Number(node) });
        }
      } else if (residualHigh && tblR && !isTempR && /(Scan|Seek)$/.test(op) && !/Constant/.test(op)) {
        const pct = rowsR / Math.max(readR, 1) * 100;
        add(`P08|${n}|${node}`, 'P08', readR >= 1000000 || pct < 1 ? 'Alta' : 'Media', 'Plan · Lectura residual', `Lectura residual elevada en ${tblR}`,
          `${where}: ${op} (nodo ${node}) leyó ${fmtN(readR)} filas y solo ${fmtN(rowsR)} cumplieron el filtro (${pct < 0.1 ? '<0.1' : pct.toFixed(1)}% útil; ${fmtN(readR - rowsR)} filas leídas de más)${act && act.read == null ? ' (estimado)' : ''}.`,
          'El índice usado no filtra por las columnas del predicado: se leen muchas filas y se descartan después (predicado residual).', L, 'Plan – ActualRowsRead vs ActualRows', false,
          { stmt: n, proposal: predProposal(/Seek$/.test(op) ? 'leen filas de más dentro del rango del Seek' : 'recorre el índice completo'), node: Number(node) });
      }
      // Desvío de estimación
      if (act && est != null) {
        const estT = est * Math.max(1, act.execs);
        const ratio = act.rows > estT ? act.rows / Math.max(estT, 1) : estT / Math.max(act.rows, 1);
        if (ratio >= 10 && Math.max(act.rows, estT) >= 1000) deviations.push({ op, node: Number(node), estT, rows: act.rows, ratio, tables: planTables(r), tvar: xAll(r, 'Object').some(o => /^\[?@/.test(o.attrs.Table || '')), temps: [...new Set(xAll(r, 'Object').map(o => (o.attrs.Table || '').replace(/[\[\]]/g, '').replace(/_{3,}[0-9A-F]*$/i, '')).filter(t => /^#/.test(t)))] });
      }
    }
    // Un solo hallazgo por sentencia: el operador más profundo donde nace el desvío
    const maxR = deviations.reduce((m, d) => Math.max(m, d.ratio), 0);
    deviations.filter(d => d.ratio >= maxR * 0.5).sort((x, y) => y.node - x.node).slice(0, 1).forEach(d => {
      add(`P09|${n}|${d.node}`, 'P09', 'Media', 'Plan · Estimación', 'Estimación de filas muy distinta a la real',
        `${where}: ${d.op} (nodo ${d.node}) estimó ${fmtN(d.estT)} filas y procesó ${fmtN(d.rows)} (${Math.round(d.ratio)}x).`,
        'Es el operador más profundo donde nace el desvío; los superiores lo heredan. Una mala estimación provoca memoria insuficiente (spills) o excesiva y malos tipos de JOIN.', L, 'Plan real – EstimateRows vs ActualRows', false,
        { stmt: n, proposal: d.tvar
          ? { text: 'El desvío viene de una variable tabla (sin estadísticas). Cambiarla por una #temporal declarada con CREATE TABLE.' }
          : d.tables.length || stTables.length
            ? { text: 'Actualizar estadísticas de las tablas involucradas y revisar conversiones implícitas o funciones sobre columnas en los filtros de esta sentencia (son la causa más común).', sql: statsScript(d.tables.length ? d.tables : stTables) }
            : { text: `El desvío está sobre una #temporal${d.temps.length ? ' (' + d.temps.join(', ') + ')' : ''}: revisar que se cargue solo con las filas necesarias y actualizar sus estadísticas después de cargarla (o crear un índice sobre la columna de unión).`,
                sql: d.temps.map(t => `UPDATE STATISTICS ${t};`).join('\n') } });
    });

    // --- Advertencias a nivel de sentencia ---
    const qws: any[] = qp.children.filter(x => x.name === 'Warnings');
    const qw = qws[0] || null;
    const convs: { issue: string; expr: string }[] = [];
    for (const w of qws) for (const c of w.children.filter(x => x.name === 'PlanAffectingConvert')) convs.push({ issue: c.attrs.ConvertIssue || '', expr: c.attrs.Expression || '' });
    // Solo las conversiones que el plan marca como alerta (PlanAffectingConvert). Las CONVERT_IMPLICIT que
    // aparecen en expresiones sin advertencia no afectan el plan y no se reportan.
    const seenConv = new Set();
    for (const c of convs) {
      for (const m of allMatches(CONV_RE, c.expr)) {
        const ref = parseColRef(m[2]);
        if (ref.isVar || !ref.column || ref.isTableVar) continue;
        const conv = { type: m[1].toLowerCase(), table: ref.table, column: ref.column, alias: ref.alias, isTemp: ref.isTemp, issue: c.issue };
        const k = `${conv.table}.${conv.column}|${conv.type}`.toLowerCase();
        if (seenConv.has(k)) continue;
        seenConv.add(k);
        st.converts++;
        const seek = /seek/i.test(c.issue);
        const unicode = /^n(var)?char/.test(conv.type);
        const numeric = /^(int|bigint|smallint|tinyint|decimal|numeric|money|smallmoney|float|real|bit)/.test(conv.type);
        const ed = src ? convertEdits(src, masked, conv) : { edits: [], notes: [] };
        const key = `P02|${k}`;
        if (ed.edits.length) res.fixes.converts.push(Object.assign({ key }, conv));
        if (unicode) res.fixes.convertsAll.push(Object.assign({ key, stmt: n }, conv));
        const sa = unicode ? applyConvert(text, conv, st.params) : { src: text, count: 0, notes: [] };
        const snip = sa.count ? changedSnippet(text, sa.src) : '';
        // Otro operando de la comparación según el plan
        let other: any = null;
        for (const so of xAll(qp, 'ScalarOperator')) {
          const ss = so.attrs.ScalarString || '';
          if (!/CONVERT_IMPLICIT/i.test(ss) || !new RegExp('\\[' + escRe(conv.column) + '\\]', 'i').test(ss)) continue;
          const parts = ss.split(/\s*(?:=|<>|>=|<=|>|<)\s*/);
          const side = parts.find(x => !/CONVERT_IMPLICIT/i.test(x));
          if (!side) continue;
          const tm = /#(\w+?)_{3,}[0-9A-F]*\]?\.\[(\w+)\]/i.exec(side) || /\[#(\w+)\]\.\[(\w+)\]/i.exec(side);
          if (tm) { other = { kind: 'temp', table: '#' + tm[1], col: tm[2] }; break; }
          const vm = /\[?(@\w+)\]?/.exec(side);
          if (vm) { other = { kind: st.params.some(p => p.name.toLowerCase() === vm[1].toLowerCase()) ? 'param' : 'var', name: vm[1] }; break; }
          if (/^N'/i.test(side.trim())) { other = { kind: 'lit', text: side.trim() }; break; }
        }
        const colRef = `${conv.alias ? conv.alias + '.' : ''}${conv.column}`;
        const vlen = `<largo de ${conv.table}.${conv.column}>`;
        const generic = !unicode ? null
          : other && other.kind === 'temp' ? { text: `La comparación es contra ${other.table}.${other.col} (NVARCHAR). Definir esa columna de la temporal con el mismo tipo que ${conv.table}.${conv.column} (VARCHAR).`,
              sql: `-- En la definición de la temporal:\nCREATE TABLE ${other.table}\n(\n    …\n    ${other.col} VARCHAR(${vlen}) COLLATE SQL_Latin1_General_CP1_CI_AS,\n    …\n);` }
          : other && other.kind === 'var' ? { text: `La comparación es contra la variable ${other.name} (NVARCHAR). Declararla como VARCHAR del largo de la columna.`, sql: `DECLARE ${other.name} VARCHAR(${vlen});` }
          : other && other.kind === 'lit' ? { text: 'Quitar el prefijo N del literal.', sql: `-- … WHERE ${colRef} = ${other.text.slice(1)}` }
          : { text: `Igualar el tipo del otro operando al de ${conv.table}.${conv.column} (VARCHAR/CHAR): variable local VARCHAR del mismo largo, literal sin N o columna de la #temporal como VARCHAR.`,
              sql: `-- Ejemplo (sin cambiar la firma del PA):\nDECLARE @valorLocal VARCHAR(${vlen}) = @parametro;\n-- … WHERE ${colRef} = @valorLocal` };
        const proposal = snip
          ? { text: `Igualar el tipo del otro operando al de la columna ${conv.table}.${conv.column} (${[...new Set(sa.notes)].join('; ')}). Validar el tipo y largo exacto con los scripts de Metadatos.`, sql: snip }
          : generic ? generic
          : numeric ? { text: `Comparar ${conv.column} con un texto o una variable del mismo tipo que la columna, previa validación del formato (no es equivalente: '01' ≠ '1').`, sql: `-- … WHERE ${conv.alias ? conv.alias + '.' : ''}${conv.column} = '<valor como texto>'` }
          : { text: 'Comparar con un valor del mismo tipo que la columna.' };
        const lines = [...L];
        if (src) for (const cc of columnComparisons(masked, conv)) lines.push(lineOf(src, cc.idx));
        const det = `${where}: CONVERT_IMPLICIT(${conv.type}, ${conv.table}.${conv.column}) — la columna se convierte a ${conv.type}` +
          (seek ? ', lo que impide el Index Seek y distorsiona la estimación de filas.' : ', lo que distorsiona la estimación de filas (memoria y tipo de JOIN).') +
          (ed.notes.length ? ` Se aplicará: ${[...new Set(ed.notes)].join('; ')}.` : '');
        const rec = unicode
          ? 'El otro lado de la comparación es NVARCHAR/NCHAR o literal N\'…\' y la columna es VARCHAR/CHAR. Igualar el tipo al de la columna: variable local VARCHAR del mismo largo (sin cambiar la firma del PA), quitar la N del literal o definir la columna de la temporal como VARCHAR.' + (ed.edits.length ? '' : ' No se encontró en el código una comparación que se pueda corregir automáticamente: revisar el JOIN/WHERE indicado.')
          : numeric ? 'La columna de texto se compara con un valor numérico: comparar con un texto (\'…\') o una variable del mismo tipo de la columna. No se aplica automáticamente porque no es equivalente (\'01\' ≠ \'1\' pero ambos = 1).'
          : 'Comparar con un valor del mismo tipo que la columna (confirmar tipos con los scripts de Metadatos).';
        add(key, seek ? 'P02' : 'P03', seek ? 'Alta' : 'Media', 'Plan · Conversión implícita (alerta)', `Conversión implícita en ${conv.table}.${conv.column}`,
          det.replace(' — la columna', ` — alerta "${c.issue}": la columna`), rec, lines,
          'Plan – advertencia PlanAffectingConvert (' + c.issue + ')', ed.edits.length > 0 || !!snip, { stmt: n, proposal });
      }
    }

    // --- Memoria ---
    const mgw = qws.flatMap(w => w.children).find(x => x.name === 'MemoryGrantWarning') || null;
    const granted = st.grantedKB, used = st.usedKB;
    // Elevada: concesión >= 50 MB y uso < 10 % (o la alerta Excessive Grant de SQL Server con concesión >= 50 MB)
    const HIGH_GRANT_KB = 51200;
    const excessive = granted != null && granted >= HIGH_GRANT_KB &&
      ((mgw && /Excessive/i.test(mgw.attrs.GrantWarningKind || '')) || (used != null && used / Math.max(granted, 1) < 0.1));
    if (excessive) {
      st.warnings++;
      res.fixes.excessiveGrant = true;
      const causes: string[] = [];
      const maxEd = src ? maxColumnEdits(masked) : [];
      if (maxEd.length) causes.push(`${maxEd.length} columna(s) VARCHAR(MAX) en temporales/variables tabla`);
      if (src && /\bSELECT\s+(?:\w+\.)?\*/i.test(masked)) causes.push('SELECT * (más columnas de las necesarias)');
      if (deviations.some(d => d.estT > d.rows)) causes.push('filas estimadas muy por encima de las reales');
      const pct = granted ? Math.round((used || 0) * 1000 / granted) / 10 : 0;
      // Operadores que piden memoria (Sort / Hash) y su tamaño estimado
      const cons = relops.filter(r => /Sort|Hash/.test(r.attrs.PhysicalOp || '')).map(r => {
        const rows = xNum(r.attrs.EstimateRows) || 0, size = xNum(r.attrs.AvgRowSize);
        const act = r.children.find(c => c.name === 'RunTimeInformation');
        const real = act ? act.children.filter(c => c.name === 'RunTimeCountersPerThread').reduce((a2, t) => a2 + (xNum(t.attrs.ActualRows) || 0), 0) : null;
        const cols = [...new Set(xAll(xKid(r, 'OutputList') || { children: [] }, 'ColumnReference').map(c => c.attrs.Column).filter(Boolean))];
        return { op: r.attrs.PhysicalOp, node: r.attrs.NodeId, rows, real, size, mb: size ? rows * size / 1048576 : null, cols };
      });
      const consTxt = cons.map(c => `-- ${c.op} (nodo ${c.node}): ${fmtN(c.rows)} filas estimadas${c.real != null ? ` / ${fmtN(c.real)} reales` : ''}${c.size ? ` × ${fmtN(c.size)} bytes ≈ ${(c.mb || 0).toFixed(1)} MB` : ''}${c.cols.length ? `\n--   columnas: ${c.cols.slice(0, 12).join(', ')}` : ''}`).join('\n');
      const p4: string[] = [];
      if (/\bSELECT\s+(?:\w+\.)?\*/i.test(mask(text).masked)) p4.push('reemplazar SELECT * por las columnas que realmente se usan');
      if (cons.some(c => c.size && c.size >= 1000)) p4.push('quitar del Sort/Hash las columnas anchas (VARCHAR grandes o MAX) que no se necesitan para ordenar o unir; traerlas después con un JOIN por la clave');
      if (deviations.some(d => d.estT > d.rows)) p4.push('corregir la sobreestimación de filas (estadísticas, variables tabla → #temporal)');
      p4.push('filtrar antes de ordenar/agrupar');
      const proposal4 = { text: `Para reducir la memoria reservada: ${p4.join('; ')}.${maxEd.length ? ' Las columnas VARCHAR(MAX) de las temporales se pueden reducir con la opción del plan (validar longitud).' : ''}`,
        sql: [consTxt, deviations.some(d => d.estT > d.rows) ? statsScript(stTables) : ''].filter(Boolean).join('\n') };
      add(`P04|${n}`, 'P04', granted >= 102400 ? 'Alta' : 'Media', 'Plan · Memoria', 'Sobreestimación de memoria elevada',
        `${where}: concedidos ${fmtKB(granted)}, usados ${fmtKB(used)} (${pct}%); ${fmtKB(granted - (used || 0))} reservados sin usar.${causes.length ? ' Posibles causas: ' + causes.join('; ') + '.' : ''}`,
        'Reservar memoria de más bloquea a otras consultas (RESOURCE_SEMAPHORE). Reducir el ancho de las filas que pasan por Sort/Hash (columnas necesarias, sin VARCHAR(MAX) en temporales; la opción del plan lo cambia a VARCHAR(2000) para validar), filtrar antes de ordenar/agrupar y corregir estimaciones. En SQL 2019 el Memory Grant Feedback ajusta ejecuciones siguientes, pero la primera sigue reservando de más.',
        L, 'Plan real – MemoryGrantInfo / Excessive Grant', maxEd.length > 0, { stmt: n, proposal: proposal4 });
    }
    if (mgw && /Used More Than Granted/i.test(mgw.attrs.GrantWarningKind || '')) {
      add(`P05|${n}`, 'P05', 'Alta', 'Plan · Memoria', 'Memoria insuficiente (usó más de lo concedido)',
        `${where}: solicitados ${fmtKB(xNum(mgw.attrs.RequestedMemory))}, concedidos ${fmtKB(xNum(mgw.attrs.GrantedMemory))}, usados ${fmtKB(xNum(mgw.attrs.MaxUsedMemory))}.`,
        'La estimación de filas fue baja: corregir estadísticas, conversiones y predicados no SARGables para que el motor reserve la memoria adecuada.', L, 'Plan – MemoryGrantWarning', false,
        { stmt: n, proposal: { text: 'Actualizar estadísticas de las tablas de la sentencia y revisar las conversiones/funciones sobre columnas que distorsionan la estimación.', sql: statsScript(stTables) } });
    }
    if (st.waitMs && st.waitMs > 0) add(`P13|${n}`, 'P13', 'Info', 'Plan · Memoria', 'Espera por concesión de memoria', `${where}: esperó ${fmtN(st.waitMs)} ms para obtener memoria.`,
      'Indica presión de memoria en el servidor; reducir la memoria solicitada (ver sobreestimación) ayuda a todas las consultas.', L, 'Plan – GrantWaitTime', false,
      { stmt: n, proposal: { text: 'Aplicar las mejoras de sobreestimación de memoria de esta sentencia; si persiste, reportar al DBA la espera RESOURCE_SEMAPHORE con la hora de ejecución.' } });
    const big = relops.filter(r => /Scan|Seek/.test(r.attrs.PhysicalOp || '')).map(r => ({ r, card: xNum(r.attrs.TableCardinality) || xNum(r.attrs.EstimatedRowsRead) || 0, o: xAll(r, 'Object')[0] }))
      .filter(x => x.o && !/^\[?[#@]/.test(x.o.attrs.Table || '') && !/tempdb/i.test(x.o.attrs.Database || '')).sort((a2, b2) => b2.card - a2.card)[0];
    const bigT = big ? `${(big.o.attrs.Schema || '[dbo]').replace(/[\[\]]/g, '')}.${(big.o.attrs.Table || '').replace(/[\[\]]/g, '')}` : '<tabla de mayor volumen>';
    const bigA = big && big.o.attrs.Alias ? big.o.attrs.Alias.replace(/[\[\]]/g, '') : 'T';
    if (st.timeout) add(`P11|${n}`, 'P11', 'Media', 'Plan · Compilación', 'El optimizador abandonó por tiempo (TimeOut)',
      `${where}: el plan elegido puede no ser el óptimo porque la consulta es demasiado compleja.`,
      'Dividir la consulta: obtener primero el subconjunto de la tabla de mayor volumen en una #temporal y luego hacer los JOIN sobre ella (Manual BP – Consulta con tablas de gran volumen).', L, 'Plan – StatementOptmEarlyAbortReason', false,
      { stmt: n, proposal: { text: `Separar en dos pasos empezando por ${bigT}${big ? ` (${fmtN(big.card)} filas)` : ''}, la tabla de mayor volumen del plan.`,
        sql: `-- 1) Subconjunto de la tabla de mayor volumen, solo con las columnas y filtros necesarios\nCREATE TABLE #Base (/* columnas necesarias con su tipo exacto + COLLATE en texto */);\nINSERT INTO #Base (/* columnas */)\nSELECT /* columnas */\nFROM ${bigT} AS ${bigA} WITH (NOLOCK)\nWHERE /* filtros más selectivos de la consulta original */;\n\n-- 2) Resto de JOIN sobre #Base\nSELECT /* … */\nFROM #Base AS ${bigA}\nINNER JOIN /* demás tablas WITH (NOLOCK) */ ON /* … */;` } });

    // --- Índices faltantes ---
    for (const g2 of xAll(qp, 'MissingIndexGroup')) {
      const impact = xNum(g2.attrs.Impact);
      for (const mi of xAll(g2, 'MissingIndex')) {
        const t = (mi.attrs.Table || '').replace(/[\[\]]/g, ''), sch = (mi.attrs.Schema || '[dbo]').replace(/[\[\]]/g, ''), db = (mi.attrs.Database || '').replace(/[\[\]]/g, '');
        const grp = u => xAll(mi, 'ColumnGroup').filter(c => c.attrs.Usage === u).flatMap(c => xAll(c, 'Column').map(x => x.attrs.Name));
        const keyCols = [...grp('EQUALITY'), ...grp('INEQUALITY')], inc = grp('INCLUDE');
        if (!keyCols.length) continue;
        const nm = `IX_${t}_${keyCols.map(c => c.replace(/[\[\]]/g, '')).slice(0, 3).join('_')}`;
        const script = `-- Impacto estimado: ${impact != null ? impact.toFixed(1) : '?'}%${db ? ' · Base: ' + db : ''} · Validar con DBA\nCREATE NONCLUSTERED INDEX ${nm}\nON [${sch}].[${t}] (${keyCols.join(', ')})${inc.length ? `\nINCLUDE (${inc.join(', ')})` : ''};`;
        if (res.missingIndexes.some(x => x.script === script)) continue;
        res.missingIndexes.push({ table: t, impact, script, stmt: n });
        add(`P06|${n}|${t}|${keyCols.join(',')}`, 'P06', impact != null && impact >= 50 ? 'Media' : 'Baja', 'Plan · Índices', `Índice sugerido por el plan en ${t}`,
          `${where}: impacto estimado ${impact != null ? impact.toFixed(1) : '?'}%. Claves: ${keyCols.join(', ')}${inc.length ? '; INCLUDE: ' + inc.join(', ') : ''}.`,
          'No se crea automáticamente: validar con el DBA (índices existentes que se puedan ampliar, duplicados, costo de escritura).', [...L, ...colLines(keyCols.map(c => c.replace(/[\[\]]/g, '')).slice(0, 2), at)], 'Plan – MissingIndex', false,
          { stmt: n, script, proposal: { text: 'Índice sugerido por el optimizador. Antes de crearlo revisar si ya existe uno con las mismas claves que se pueda ampliar con INCLUDE.', sql: script } });
      }
    }
  });
  if (!stmts.length) { res.ok = false; res.error = 'El plan no contiene sentencias con QueryPlan.'; }
  if (res.ok && !res.isActual) add('P00', 'P00', 'Info', 'Plan', 'Plan estimado (sin datos reales)',
    'El archivo es un plan estimado: no incluye filas reales, memoria usada ni spills.',
    'Para detectar spills y sobreestimación de memoria, guarda el plan real (en SSMS: "Incluir plan de ejecución real" Ctrl+M, ejecutar y luego "Guardar plan de ejecución como…").', [], 'Plan', false,
    { proposal: { text: 'Volver a capturar el plan real con SET STATISTICS IO, TIME ON para comparar lecturas lógicas antes y después.' } });
  // Revisión principal (en este orden): spills, conversiones con alerta, Table Scan, memoria elevada, lectura residual.
  const FOCUS: Record<string, number> = { P01: 0, P02: 1, P03: 1, P15: 2, P04: 3, P08: 4 };
  const order: Record<string, number> = { Alta: 0, Media: 1, Baja: 2, Info: 3 };
  F.forEach(f => { f.main = f.id in FOCUS; });
  F.sort((x, y) => (x.main === y.main ? 0 : x.main ? -1 : 1) || (x.main ? FOCUS[x.id] - FOCUS[y.id] : 0) || order[x.sev] - order[y.sev] || x.id.localeCompare(y.id));
  res.focus = {
    spills: F.filter(f => f.id === 'P01').length,
    converts: F.filter(f => f.id === 'P02' || f.id === 'P03').length,
    tableScans: F.filter(f => f.id === 'P15').length,
    memory: F.filter(f => f.id === 'P04').length,
    residual: F.filter(f => f.id === 'P08').length
  };
  return res;
}

// Aplica las correcciones derivadas del plan (antes que las de código, para ubicar las sentencias)
function applyPlanFixes(src, plan, opts) {
  const applied: AppliedChange[] = [], fixed: string[] = [];
  if (!plan || !plan.ok) return { src, applied, fixed };
  if (opts.planConvert) {
    let n = 0; const notes: any[] = [];
    for (const c of plan.fixes.converts) {
      const r = applyConvert(src, c);
      if (r.count) { src = r.src; n++; fixed.push(c.key); notes.push(...r.notes); }
    }
    if (n) applied.push({ key: 'planConvert', label: `Plan: conversiones implícitas corregidas (${n})`, count: n, motivo: 'Plan – CONVERT_IMPLICIT (impide Index Seek)', seguro: `Se iguala el tipo del otro operando al de la columna (${[...new Set(notes)].join('; ')}). Equivalente si los valores no contienen caracteres Unicode fuera de Latin-1; validar tipo exacto con Metadatos.` });
  }
  if (opts.planSort) {
    const { masked } = mask(src);
    const edits: any[] = [];
    for (const s of plan.fixes.sorts) {
      const at = locateInSource(src, (plan.statements.find(x => x.n === s.stmt) || {}).fullText);
      if (at < 0) continue;
      const e = insertOrderByEdit(src, masked, at, s.cols);
      if (e && !edits.some(x => x.start === e.start)) { edits.push(e); fixed.push(s.key); }
    }
    if (edits.length) {
      src = applyEdits(src, edits);
      applied.push({ key: 'planSort', label: `Plan: ORDER BY quitado en INSERT a temporal (${edits.length})`, count: edits.length, motivo: 'Plan – Sort con spill / costo de ordenamiento', seguro: 'El orden de inserción en una tabla no está garantizado y la temporal no tiene IDENTITY: el contenido es el mismo.' });
    }
  }
  if (opts.planMaxGrant && plan.fixes.excessiveGrant) {
    const { masked } = mask(src);
    const edits = maxColumnEdits(masked);
    if (edits.length) {
      src = applyEdits(src, edits);
      applied.push({ key: 'planMaxGrant', label: `Plan: VARCHAR(MAX) → VARCHAR(2000) en temporales (${edits.length})`, count: edits.length, motivo: 'Plan – Sobreestimación de memoria', seguro: 'Reduce la memoria reservada. Validar que ningún valor supere 2000 caracteres (marcado con TODO).' });
    }
  }
  return { src, applied, fixed };
}

/**
 * Mejora cada sentencia del plan SIN necesidad del procedimiento: aplica las correcciones del plan
 * (conversiones, Sort) y las de código seleccionadas sobre el texto de la sentencia.
 */
export function improvePlan(plan: PlanAnalysis | null, opts: OptimizeOptions): ImprovedPlan {
  if (!plan || !plan.ok) return { statements: [], fixed: [] };
  opts = opts || {};
  const code = Object.assign({}, opts, { closeTran: false, nocount: false, reviewNotes: false, removeComments: false, planConvert: false, planSort: false, planMaxGrant: false });
  const allFixed: string[] = [];
  const statements = plan.statements.map(st => {
    let s = st.fullText; const applied: string[] = [], fixed: string[] = [];
    if (opts.planSort) for (const so of plan.fixes.sorts.filter(x => x.stmt === st.n)) {
      const e = insertOrderByEdit(s, mask(s).masked, 0, so.cols);
      if (e) { s = applyEdits(s, [e]); applied.push('ORDER BY quitado (Sort con spill)'); fixed.push(so.key); }
    }
    if (opts.planConvert) for (const c of plan.fixes.convertsAll.filter(c => c.stmt === st.n)) {
      const r = applyConvert(s, c, st.params);
      if (r.count) { s = r.src; applied.push(`Conversión implícita en ${c.table}.${c.column}`); fixed.push(c.key); }
    }
    const o = optimize(s, code, null);
    s = o.src; applied.push(...o.applied.map(a => a.label));
    allFixed.push(...fixed);
    return { n: st.n, type: st.type, line: st.line, before: st.fullText, after: s, applied, fixed };
  });
  return { statements, fixed: allFixed };
}

/** Puntaje 0-100 del plan (independiente del código). */
export function planScore(findings: Finding[]): number {
  const w: Record<string, number> = { Alta: 8, Media: 4, Baja: 1, Info: 0 };
  return Math.max(0, 100 - (findings || []).reduce((a, f) => a + (w[f.sev] || 0) + (f.id === 'P01' ? 7 : 0), 0));
}

/** Une hallazgos de código y de plan, quitando los del plan ya corregidos. */
export function combine(analysis: AnalysisResult, plan?: PlanAnalysis | null, fixed?: string[]): AnalysisResult {
  const fx = new Set<string>(fixed || []);
  const code: Finding[] = analysis.findings.map(f => Object.assign({ key: f.id, source: 'code' as const }, f));
  const pf = plan && plan.findings ? plan.findings.filter(f => !fx.has(f.key || '')) : [];
  const order: Record<string, number> = { Alta: 0, Media: 1, Baja: 2, Info: 3 };
  const findings = [...code, ...pf].sort((a, b) => order[a.sev] - order[b.sev] || a.id.localeCompare(b.id));
  const w: Record<string, number> = { Alta: 6, Media: 3, Baja: 1, Info: 0 };
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + w[f.sev], 0));
  return Object.assign({}, analysis, { findings, score });
}

/** Sección del reporte para el DBA. */
export function planReport(plan?: PlanAnalysis | null, fixed?: string[] | null, improved?: ImprovedPlan | null): string {
  if (!plan || !plan.ok) return '';
  const fx = new Set<string>(fixed || []);
  let r = `\n## ${improved ? '' : '5. '}Plan de ejecución (${plan.isActual ? 'real' : 'estimado'})\n`;
  r += `| # | Línea | Tipo | Costo | Memoria concedida / usada | Spills | Conversiones | Tiempo |\n|---|---|---|---|---|---|---|---|\n`;
  for (const s of plan.statements)
    r += `| ${s.n} | ${s.line || '—'} | ${s.type} | ${s.cost != null ? s.cost.toFixed(3) : '—'} | ${fmtKB(s.grantedKB)} / ${fmtKB(s.usedKB)} | ${s.spills} | ${s.converts} | ${s.elapsedMs != null ? fmtN(s.elapsedMs) + ' ms' : '—'} |\n`;
  r += `\n### Hallazgos y mejoras propuestas\n`;
  const order = ['Alta', 'Media', 'Baja', 'Info'];
  for (const sev of order) for (const f of plan.findings.filter(x => x.sev === sev)) {
    r += `- **${f.id} ${f.title}** (${f.sev}${fx.has(f.key || '') ? ', aplicado' : ''})\n  ${f.detail} ${f.rec}\n`;
    if (f.proposal) {
      r += `  **Mejora propuesta:** ${f.proposal.text}\n`;
      if (f.proposal.sql) r += '```sql\n' + f.proposal.sql + '\n```\n';
    }
  }
  if (improved && improved.statements.some(x => x.after !== x.before)) {
    r += `\n### Sentencias mejoradas\n`;
    for (const x of improved.statements.filter(y => y.after !== y.before))
      r += `\n**Sentencia ${x.n} (${x.type})** — ${x.applied.join(' · ')}\n` + '```sql\n' + x.after + '\n```\n';
  }
  return r;
}
