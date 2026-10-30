import { analyze, analyzePlan, combine, decodePlanBytes, dictionary, improvePlan, optimize, planScore } from './sql-engine';
import { diffLines } from './diff';
import { SAMPLE_PLAN, SAMPLE_SQL } from '../../shared/sample';

const ids = (sql: string) => analyze(sql).findings.map(f => f.id);
const r09 = (sql: string) => analyze(sql).findings.find(f => f.id === 'R09');

/** Plan mínimo con una sentencia y advertencias opcionales. */
function plan(stmt: string, inner: string, runtime = true): string {
  const rti = runtime ? '<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="10" ActualExecutions="1" /></RunTimeInformation>' : '';
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="utf-16"?><ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.539" Build="15.0.2000.5"><BatchSequence><Batch><Statements>
<StmtSimple StatementText="${esc(stmt)}" StatementId="1" StatementType="SELECT" StatementSubTreeCost="1"><QueryPlan DegreeOfParallelism="1">${inner}
<RelOp NodeId="0" PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="10">${rti}</RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
}
const conv = (type: string, col: string, issue = 'Seek Plan') =>
  `<Warnings><PlanAffectingConvert ConvertIssue="${issue}" Expression="CONVERT_IMPLICIT(${type},[DB].[dbo].${col},0)" /></Warnings>`;

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
  });

  it('IN de un solo valor → =', () => {
    expect(optimize("SELECT a FROM dbo.T WHERE c IN ('1') AND n NOT IN (2)", { singleIn: true }).src).toContain("c = '1' AND n <> 2");
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

describe('Plan de ejecución', () => {
  it('rechaza archivos que no son planes', () => {
    const p = analyzePlan('<root/>');
    expect(p.ok).toBe(false);
    expect(p.error).toContain('ShowPlanXML');
  });

  it('decodifica .sqlplan en UTF-16 con BOM', () => {
    const txt = '<ShowPlanXML/>';
    const bytes = new Uint8Array(2 + txt.length * 2);
    bytes[0] = 0xFF; bytes[1] = 0xFE;
    for (let i = 0; i < txt.length; i++) bytes[2 + i * 2] = txt.charCodeAt(i);
    expect(decodePlanBytes(bytes)).toBe(txt);
  });

  it('plan de ejemplo: detecta spill, conversiones, sobreestimación de memoria e índice faltante', () => {
    const p = analyzePlan(SAMPLE_PLAN, SAMPLE_SQL);
    expect(p.ok).toBe(true);
    expect(p.isActual).toBe(true);
    expect(p.statements.length).toBe(4);
    const pids = p.findings.map(f => f.id);
    for (const id of ['P01', 'P02', 'P04', 'P06', 'P07', 'P08', 'P09', 'P11', 'P15']) expect(pids).toContain(id);
    expect(p.statements[0].line).toBe(21);
  });

  it('aplica las correcciones del plan y las marca como resueltas', () => {
    const p = analyzePlan(SAMPLE_PLAN, SAMPLE_SQL);
    const o = optimize(SAMPLE_SQL, { planConvert: true, planSort: true }, p);
    expect(o.src).toContain('DECLARE @pcPersCodLocal VARCHAR(13) = @pcPersCod;');
    expect(o.src).toContain('ccc.cPersCodAnalista = @pcPersCodLocal');
    expect(o.src).toContain('@pcPersCod NVARCHAR(13),');           // la firma no cambia
    expect(o.src).toContain('cCtaCod VARCHAR(18)');                  // columna de la temporal
    expect(o.src).not.toContain('ORDER BY cc.nIdComite DESC');       // Sort con spill
    expect(o.src).toContain('-- SELECT * FROM #DataCredit');         // no borra lo que sigue
    expect(o.planFixed.length).toBe(3);
    const after = combine(analyze(o.src), p, o.planFixed);
    expect(after.findings.some(f => f.id === 'P02')).toBe(false);
    expect(after.findings.some(f => f.id === 'P01')).toBe(false);
  });

  it('VARCHAR(MAX) → VARCHAR(2000) solo con la opción y si hay sobreestimación', () => {
    const p = analyzePlan(SAMPLE_PLAN, SAMPLE_SQL);
    expect(optimize(SAMPLE_SQL, {}, p).src).toContain('cPersNombre VARCHAR(MAX)');
    expect(optimize(SAMPLE_SQL, { planMaxGrant: true }, p).src).toContain('cPersNombre VARCHAR(2000) /* TODO');
  });

  it('quita la N de un literal y corrige variables locales NVARCHAR', () => {
    const sql = "DECLARE @c NVARCHAR(18) = '001'\nSELECT p.x FROM dbo.Producto p WITH (NOLOCK) WHERE p.cCtaCod = @c AND p.cEstado = N'A'";
    const xml = plan(sql.split('\n')[1], conv('nvarchar(18)', '[Producto].[cCtaCod] as [p].[cCtaCod]') + conv('nvarchar(1)', '[Producto].[cEstado] as [p].[cEstado]'));
    const p = analyzePlan(xml, sql);
    const o = optimize(sql, { planConvert: true }, p).src;
    expect(o).toContain('DECLARE @c VARCHAR(18)');
    expect(o).toContain("p.cEstado = 'A'");
  });

  it('revisión principal: spill primero y conteos de los cinco indicadores', () => {
    const p = analyzePlan(SAMPLE_PLAN);
    expect(p.findings[0].id).toBe('P01');
    expect(p.findings[0].main).toBe(true);
    expect(JSON.stringify(p.focus)).toBe(JSON.stringify({ spills: 1, converts: 2, tableScans: 1, memory: 1, residual: 2 }));
    const firstOther = p.findings.findIndex(f => !f.main);
    expect(p.findings.slice(firstOther).some(f => f.main)).toBe(false);
  });

  it('solo reporta conversiones implícitas marcadas como alerta (PlanAffectingConvert)', () => {
    const sql = 'SELECT p.x FROM dbo.Producto p WITH (NOLOCK) WHERE p.cCodigo = @c';
    const pred = '<RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1"><IndexScan><Object Database="[DB]" Schema="[dbo]" Table="[Producto]" Alias="[p]" />'
      + '<Predicate><ScalarOperator ScalarString="CONVERT_IMPLICIT(nvarchar(10),[DB].[dbo].[Producto].[cCodigo] as [p].[cCodigo],0)=[@c]" /></Predicate></IndexScan></RelOp>';
    expect(analyzePlan(plan(sql, pred), sql).findings.some(f => f.id === 'P02' || f.id === 'P03')).toBe(false);
    expect(analyzePlan(SAMPLE_PLAN).findings.some(f => /#Pendientes/.test(f.title))).toBe(false);
  });

  it('Table Scan: detecta el heap y propone índice clustered con la columna del filtro', () => {
    const t = analyzePlan(SAMPLE_PLAN).findings.find(f => f.id === 'P15')!;
    expect(t.title).toContain('dbo.Agencias');
    expect(t.proposal!.sql!).toContain('CREATE CLUSTERED INDEX CIX_Agencias');
    expect(t.proposal!.sql!).toContain('[cAgeCod]');
  });

  it('memoria: solo sobreestimación elevada (>= 50 MB y < 10 % usado)', () => {
    const sql = 'SELECT p.x FROM dbo.Producto p WITH (NOLOCK) ORDER BY p.x';
    const mg = (g: number, u: number) => `<MemoryGrantInfo GrantedMemory="${g}" MaxUsedMemory="${u}" />`;
    expect(analyzePlan(plan(sql, mg(20480, 100)), sql).findings.some(f => f.id === 'P04')).toBe(false);
    expect(analyzePlan(plan(sql, mg(102400, 50000)), sql).findings.some(f => f.id === 'P04')).toBe(false);
    expect(analyzePlan(plan(sql, mg(102400, 1000)), sql).findings.some(f => f.id === 'P04')).toBe(true);
  });

  it('lectura residual elevada: Seek o Scan que lee 10x o más de lo que devuelve', () => {
    const r = analyzePlan(SAMPLE_PLAN).findings.filter(f => f.id === 'P08');
    expect(r.length).toBe(2);
    expect(r[0].detail).toContain('cumplieron el filtro');
    const sql = 'SELECT p.x FROM dbo.Producto p WITH (NOLOCK) WHERE p.n = 1';
    const seek = (read: number, rows: number) => `<RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="${rows}"><RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="${rows}" ActualRowsRead="${read}" ActualExecutions="1" /></RunTimeInformation><IndexScan><Object Database="[DB]" Schema="[dbo]" Table="[Producto]" Alias="[p]" /></IndexScan></RelOp>`;
    expect(analyzePlan(plan(sql, seek(500000, 200)), sql).findings.some(f => f.id === 'P08')).toBe(true);
    expect(analyzePlan(plan(sql, seek(5000, 200)), sql).findings.some(f => f.id === 'P08')).toBe(false);
  });

  it('conversión a número: se reporta pero no se cambia (no es equivalente)', () => {
    const sql = 'SELECT p.x FROM dbo.Producto p WITH (NOLOCK) WHERE p.cCodigo = 5';
    const p = analyzePlan(plan(sql, conv('int', '[Producto].[cCodigo] as [p].[cCodigo]')), sql);
    const f = p.findings.find(x => x.id === 'P02')!;
    expect(f.autofix).toBe(false);
    expect(f.rec).toContain('no es equivalente');
    expect(optimize(sql, { planConvert: true }, p).src).toBe(sql);
  });

  it('plan estimado: avisa que faltan datos reales', () => {
    const sql = 'SELECT p.x FROM dbo.Producto p WITH (NOLOCK)';
    const p = analyzePlan(plan(sql, '', false), sql);
    expect(p.isActual).toBe(false);
    expect(p.findings.map(f => f.id)).toContain('P00');
  });

  it('plan de otro código: no aplica correcciones', () => {
    const p = analyzePlan(SAMPLE_PLAN, 'SELECT 1');
    expect(p.statements[0].line).toBe(0);
    expect(optimize('SELECT 1', { planConvert: true, planSort: true }, p).src).toBe('SELECT 1');
  });

  it('incluye una mejora propuesta en cada hallazgo del plan', () => {
    const p = analyzePlan(SAMPLE_PLAN, SAMPLE_SQL);
    const sinPropuesta = p.findings.filter(f => !f.proposal);
    expect(sinPropuesta.length).toBe(0);
    const idx = p.findings.find(f => f.id === 'P06')!;
    expect(idx.proposal!.sql!).toContain('CREATE NONCLUSTERED INDEX');
    const dev = p.findings.find(f => f.id === 'P09' && /colocComiteColocacion/.test(f.proposal!.sql || ''))!;
    expect(dev.proposal!.sql!).toContain('UPDATE STATISTICS [dbo].[colocComiteColocacion]');
    const conv2 = p.findings.find(f => f.id === 'P02' && /Producto/.test(f.title))!;
    expect(conv2.proposal!.text).toContain('#DataCredit.cCtaCod');
    expect(p.findings.map(f => f.id)).toContain('P14');   // parameter sniffing
  });
});

describe('Plan sin procedimiento', () => {
  const opts = { planConvert: true, planSort: true, addNolock: true, countOne: true, innerJoin: true };

  it('analiza el plan solo, sin código', () => {
    const p = analyzePlan(SAMPLE_PLAN);
    expect(p.ok).toBe(true);
    expect(p.statements[0].line).toBe(0);
    expect(p.statements[0].params.find(x => x.name === '@pcPersCod')!.type).toBe('NVARCHAR(13)');
  });

  it('mejora las sentencias del plan: conversión, Sort y reglas de código', () => {
    const p = analyzePlan(SAMPLE_PLAN);
    const imp = improvePlan(p, opts);
    const s1 = imp.statements[0].after;
    expect(s1).toContain('DECLARE @pcPersCodLocal VARCHAR(13) = @pcPersCod;');
    expect(s1).toContain('ccc.cPersCodAnalista = @pcPersCodLocal');
    expect(s1).not.toContain('ORDER BY cc.nIdComite DESC');
    expect(s1).toContain('FROM colocComite cc WITH (NOLOCK)');
    expect(imp.statements[1].after).toContain('COUNT(1)');
    expect(imp.statements[2].after).toContain('INNER JOIN dbo.Producto');
    expect(imp.fixed).toContain('P01|1|1');
    expect(planScore(p.findings.filter(f => !imp.fixed.includes(f.key || ''))) > planScore(p.findings)).toBe(true);
  });

  it('sin opciones no cambia las sentencias', () => {
    const imp = improvePlan(analyzePlan(SAMPLE_PLAN), {});
    expect(imp.statements.every(x => x.after === x.before)).toBe(true);
  });
});

