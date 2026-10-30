/** Comparación línea a línea (LCS) con resaltado por palabra para líneas modificadas. */
export type DiffOp = { t: 'eq' | 'del' | 'add'; a?: number; b?: number };
export type DiffBlock =
  | { t: 'eq'; rows: DiffOp[] }
  | { t: 'ch'; del: number[]; add: number[] };

export interface DiffResult { A: string[]; B: string[]; blocks: DiffBlock[]; removed: number; added: number; changedBlocks: number; }

export function lcsOps<T>(A: T[], B: T[], eq: (x: T, y: T) => boolean): DiffOp[] {
  const n = A.length, m = B.length;
  let s = 0;
  while (s < n && s < m && eq(A[s], B[s])) s++;
  let e = 0;
  while (e < n - s && e < m - s && eq(A[n - 1 - e], B[m - 1 - e])) e++;
  const a = A.slice(s, n - e), b = B.slice(s, m - e), N = a.length, M = b.length;
  const ops: DiffOp[] = [];
  for (let i = 0; i < s; i++) ops.push({ t: 'eq', a: i, b: i });
  if (N * M > 25e6) {
    for (let i = 0; i < N; i++) ops.push({ t: 'del', a: s + i });
    for (let j = 0; j < M; j++) ops.push({ t: 'add', b: s + j });
  } else {
    const W = M + 1, T = new Int32Array((N + 1) * W);
    for (let i = N - 1; i >= 0; i--)
      for (let j = M - 1; j >= 0; j--)
        T[i * W + j] = eq(a[i], b[j]) ? T[(i + 1) * W + j + 1] + 1 : Math.max(T[(i + 1) * W + j], T[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < N && j < M) {
      if (eq(a[i], b[j])) { ops.push({ t: 'eq', a: s + i, b: s + j }); i++; j++; }
      else if (T[(i + 1) * W + j] >= T[i * W + j + 1]) ops.push({ t: 'del', a: s + i++ });
      else ops.push({ t: 'add', b: s + j++ });
    }
    while (i < N) ops.push({ t: 'del', a: s + i++ });
    while (j < M) ops.push({ t: 'add', b: s + j++ });
  }
  for (let k = 0; k < e; k++) ops.push({ t: 'eq', a: n - e + k, b: m - e + k });
  return ops;
}

export function diffLines(before: string, after: string): DiffResult {
  const A = before.replace(/\r/g, '').split('\n'), B = after.replace(/\r/g, '').split('\n');
  const ops = lcsOps(A, B, (p, q) => p.trimEnd() === q.trimEnd());
  const blocks: DiffBlock[] = [];
  let cur: DiffBlock | null = null;
  for (const o of ops) {
    if (o.t === 'eq') {
      if (!cur || cur.t !== 'eq') { cur = { t: 'eq', rows: [] }; blocks.push(cur); }
      cur.rows.push(o);
    } else {
      if (!cur || cur.t !== 'ch') { cur = { t: 'ch', del: [], add: [] }; blocks.push(cur); }
      if (o.t === 'del') cur.del.push(o.a!); else cur.add.push(o.b!);
    }
  }
  let removed = 0, added = 0, changedBlocks = 0;
  for (const b of blocks) if (b.t === 'ch') { removed += b.del.length; added += b.add.length; changedBlocks++; }
  return { A, B, blocks, removed, added, changedBlocks };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Devuelve [htmlAntes, htmlDespués] marcando solo las palabras que cambiaron. */
export function wordDiff(x: string, y: string): [string, string] {
  const tk = (s: string) => s.match(/\s+|\w+|[^\w\s]/g) || [];
  const A = tk(x), B = tk(y);
  if (A.length * B.length > 160000) return [`<span class="wd">${esc(x)}</span>`, `<span class="wa">${esc(y)}</span>`];
  let l = '', r = '';
  for (const o of lcsOps(A, B, (p, q) => p === q)) {
    if (o.t === 'eq') { l += esc(A[o.a!]); r += esc(B[o.b!]); }
    else if (o.t === 'del') l += /^\s+$/.test(A[o.a!]) ? esc(A[o.a!]) : `<span class="wd">${esc(A[o.a!])}</span>`;
    else r += /^\s+$/.test(B[o.b!]) ? esc(B[o.b!]) : `<span class="wa">${esc(B[o.b!])}</span>`;
  }
  return [l, r];
}
