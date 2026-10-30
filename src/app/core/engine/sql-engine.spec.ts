import { analyze, dictionary, optimize } from './sql-engine';
import { diffLines } from './diff';

const ids = (sql: string) => analyze(sql).findings.map(f => f.id);
const r09 = (sql: string) => analyze(sql).findings.find(f => f.id === 'R09');

describe('sql-engine (skill pa-sqlserver-cajaica)', () => {
  it('conserva los comentarios de cabecera y elimina el código comentado del cuerpo', () => {
    const sql = `-- Autor: GCN\n-- SELECT x FROM y\nCREATE PROCEDURE dbo.PA_X_Sel\nAS\nBEGIN\n    -- SELECT * FROM dbo.T\n    SELECT a FROM dbo.T WITH (NOLOCK)\nEND`;
    const out = optimize(sql, { removeComments: true }).src;
    expect(out).toContain('-- Autor: GCN');
    expect(out).toContain('-- SELECT x FROM y');
    expect(out).not.toContain('-- SELECT * FROM dbo.T');
  });

  it('convierte JOIN a INNER JOIN', () => {
    expect(optimize('SELECT a.x FROM dbo.A a WITH (NOLOCK) JOIN dbo.B b WITH (NOLOCK) ON a.id = b.id', { innerJoin: true }).src)
      .toContain('INNER JOIN dbo.B');
  });

  it('convierte SELECT INTO # en CREATE TABLE + INSERT INTO con COLLATE', () => {
    const out = optimize('SELECT C.cCtaCod, COUNT(1) nTotal INTO #T FROM dbo.Credito C GROUP BY C.cCtaCod', { selectInto: true }).src;
    expect(out).toContain('CREATE TABLE #T');
    expect(out).toContain('COLLATE SQL_Latin1_General_CP1_CI_AS');
    expect(out).toContain('INSERT INTO #T (cCtaCod, nTotal)');
  });

  it('cierra transacciones abiertas con TRY/CATCH, COMMIT, ROLLBACK y THROW', () => {
    const sql = 'CREATE PROCEDURE dbo.PA_X_Upd\nAS\nBEGIN\n    BEGIN TRAN\n    UPDATE dbo.T SET n = 1\nEND';
    expect(ids(sql)).toContain('R46');
    const out = optimize(sql, { closeTran: true }).src;
    expect(out).toContain('COMMIT TRANSACTION;');
    expect(out).toContain('ROLLBACK TRANSACTION;');
    expect(out).toContain('THROW;');
  });

  describe('NOLOCK', () => {
    const fix = (sql: string) => optimize(sql, { addNolock: true, nolockTemp: true }).src;
    const yaCorrectos = [
      'SELECT a.x FROM dbo.A a WITH(NOLOCK)',
      'SELECT b.x FROM dbo.B AS b with (nolock)',
      'SELECT x FROM dbo.E WITH (NOLOCK)',
      'SELECT f.x FROM [dbo].[F] f\n    WITH (NOLOCK)',
      'SELECT g.x FROM dbo.G g WITH (READUNCOMMITTED)',
      'SELECT h.x FROM dbo.H h WITH (NOLOCK, INDEX(IX_1))',
      'SELECT k.x FROM DBRCC.dbo.K k WITH(NoLock)'
    ];
    for (const sql of yaCorrectos) {
      it(`no lo reporta ni lo duplica: ${sql.replace(/\n\s*/g, ' ')}`, () => {
        expect(r09(sql)).toBeUndefined();
        expect(fix(sql)).toBe(sql);
      });
    }

    it('deja un solo WITH (NOLOCK) por tabla física', () => {
      expect(fix('SELECT a.x FROM dbo.A a WITH (NOLOCK) WITH (NOLOCK)')).toBe('SELECT a.x FROM dbo.A a WITH (NOLOCK)');
      expect(fix('SELECT b.x FROM dbo.B b (NOLOCK) WITH (NOLOCK)')).toBe('SELECT b.x FROM dbo.B b WITH (NOLOCK)');
      expect(fix('SELECT c.x FROM dbo.C c WITH (NOLOCK, NOLOCK)')).toBe('SELECT c.x FROM dbo.C c WITH (NOLOCK)');
      expect(fix('SELECT d.x FROM dbo.D d WITH (NOLOCK, READUNCOMMITTED)')).toBe('SELECT d.x FROM dbo.D d WITH (NOLOCK)');
      expect(fix('SELECT e.x FROM dbo.E e (NOLOCK)')).toBe('SELECT e.x FROM dbo.E e WITH (NOLOCK)');
      expect(fix('SELECT g.x FROM dbo.G g WITH (INDEX(IX_1)) WITH (NOLOCK)')).toBe('SELECT g.x FROM dbo.G g WITH (INDEX(IX_1), NOLOCK)');
      expect(ids('SELECT a.x FROM dbo.A a WITH (NOLOCK) WITH (NOLOCK)')).toContain('R65');
    });

    it('las temporales y variables tabla no llevan NOLOCK', () => {
      expect(fix('SELECT t.x FROM #T t WITH (NOLOCK) INNER JOIN @V v (NOLOCK) ON v.id = t.id'))
        .toBe('SELECT t.x FROM #T t INNER JOIN @V v ON v.id = t.id');
    });

    it('lo agrega solo donde falta y respeta UPDLOCK', () => {
      expect(fix('SELECT i.x FROM dbo.I i INNER JOIN dbo.J j WITH (NOLOCK) ON j.id = i.id'))
        .toBe('SELECT i.x FROM dbo.I i WITH (NOLOCK) INNER JOIN dbo.J j WITH (NOLOCK) ON j.id = i.id');
      const upd = 'SELECT u.x FROM dbo.U u WITH (UPDLOCK)';
      expect(fix(upd)).toBe(upd);
    });

    it('UPDATE con JOIN: sin NOLOCK en la tabla que se modifica, con NOLOCK en las unidas', () => {
      const sql = 'UPDATE P SET nEstado = 2\nFROM dbo.Producto P WITH (NOLOCK)\nINNER JOIN dbo.Credito C ON C.cCtaCod = P.cCtaCod\n'
        + 'WHERE EXISTS (SELECT 1 FROM dbo.Agencia A WHERE A.cAgeCod = C.cAgeCod)';
      expect(ids(sql)).toContain('R50');
      expect(fix(sql)).toBe('UPDATE P SET nEstado = 2\nFROM dbo.Producto P\nINNER JOIN dbo.Credito C WITH (NOLOCK) ON C.cCtaCod = P.cCtaCod\n'
        + 'WHERE EXISTS (SELECT 1 FROM dbo.Agencia A WITH (NOLOCK) WHERE A.cAgeCod = C.cAgeCod)');
    });

    it('UPDATE con hint en la cabecera y UPDATE por nombre de tabla', () => {
      expect(fix('UPDATE dbo.Cuenta WITH (NOLOCK) SET n = 0 WHERE c = @c')).toBe('UPDATE dbo.Cuenta SET n = 0 WHERE c = @c');
      const byName = 'UPDATE dbo.Cuenta SET n = X.n FROM dbo.Cuenta INNER JOIN #S X ON X.c = dbo.Cuenta.c';
      expect(fix(byName)).toBe(byName);
    });

    it('DELETE con JOIN: sin NOLOCK en la tabla que se elimina, con NOLOCK en las unidas', () => {
      const sql = 'DELETE D\nFROM dbo.Detalle D (NOLOCK)\nINNER JOIN dbo.Cabecera CB ON CB.nId = D.nId\nLEFT JOIN dbo.Estado ES WITH (NOLOCK) WITH (NOLOCK) ON ES.n = CB.n';
      expect(fix(sql)).toBe('DELETE D\nFROM dbo.Detalle D\nINNER JOIN dbo.Cabecera CB WITH (NOLOCK) ON CB.nId = D.nId\nLEFT JOIN dbo.Estado ES WITH (NOLOCK) ON ES.n = CB.n');
      expect(fix('DELETE FROM dbo.Log WHERE nId IN (SELECT nId FROM dbo.Log L2 WHERE L2.d < @d)'))
        .toBe('DELETE FROM dbo.Log WHERE nId IN (SELECT nId FROM dbo.Log L2 WITH (NOLOCK) WHERE L2.d < @d)');
    });

    it('INSERT hacia tabla física: no agrega NOLOCK al origen; hacia #temporal sí', () => {
      expect(fix('INSERT INTO dbo.Hist (a) SELECT a FROM dbo.Fuente')).toBe('INSERT INTO dbo.Hist (a) SELECT a FROM dbo.Fuente');
      expect(fix('INSERT INTO #Tmp (a) SELECT a FROM dbo.Fuente')).toBe('INSERT INTO #Tmp (a) SELECT a FROM dbo.Fuente WITH (NOLOCK)');
    });

    it('es idempotente (una segunda pasada no cambia nada)', () => {
      const once = fix('SELECT a.x FROM dbo.A a (NOLOCK) INNER JOIN dbo.B b ON b.id = a.id\nUPDATE t SET n = 1 FROM dbo.T t INNER JOIN dbo.U u ON u.id = t.id');
      expect(fix(once)).toBe(once);
    });
  });

  describe('COUNT(*) → COUNT(1)', () => {
    it('reemplaza en código y respeta literales y comentarios', () => {
      const sql = "SELECT COUNT(*) AS nTotal, count( * ) n2, 'COUNT(*)' AS cTexto FROM dbo.P WITH (NOLOCK) -- COUNT(*)";
      expect(ids(sql)).toContain('R62');
      expect(optimize(sql, { countOne: true }).src)
        .toBe("SELECT COUNT(1) AS nTotal, count(1) n2, 'COUNT(*)' AS cTexto FROM dbo.P WITH (NOLOCK) -- COUNT(*)");
    });
  });

  describe('EXISTS (SELECT 1)', () => {
    it('IF EXISTS / IF NOT EXISTS / WHERE EXISTS', () => {
      const sql = 'IF EXISTS (SELECT * FROM dbo.C WITH (NOLOCK) WHERE x = 1) PRINT 1\n'
        + 'IF NOT EXISTS(SELECT TOP 1 C.a, C.b\n    FROM dbo.C C WITH (NOLOCK)) PRINT 2\n'
        + 'SELECT a.x FROM dbo.A a WITH (NOLOCK) WHERE EXISTS (SELECT DISTINCT b.id FROM dbo.B b WITH (NOLOCK) WHERE b.id = a.id)';
      expect(ids(sql)).toContain('R63');
      const out = optimize(sql, { existsOne: true }).src;
      expect(out).toContain('IF EXISTS (SELECT 1 FROM dbo.C');
      expect(out).toContain('IF NOT EXISTS(SELECT 1\n    FROM dbo.C C');
      expect(out).toContain('WHERE EXISTS (SELECT 1 FROM dbo.B b');
      expect(ids(out)).not.toContain('R63');
    });

    it('no toca SELECT 1, UNION ni agregados sin GROUP BY (los reporta)', () => {
      const ok = 'IF EXISTS (SELECT 1 FROM dbo.T WITH (NOLOCK)) PRINT 1';
      expect(optimize(ok, { existsOne: true }).src).toBe(ok);
      const union = 'IF EXISTS (SELECT a FROM dbo.T1 WITH (NOLOCK) UNION SELECT a FROM dbo.T2 WITH (NOLOCK)) PRINT 1';
      expect(optimize(union, { existsOne: true }).src).toBe(union);
      const agg = 'IF EXISTS (SELECT COUNT(1) FROM dbo.T WITH (NOLOCK) WHERE n = 1) PRINT 1';
      expect(optimize(agg, { existsOne: true }).src).toBe(agg);
      expect(ids(agg)).toContain('R64');
    });

    it('sí cambia si el agregado está en una subconsulta anidada', () => {
      expect(optimize('IF EXISTS (SELECT (SELECT MAX(x) FROM dbo.Z WITH (NOLOCK)) AS m FROM dbo.Y WITH (NOLOCK)) PRINT 1', { existsOne: true }).src)
        .toBe('IF EXISTS (SELECT 1 FROM dbo.Y WITH (NOLOCK)) PRINT 1');
    });
  });

  it('IN de un solo valor → =', () => {
    expect(optimize("SELECT a FROM dbo.T WHERE c IN ('1') AND n NOT IN (2)", { singleIn: true }).src)
      .toContain("c = '1' AND n <> 2");
  });

  it('no agrega SET NOCOUNT ON por defecto (PA existente)', () => {
    expect(optimize('CREATE PROCEDURE dbo.PA_X_Sel\nAS\nBEGIN\n    SELECT 1\nEND', {}).src).not.toContain('NOCOUNT');
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
