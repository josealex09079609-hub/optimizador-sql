import { analyze, optimize } from './sql-engine';

/** Pruebas del motor ya actualizado con scripts/actualizar-v1.8.mjs */
describe('v1.8 · integración con sql-engine', () => {
  const ids = (sql: string) => analyze(sql).findings.map(f => f.id);

  it('SQL optimizado aplica las reescrituras SARGables y R10 queda como corrección automática', () => {
    const sql = "SELECT c.cCtaCod FROM dbo.Credito c WITH (NOLOCK)\nWHERE SUBSTRING(c.cCtaCod, 1, 3) = '109' AND YEAR(c.dFecha) = 2026";
    const o = optimize(sql, { sargPlus: true });
    expect(o.src).toContain("c.cCtaCod LIKE '109%'");
    expect(o.src).toContain("(c.dFecha >= '20260101' AND c.dFecha < '20270101')");
    expect(o.applied.some(a => a.key === 'sargRewrite')).toBe(true);
    expect(analyze(sql).findings.find(f => f.id === 'R10')!.autofix).toBe(true);
    expect(ids(o.src)).not.toContain('R10');
  });

  it('sin la opción no se reescribe', () => {
    const sql = 'SELECT 1 FROM dbo.T t WITH (NOLOCK) WHERE YEAR(t.dFecha) = 2026';
    expect(optimize(sql, {}).src).toBe(sql);
  });

  it('DML sobre temporales no exige transacción (R31) ni TRY/CATCH (R30)', () => {
    expect(ids('UPDATE #T SET n = 1\nDELETE FROM #T WHERE n = 0\nUPDATE t SET n = 2 FROM @V t')).not.toContain('R31');
    expect(ids('UPDATE dbo.A SET n = 1\nDELETE FROM dbo.B WHERE n = 0')).toContain('R31');
    const tr = 'BEGIN TRAN\nUPDATE #T SET n = 1\nCOMMIT';
    expect(ids(tr)).not.toContain('R30');
    expect(optimize(tr, { closeTran: true }).src).toBe(tr);
  });
});
