import { analyze, dictionary, optimize } from './sql-engine';
import { diffLines } from './diff';

const ids = (sql: string) => analyze(sql).findings.map(f => f.id);

describe('sql-engine (skill pa-sqlserver-cajaica)', () => {
  it('conserva los comentarios de cabecera y elimina el código comentado del cuerpo', () => {
    const sql = `-- Autor: GCN\n-- SELECT x FROM y\nCREATE PROCEDURE dbo.PA_X_Sel\nAS\nBEGIN\n    -- SELECT * FROM dbo.T\n    SELECT a FROM dbo.T WITH (NOLOCK)\nEND`;
    const out = optimize(sql, { removeComments: true }).src;
    expect(out).toContain('-- Autor: GCN');
    expect(out).toContain('-- SELECT x FROM y');
    expect(out).not.toContain('-- SELECT * FROM dbo.T');
  });

  it('convierte JOIN a INNER JOIN', () => {
    const out = optimize('SELECT a.x FROM dbo.A a JOIN dbo.B b ON a.id = b.id', { innerJoin: true }).src;
    expect(out).toContain('INNER JOIN dbo.B');
  });

  it('convierte SELECT INTO # en CREATE TABLE + INSERT INTO con COLLATE', () => {
    const out = optimize('SELECT C.cCtaCod, COUNT(1) nTotal INTO #T FROM dbo.Credito C GROUP BY C.cCtaCod', { selectInto: true }).src;
    expect(out).toContain('CREATE TABLE #T');
    expect(out).toContain('COLLATE SQL_Latin1_General_CP1_CI_AS');
    expect(out).toContain('INSERT INTO #T (cCtaCod, nTotal)');
    expect(out).not.toMatch(/INTO #T\s+FROM/);
  });

  it('cierra transacciones abiertas con TRY/CATCH, COMMIT, ROLLBACK y THROW', () => {
    const sql = 'CREATE PROCEDURE dbo.PA_X_Upd\nAS\nBEGIN\n    BEGIN TRAN\n    UPDATE dbo.T SET n = 1\nEND';
    expect(ids(sql)).toContain('R46');
    const out = optimize(sql, { closeTran: true }).src;
    expect(out).toContain('COMMIT TRANSACTION;');
    expect(out).toContain('ROLLBACK TRANSACTION;');
    expect(out).toContain('THROW;');
  });

  it('política NOLOCK: lecturas sí, destino de DML hacia tabla física no', () => {
    const sql = 'INSERT INTO #T (a) SELECT a FROM dbo.A\nUPDATE dbo.B SET x = 1 FROM dbo.B INNER JOIN dbo.C ON C.id = B.id';
    const out = optimize(sql, { addNolock: true }).src;
    expect(out).toContain('FROM dbo.A WITH (NOLOCK)');
    expect(out).not.toContain('dbo.C WITH (NOLOCK)');
  });

  it('IN de un solo valor → =', () => {
    expect(optimize("SELECT a FROM dbo.T WHERE c IN ('1') AND n NOT IN (2)", { singleIn: true }).src)
      .toContain("c = '1' AND n <> 2");
  });

  it('no agrega SET NOCOUNT ON por defecto (PA existente)', () => {
    const out = optimize('CREATE PROCEDURE dbo.PA_X_Sel\nAS\nBEGIN\n    SELECT 1\nEND', {}).src;
    expect(out).not.toContain('NOCOUNT');
  });

  it('genera diccionario idempotente', () => {
    const d = dictionary('CREATE PROCEDURE Creditos.PA_X_Sel @cCtaCod VARCHAR(18)\nAS\nBEGIN SELECT 1 END');
    expect(d).toContain('IF NOT EXISTS');
    expect(d).toContain("@level2name = N'@cCtaCod'");
  });

  it('calcula la comparación antes/después', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(d.removed).toBe(1);
    expect(d.added).toBe(2);
  });
});
