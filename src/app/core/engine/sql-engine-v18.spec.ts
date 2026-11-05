import { analyze, improvePlan, optimize } from './sql-engine-v18';
import { OPTIMIZE_OPTIONS } from './options-v18';

/** Integración del adaptador v1.8.1 con el motor (sql-engine.ts sin modificar). */
describe('v1.8.1 · adaptador del motor', () => {
  const ids = (sql: string) => analyze(sql).findings.map(f => f.id);

  it('agrega la casilla "Reescribir filtros no SARGables" después de LEFT → LIKE', () => {
    const keys = OPTIMIZE_OPTIONS.map(o => o.key);
    expect(keys.includes('sargPlus')).toBe(true);
    expect(OPTIMIZE_OPTIONS.find(o => o.key === 'sargPlus')!.default).toBe(true);
  });

  it('SQL optimizado aplica las reescrituras y R10 indica cuántas', () => {
    const sql = "SELECT c.cCtaCod FROM dbo.Credito c WITH (NOLOCK)\nWHERE SUBSTRING(c.cCtaCod, 6, 3) IN ('305', '302') AND YEAR(c.dFecha) = 2026";
    const o = optimize(sql, { sargPlus: true });
    expect(o.src).toContain("(c.cCtaCod LIKE '_____305%' OR c.cCtaCod LIKE '_____302%')");
    expect(o.src).toContain("(c.dFecha >= '20260101' AND c.dFecha < '20270101')");
    expect(o.applied.some(a => a.key === 'sargRewrite')).toBe(true);
    const r10 = analyze(sql).findings.find(f => f.id === 'R10')!;
    expect(r10.autofix).toBe(true);
    expect(r10.detail).toContain('Se reescriben automáticamente 2');
    const r10b = analyze("SELECT 1 FROM dbo.T t WHERE SUBSTRING(t.cCtaCod, 6, 3) = @cProd").findings.find(f => f.id === 'R10')!;
    expect(r10b.detail).toContain('Pendientes de revisión manual (1)');
  });

  it('sin la opción no se reescribe', () => {
    const sql = 'SELECT 1 FROM dbo.T t WITH (NOLOCK) WHERE YEAR(t.dFecha) = 2026';
    expect(optimize(sql, {}).src).toBe(sql);
  });

  it('DML sobre temporales: sin R31 ni R30 y la transacción no se envuelve', () => {
    expect(ids('UPDATE #T SET n = 1\nDELETE FROM #T WHERE n = 0\nUPDATE t SET n = 2 FROM @V t')).not.toContain('R31');
    expect(ids('UPDATE t SET n = 1 FROM #A t\nUPDATE dbo.A SET n = 1\nDELETE FROM dbo.B WHERE n = 0')).toContain('R31');
    const tr = 'BEGIN TRAN\nUPDATE #T SET n = 1\nCOMMIT';
    expect(ids(tr)).not.toContain('R30');
    expect(optimize(tr, { closeTran: true }).src).toBe(tr);
    const tr2 = 'BEGIN TRAN\nUPDATE dbo.P SET n = 1\nCOMMIT';
    expect(ids(tr2)).toContain('R30');
    expect(optimize(tr2, { closeTran: true }).src === tr2).toBe(false);
  });

  it('sentencias del plan también se reescriben', () => {
    const plan = { ok: true, findings: [], statements: [{ n: 1, type: 'SELECT', line: 0, fullText: "SELECT 1 FROM dbo.T t WHERE SUBSTRING(t.cCtaCod, 1, 3) = '109'" }] } as any;
    const imp = improvePlan(plan, { sargPlus: true });
    expect(imp.statements[0].after).toContain("t.cCtaCod LIKE '109%'");
  });
});
