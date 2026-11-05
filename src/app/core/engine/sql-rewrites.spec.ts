import { dmlTargetIsTemp, maskSql, physicalDml, sargPending, sargRewrite, tranOnlyTemp } from './sql-rewrites';

const rw = (sql: string) => sargRewrite(sql).src;
const W = (p: string) => `SELECT x FROM dbo.T t WITH (NOLOCK) WHERE ${p}`;

describe('sql-rewrites · SUBSTRING / LEFT', () => {
  it('SUBSTRING(col, 1, n) / LEFT(col, n) = literal → LIKE prefijo', () => {
    expect(rw(W("SUBSTRING(t.cCtaCod, 1, 3) = '109'"))).toBe(W("t.cCtaCod LIKE '109%'"));
    expect(rw(W("LEFT(t.cRHCod, 1) = 'E'"))).toBe(W("t.cRHCod LIKE 'E%'"));
  });
  it('SUBSTRING(col, s, n) con s > 1 → LIKE con guiones bajos', () => {
    expect(rw(W("SUBSTRING(cs.cCtaCod, 6, 3) = '305'"))).toBe(W("cs.cCtaCod LIKE '_____305%'"));
    expect(rw(W("SUBSTRING(A.cCtaCod, 9, 1) = '1'"))).toBe(W("A.cCtaCod LIKE '________1%'"));
  });
  it('SUBSTRING IN (lista de literales)', () => {
    expect(rw(W("SUBSTRING(cs.cCtaCod, 6, 3) IN ('305', '302')"))).toBe(W("(cs.cCtaCod LIKE '_____305%' OR cs.cCtaCod LIKE '_____302%')"));
    expect(rw(W("SUBSTRING(t.cCtaCod, 1, 3) IN ('109')"))).toBe(W("t.cCtaCod LIKE '109%'"));
  });
  it('número sin comillas de n dígitos', () => {
    expect(rw(W('SUBSTRING(cs.cCtaCod, 6, 3) = 305'))).toBe(W("cs.cCtaCod LIKE '_____305%'"));
    expect(rw(W('SUBSTRING(cs.cCtaCod, 6, 3) IN (305, 302)'))).toBe(W("(cs.cCtaCod LIKE '_____305%' OR cs.cCtaCod LIKE '_____302%')"));
    expect(rw(W('SUBSTRING(cs.cCtaCod, 6, 3) = 5'))).toBe(W('SUBSTRING(cs.cCtaCod, 6, 3) = 5'));
    expect(rw(W('SUBSTRING(cs.cCtaCod, 6, 3) = 030'))).toBe(W('SUBSTRING(cs.cCtaCod, 6, 3) = 030'));
  });
  it('pendientes: explica por qué no se reescribe', () => {
    const p = sargPending(W("SUBSTRING(cs.cCtaCod, 6, 3) = @cProd AND SUBSTRING(a.cCtaCod, 1, 18) = b.cCtaCod AND SUBSTRING(cs.cCtaCod, 6, 3) = '305'"));
    expect(p.length).toBe(2);
    expect(p[0].reason).toContain('variable @cProd');
    expect(p[1].reason).toContain('otra columna');
  });
  it('literal a la izquierda', () => {
    expect(rw(W("'305' = SUBSTRING(cs.cCtaCod, 6, 3) AND t.n = 1"))).toBe(W("cs.cCtaCod LIKE '_____305%' AND t.n = 1"));
    expect(rw(W("t.n = 1 AND '109' = LEFT(t.cCtaCod, 3)"))).toBe(W("t.n = 1 AND t.cCtaCod LIKE '109%'"));
  });
  it('rangos con literales numéricos (cMovNro)', () => {
    expect(rw(W("SUBSTRING(m.cMovNro, 1, 8) BETWEEN '20261001' AND '20261031'")))
      .toBe(W("(m.cMovNro >= '20261001' AND m.cMovNro < '20261032')"));
    expect(rw(W("SUBSTRING(m.cMovNro, 1, 8) <= '20261031'"))).toBe(W("m.cMovNro < '20261032'"));
  });
  it('NO se reescribe: variables, otras columnas, largo distinto, comodines, espacios finales, IN con variable, NOT IN', () => {
    for (const p of [
      "SUBSTRING(cs.cCtaCod, 6, 3) = @cProducto",
      "SUBSTRING(a.cCtaCod, 1, 8) = b.cMovNro",
      "SUBSTRING(t.c, 1, 3) = '10'", "SUBSTRING(t.c, 1, 2) = '1%'", "SUBSTRING(t.c, 1, 2) = '1 '",
      "SUBSTRING(t.c, 6, 3) IN ('305', @c)", "SUBSTRING(t.c, 6, 3) NOT IN ('305')", "SUBSTRING(t.c, 6, 3) <> '305'"
    ]) expect(rw(W(p))).toBe(W(p));
  });
  it('fuera de filtros (SELECT, CASE, SET) no se toca', () => {
    const s = "SELECT SUBSTRING(t.cCtaCod, 6, 3) AS cProd, CASE WHEN SUBSTRING(t.cCtaCod, 6, 3) = '305' THEN 1 END FROM dbo.T t";
    expect(rw(s)).toBe(s);
  });
});

describe('sql-rewrites · fechas', () => {
  it('CONVERT(DATE, dCol) contra literal, variable DATE y GETDATE', () => {
    expect(rw(W("CONVERT(DATE, t.dFecha) = '20261031'"))).toBe(W("(t.dFecha >= '20261031' AND t.dFecha < '20261101')"));
    const sql = "DECLARE @dCorte DATE = GETDATE()\n" + W('CONVERT(DATE, t.dFecha) = @dCorte');
    expect(rw(sql)).toBe("DECLARE @dCorte DATE = GETDATE()\n" + W('(t.dFecha >= @dCorte AND t.dFecha < DATEADD(DAY, 1, @dCorte))'));
  });
  it('variable DATETIME: no es equivalente, no se cambia', () => {
    const sql = 'CREATE PROCEDURE dbo.PA_X_Sel @dFecha DATETIME\nAS\n' + W('CONVERT(DATE, t.dFecha) = @dFecha');
    expect(rw(sql)).toBe(sql);
  });
  it('variable a la izquierda', () => {
    const sql = "DECLARE @dCorte DATE\n" + W('@dCorte = CONVERT(DATE, t.dFecha)');
    expect(rw(sql)).toBe("DECLARE @dCorte DATE\n" + W('(t.dFecha >= @dCorte AND t.dFecha < DATEADD(DAY, 1, @dCorte))'));
  });
  it('YEAR, YEAR + MONTH, DATEDIFF y DATEADD', () => {
    expect(rw(W('YEAR(t.dFecha) = 2026'))).toBe(W("(t.dFecha >= '20260101' AND t.dFecha < '20270101')"));
    expect(rw(W('YEAR(t.dFecha) = 2026 AND MONTH(t.dFecha) = 12'))).toBe(W("(t.dFecha >= '20261201' AND t.dFecha < '20270101')"));
    expect(rw(W('DATEDIFF(DAY, t.dFecha, GETDATE()) <= 30'))).toBe(W('t.dFecha >= DATEADD(DAY, DATEDIFF(DAY, 0, GETDATE()) - 30, 0)'));
    expect(rw(W('DATEADD(DAY, 30, t.dVencimiento) < GETDATE()'))).toBe(W('t.dVencimiento < DATEADD(DAY, -30, GETDATE())'));
    const m = W('DATEADD(MONTH, 1, t.dFecha) < GETDATE()');
    expect(rw(m)).toBe(m);
  });
  it('CONVERT(VARCHAR(8), dCol, 112)', () => {
    expect(rw(W("CONVERT(VARCHAR(8), t.dFecha, 112) = '20261231'"))).toBe(W("(t.dFecha >= '20261231' AND t.dFecha < '20270101')"));
  });
  it('respeta comentarios y literales', () => {
    const s = "-- WHERE YEAR(t.dFecha) = 2026\nSELECT 'SUBSTRING(t.c, 1, 3) = ''109''' FROM dbo.T t";
    expect(rw(s)).toBe(s);
  });
});

describe('sql-rewrites · DML sobre temporales', () => {
  const at = (sql: string, kw: string) => dmlTargetIsTemp(maskSql(sql), sql.indexOf(kw));
  it('destino temporal directo y por alias', () => {
    expect(at('UPDATE #T SET n = 1', 'UPDATE')).toBe(true);
    expect(at('UPDATE t SET t.n = 1 FROM #Pend t INNER JOIN dbo.P p ON p.id = t.id', 'UPDATE')).toBe(true);
    expect(at('DELETE d FROM @Det d WHERE d.n = 0', 'DELETE')).toBe(true);
    expect(at('UPDATE p SET p.n = 1 FROM dbo.P p INNER JOIN #T t ON t.id = p.id', 'UPDATE')).toBe(false);
  });
  it('transacciones y DML físico', () => {
    expect(tranOnlyTemp('BEGIN TRAN\nUPDATE #T SET n = 1\nDELETE FROM @V\nCOMMIT')).toBe(true);
    expect(tranOnlyTemp('BEGIN TRAN\nUPDATE #T SET n = 1\nUPDATE dbo.P SET n = 1\nCOMMIT')).toBe(false);
    expect(tranOnlyTemp('BEGIN TRAN\nEXEC dbo.PA_Otro\nCOMMIT')).toBe(false);
    expect(physicalDml('UPDATE #T SET n=1\nUPDATE t SET n=2 FROM #X t\nDELETE FROM dbo.P\nINSERT INTO dbo.H (a) SELECT 1').length).toBe(2);
  });
});
