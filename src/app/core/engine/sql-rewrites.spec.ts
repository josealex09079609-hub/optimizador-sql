import { dmlTargetIsTemp, maskSql, sargRewrite, tranOnlyTemp } from './sql-rewrites';

const rw = (sql: string) => sargRewrite(sql).src;
const W = (p: string) => `SELECT x FROM dbo.T t WITH (NOLOCK) WHERE ${p}`;

describe('sql-rewrites · SUBSTRING / LEFT → LIKE', () => {
  it('SUBSTRING(col, 1, n) = literal de n caracteres', () => {
    expect(rw(W("SUBSTRING(t.cCtaCod, 1, 3) = '109'"))).toBe(W("t.cCtaCod LIKE '109%'"));
    expect(rw(W("LEFT(t.cRHCod, 1) = 'E'"))).toBe(W("t.cRHCod LIKE 'E%'"));
  });
  it('no cambia si el literal no tiene n caracteres, tiene comodines, espacios finales o el inicio no es 1', () => {
    for (const p of ["SUBSTRING(t.c, 1, 3) = '10'", "SUBSTRING(t.c, 1, 2) = '1%'", "SUBSTRING(t.c, 1, 2) = '1 '",
      "SUBSTRING(t.c, 2, 3) = '109'", "SUBSTRING(t.c, 1, 3) = @c"]) expect(rw(W(p))).toBe(W(p));
  });
  it('rangos con literales numéricos (cMovNro)', () => {
    expect(rw(W("SUBSTRING(m.cMovNro, 1, 8) BETWEEN '20261001' AND '20261031'")))
      .toBe(W("(m.cMovNro >= '20261001' AND m.cMovNro < '20261032')"));
    expect(rw(W("SUBSTRING(m.cMovNro, 1, 8) <= '20261031'"))).toBe(W("m.cMovNro < '20261032'"));
    expect(rw(W("SUBSTRING(m.cMovNro, 1, 8) >= '20261001'"))).toBe(W("m.cMovNro >= '20261001'"));
  });
});

describe('sql-rewrites · fechas', () => {
  it('CONVERT(DATE, dCol) = literal / variable DATE / CONVERT(DATE, GETDATE())', () => {
    expect(rw(W("CONVERT(DATE, t.dFecha) = '20261031'"))).toBe(W("(t.dFecha >= '20261031' AND t.dFecha < '20261101')"));
    const sql = "DECLARE @dCorte DATE = GETDATE()\n" + W('CONVERT(DATE, t.dFecha) = @dCorte');
    expect(rw(sql)).toBe("DECLARE @dCorte DATE = GETDATE()\n" + W('(t.dFecha >= @dCorte AND t.dFecha < DATEADD(DAY, 1, @dCorte))'));
    expect(rw(W('CAST(t.dFecha AS DATE) = CONVERT(DATE, GETDATE())')))
      .toBe(W('(t.dFecha >= CONVERT(DATE, GETDATE()) AND t.dFecha < DATEADD(DAY, 1, CONVERT(DATE, GETDATE())))'));
  });
  it('CONVERT(DATE, dCol) contra variable DATETIME: no se cambia (no es equivalente si trae hora)', () => {
    const sql = 'CREATE PROCEDURE dbo.PA_X_Sel @dFecha DATETIME\nAS\n' + W('CONVERT(DATE, t.dFecha) = @dFecha');
    expect(rw(sql)).toBe(sql);
  });
  it('CONVERT(DATE, dCol) con >=, >, <=, < y BETWEEN', () => {
    expect(rw(W("CONVERT(DATE, t.dFecha) <= '20261031'"))).toBe(W("t.dFecha < '20261101'"));
    expect(rw(W("CONVERT(DATE, t.dFecha) > '20261031'"))).toBe(W("t.dFecha >= '20261101'"));
    expect(rw(W("CONVERT(DATE, t.dFecha) BETWEEN '20261001' AND '20261031'")))
      .toBe(W("(t.dFecha >= '20261001' AND t.dFecha < '20261101')"));
  });
  it('CONVERT(VARCHAR(8), dCol, 112) = yyyymmdd', () => {
    expect(rw(W("CONVERT(VARCHAR(8), t.dFecha, 112) = '20261231'"))).toBe(W("(t.dFecha >= '20261231' AND t.dFecha < '20270101')"));
    expect(rw(W("CONVERT(VARCHAR(10), t.dFecha, 120) = '2026-12-31'"))).toBe(W("(t.dFecha >= '20261231' AND t.dFecha < '20270101')"));
  });
  it('YEAR(dCol) con literal, variable y YEAR(GETDATE())', () => {
    expect(rw(W('YEAR(t.dFecha) = 2026'))).toBe(W("(t.dFecha >= '20260101' AND t.dFecha < '20270101')"));
    expect(rw(W('YEAR(t.dFecha) = @nAnio'))).toBe(W('(t.dFecha >= DATEADD(YEAR, @nAnio - 1900, 0) AND t.dFecha < DATEADD(YEAR, @nAnio - 1899, 0))'));
    expect(rw(W('YEAR(t.dFecha) = YEAR(GETDATE())')))
      .toBe(W('(t.dFecha >= DATEADD(YEAR, DATEDIFF(YEAR, 0, GETDATE()), 0) AND t.dFecha < DATEADD(YEAR, DATEDIFF(YEAR, 0, GETDATE()) + 1, 0))'));
  });
  it('YEAR(dCol) = Y AND MONTH(dCol) = M → rango del mes', () => {
    expect(rw(W('YEAR(t.dFecha) = 2026 AND MONTH(t.dFecha) = 12'))).toBe(W("(t.dFecha >= '20261201' AND t.dFecha < '20270101')"));
    expect(rw(W('MONTH(t.dFecha) = @nMes AND YEAR(t.dFecha) = @nAnio')))
      .toBe(W('(t.dFecha >= DATEADD(MONTH, (@nAnio - 1900) * 12 + @nMes - 1, 0) AND t.dFecha < DATEADD(MONTH, (@nAnio - 1900) * 12 + @nMes, 0))'));
    expect(rw(W('YEAR(t.dFecha) = YEAR(GETDATE()) AND MONTH(t.dFecha) = MONTH(GETDATE())')))
      .toBe(W('(t.dFecha >= DATEADD(MONTH, DATEDIFF(MONTH, 0, GETDATE()), 0) AND t.dFecha < DATEADD(MONTH, DATEDIFF(MONTH, 0, GETDATE()) + 1, 0))'));
  });
  it('DATEDIFF(DAY, dCol, GETDATE()) con =, <= y orden inverso', () => {
    expect(rw(W('DATEDIFF(DAY, t.dFecha, GETDATE()) = 0')))
      .toBe(W('(t.dFecha >= DATEADD(DAY, DATEDIFF(DAY, 0, GETDATE()), 0) AND t.dFecha < DATEADD(DAY, DATEDIFF(DAY, 0, GETDATE()) + 1, 0))'));
    expect(rw(W('DATEDIFF(DAY, t.dFecha, GETDATE()) <= 30'))).toBe(W('t.dFecha >= DATEADD(DAY, DATEDIFF(DAY, 0, GETDATE()) - 30, 0)'));
    expect(rw(W('DATEDIFF(MONTH, @dIni, t.dFecha) >= 1'))).toBe(W('t.dFecha >= DATEADD(MONTH, DATEDIFF(MONTH, 0, @dIni) + 1, 0)'));
  });
  it('DATEADD(DAY, n, dCol) op X → dCol op DATEADD(DAY, -n, X)', () => {
    expect(rw(W('DATEADD(DAY, 30, t.dVencimiento) < GETDATE()'))).toBe(W('t.dVencimiento < DATEADD(DAY, -30, GETDATE())'));
    const month = W('DATEADD(MONTH, 1, t.dFecha) < GETDATE()');
    expect(rw(month)).toBe(month);           // sumar meses no es reversible (31 ene + 1 mes)
  });
  it('solo columnas de fecha (prefijo d) y solo en predicados', () => {
    const notDate = W("CONVERT(DATE, t.cFecha) = '20261031'");
    expect(rw(notDate)).toBe(notDate);
    const select = "SELECT YEAR(t.dFecha) AS nAnio, CASE WHEN YEAR(t.dFecha) = 2026 THEN 1 END FROM dbo.T t";
    expect(rw(select)).toBe(select);
  });
  it('NOT y OR: el rango se agrupa entre paréntesis', () => {
    expect(rw(W("NOT CONVERT(DATE, t.dFecha) = '20261031' OR t.n = 1")))
      .toBe(W("NOT (t.dFecha >= '20261031' AND t.dFecha < '20261101') OR t.n = 1"));
  });
  it('respeta comentarios y literales', () => {
    const sql = "-- WHERE YEAR(t.dFecha) = 2026\nSELECT 'YEAR(t.dFecha) = 2026' FROM dbo.T t";
    expect(rw(sql)).toBe(sql);
  });
  it('detalle de cambios con línea', () => {
    const r = sargRewrite("SELECT 1\nFROM dbo.T t\nWHERE YEAR(t.dFecha) = 2026");
    expect(r.count).toBe(1);
    expect(r.changes[0].line).toBe(3);
  });
});

describe('sql-rewrites · DML sobre temporales', () => {
  const at = (sql: string, kw: string) => dmlTargetIsTemp(maskSql(sql), sql.indexOf(kw));
  it('detecta el destino temporal directo y por alias', () => {
    expect(at('UPDATE #T SET n = 1', 'UPDATE')).toBe(true);
    expect(at('DELETE FROM #T WHERE n = 1', 'DELETE')).toBe(true);
    expect(at('UPDATE t SET t.n = 1 FROM #Pend t INNER JOIN dbo.P p ON p.id = t.id', 'UPDATE')).toBe(true);
    expect(at('DELETE d FROM @Det d WHERE d.n = 0', 'DELETE')).toBe(true);
    expect(at('UPDATE p SET p.n = 1 FROM dbo.P p INNER JOIN #T t ON t.id = p.id', 'UPDATE')).toBe(false);
    expect(at('DELETE FROM dbo.Log WHERE n = 1', 'DELETE')).toBe(false);
  });
  it('transacciones que solo tocan temporales', () => {
    expect(tranOnlyTemp('BEGIN TRAN\nUPDATE #T SET n = 1\nDELETE FROM @V\nCOMMIT')).toBe(true);
    expect(tranOnlyTemp('BEGIN TRAN\nUPDATE #T SET n = 1\nUPDATE dbo.P SET n = 1\nCOMMIT')).toBe(false);
    expect(tranOnlyTemp('BEGIN TRAN\nUPDATE #T SET n = 1\nEXEC dbo.PA_Otro\nCOMMIT')).toBe(false);
    expect(tranOnlyTemp('UPDATE #T SET n = 1')).toBe(false);
  });
});
