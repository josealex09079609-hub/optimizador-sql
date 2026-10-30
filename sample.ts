/** Procedimiento y plan de ejecución de ejemplo (para la demo). */
export const SAMPLE_SQL = `-- =============================================
-- Autor:       Equipo GCN
-- Fecha:       30/10/2026
-- Descripción: Lista comités pendientes (SELECT por agencia FROM colocComite)
-- Modificación: Se agrega filtro por analista
-- =============================================
CREATE PROCEDURE COLOCACIONES.FluCre_SelComitePendiente_SP
    @pcPersCod NVARCHAR(13),
    @cAgeCod VARCHAR(2) = NULL,
    @nMonto VARCHAR(20),
    @dFecha DATETIME
AS
BEGIN
    DECLARE @MONTOCOL MONEY, @cLista VARCHAR(MAX)

    IF NOT EXISTS (SELECT * FROM dbo.Agencias WITH (NOLOCK) WHERE cAgeCod = @cAgeCod)
        RETURN

    CREATE TABLE #DataCredit (nIdComite INT, cCtaCod NVARCHAR(18), cPersNombre VARCHAR(MAX),)

    INSERT INTO #DataCredit (nIdComite, cCtaCod, cPersNombre)
    SELECT cc.nIdComite, ccc.cCtaCod, LTRIM(RTRIM(p.cPersNombre))
    FROM colocComite cc
    INNER JOIN dbo.colocComiteColocacion ccc ON cc.nIdComite = ccc.nIdComite
    INNER JOIN Persona p WITH(NOLOCK) WITH (NOLOCK) ON ccc.cPersCodAnalista = p.cPersCod
    INNER JOIN dbo.Constante t (NOLOCK) ON cc.nEstado = t.nConsValor AND t.nConsCod = 2009
    INNER JOIN dbo.Constante t1 ON cc.nTipoComite = t1.nConsValor AND t1.nConsCod = 2010
    INNER JOIN dbo.Constante t2 ON cc.nNivel = t2.nConsValor OR t2.nConsCod = 2011
    INNER JOIN dbo.RRHH rh WITH(NOLOCK) ON p.cPersCod = rh.cPersCod AND LEFT(rh.cRHCod, 1) = 'E'
    INNER JOIN dbo.RHCargos rc WITH(NOLOCK) ON rh.cPersCod = rc.cPersCod
        AND rc.dRHCargoFecha = (SELECT MAX(dRHCargoFecha) FROM RHCargos x WHERE x.cPersCod = rc.cPersCod)
    WHERE cc.nEstado = '1'
      AND ccc.cPersCodAnalista = @pcPersCod
      AND (@cAgeCod IS NULL OR rh.cAgenciaActual = @cAgeCod)
      AND dbo.FN_GetDateFormat(cc.dFecha) = @dFecha
    ORDER BY cc.nIdComite DESC

    -- SELECT * FROM #DataCredit WHERE nIdComite = 1
    SELECT d.*, (SELECT cAgeDescripcion FROM dbo.Agencias a WHERE a.cAgeCod = @cAgeCod) cAgencia,
           (SELECT COUNT(*) FROM #DataCredit) nTotal
    FROM #DataCredit d WITH(NOLOCK)
    WHERE d.cCtaCod NOT IN (SELECT cCtaCod FROM dbo.Producto WHERE nPrdEstado = 2001)

    SET @cLista = STUFF((SELECT ',' + cCtaCod FROM #DataCredit FOR XML PATH('')),1,1,'')

    SELECT d.nIdComite, d.cCtaCod
    INTO #Pendientes
    FROM #DataCredit d
    JOIN dbo.Producto pr WITH(NOLOCK) ON d.cCtaCod = pr.cCtaCod

    BEGIN TRAN
    UPDATE cc SET cc.nEstado = 2
    FROM dbo.colocComite cc WITH (NOLOCK)
    INNER JOIN #Pendientes pe WITH (NOLOCK) ON pe.nIdComite = cc.nIdComite
    INNER JOIN dbo.Agencias ag ON ag.cAgeCod = @cAgeCod
END
`;

export const SAMPLE_PLAN = `<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" Version="1.539" Build="15.0.4335.1" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
  <BatchSequence>
    <Batch>
      <Statements>
        <StmtSimple StatementText="INSERT INTO #DataCredit (nIdComite, cCtaCod, cPersNombre)
    SELECT cc.nIdComite, ccc.cCtaCod, LTRIM(RTRIM(p.cPersNombre))
    FROM colocComite cc
    INNER JOIN dbo.colocComiteColocacion ccc ON cc.nIdComite = ccc.nIdComite
    INNER JOIN Persona p WITH(NOLOCK) WITH (NOLOCK) ON ccc.cPersCodAnalista = p.cPersCod
    INNER JOIN dbo.Constante t (NOLOCK) ON cc.nEstado = t.nConsValor AND t.nConsCod = 2009
    INNER JOIN dbo.Constante t1 ON cc.nTipoComite = t1.nConsValor AND t1.nConsCod = 2010
    INNER JOIN dbo.Constante t2 ON cc.nNivel = t2.nConsValor OR t2.nConsCod = 2011
    INNER JOIN dbo.RRHH rh WITH(NOLOCK) ON p.cPersCod = rh.cPersCod AND LEFT(rh.cRHCod, 1) = &#x27;E&#x27;
    INNER JOIN dbo.RHCargos rc WITH(NOLOCK) ON rh.cPersCod = rc.cPersCod
        AND rc.dRHCargoFecha = (SELECT MAX(dRHCargoFecha) FROM RHCargos x WHERE x.cPersCod = rc.cPersCod)
    WHERE cc.nEstado = &#x27;1&#x27;
      AND ccc.cPersCodAnalista = @pcPersCod
      AND (@cAgeCod IS NULL OR rh.cAgenciaActual = @cAgeCod)
      AND dbo.FN_GetDateFormat(cc.dFecha) = @dFecha
    ORDER BY cc.nIdComite DESC" StatementId="1" StatementCompId="5" StatementType="INSERT" StatementSubTreeCost="48.2915" StatementEstRows="12" StatementOptmLevel="FULL" StatementOptmEarlyAbortReason="TimeOut" CardinalityEstimationModelVersion="150">
          <QueryPlan DegreeOfParallelism="1" MemoryGrant="1024" CachedPlanSize="152" CompileTime="210" CompileCPU="190">
            <Warnings>
              <PlanAffectingConvert ConvertIssue="Seek Plan" Expression="CONVERT_IMPLICIT(nvarchar(13),[DBCMACICA].[dbo].[colocComiteColocacion].[cPersCodAnalista] as [ccc].[cPersCodAnalista],0)" />
            </Warnings>
            <ParameterList>
              <ColumnReference Column="@pcPersCod" ParameterDataType="nvarchar(13)" ParameterCompiledValue="N'0001234567890'" ParameterRuntimeValue="N'0009876543210'" />
              <ColumnReference Column="@cAgeCod" ParameterDataType="varchar(2)" ParameterCompiledValue="'01'" ParameterRuntimeValue="'01'" />
              <ColumnReference Column="@dFecha" ParameterDataType="datetime" ParameterCompiledValue="'2026-10-01 00:00:00.000'" ParameterRuntimeValue="'2026-10-01 00:00:00.000'" />
            </ParameterList>
            <MemoryGrantInfo SerialRequiredMemory="512" SerialDesiredMemory="1024" RequiredMemory="512" DesiredMemory="1024" RequestedMemory="1024" GrantWaitTime="0" GrantedMemory="1024" MaxUsedMemory="1024" MaxQueryMemory="1520480" />
            <QueryTimeStats CpuTime="8420" ElapsedTime="11873" />
            <MissingIndexes>
              <MissingIndexGroup Impact="78.42">
                <MissingIndex Database="[DBCMACICA]" Schema="[dbo]" Table="[colocComite]">
                  <ColumnGroup Usage="EQUALITY"><Column Name="[nEstado]" ColumnId="4" /></ColumnGroup>
                  <ColumnGroup Usage="INCLUDE"><Column Name="[nTipoComite]" ColumnId="5" /><Column Name="[nNivel]" ColumnId="6" /><Column Name="[dFecha]" ColumnId="7" /></ColumnGroup>
                </MissingIndex>
              </MissingIndexGroup>
            </MissingIndexes>
            <RelOp NodeId="0" PhysicalOp="Table Insert" LogicalOp="Insert" EstimateRows="12" EstimatedTotalSubtreeCost="48.2915">
              <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="48500" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
              <Update>
                <Object Database="[tempdb]" Schema="[dbo]" Table="[#DataCredit__________________________________________________________________________________________________________000000000A1B]" />
                <RelOp NodeId="1" PhysicalOp="Sort" LogicalOp="Sort" EstimateRows="12" AvgRowSize="245" EstimatedTotalSubtreeCost="47.9">
                  <Warnings>
                    <SpillToTempDb SpillLevel="2" SpilledThreadCount="1" />
                    <SortSpillDetails GrantedMemoryKb="1024" UsedMemoryKb="1024" WritesToTempDb="18456" ReadsFromTempDb="18456" />
                  </Warnings>
                  <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="48500" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
                  <Sort Distinct="false">
                    <OrderBy><OrderByColumn Ascending="false"><ColumnReference Database="[DBCMACICA]" Schema="[dbo]" Table="[colocComite]" Alias="[cc]" Column="nIdComite" /></OrderByColumn></OrderBy>
                    <RelOp NodeId="2" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="12" EstimatedTotalSubtreeCost="47.1">
                      <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="48500" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
                      <NestedLoops Optimized="false">
                        <RelOp NodeId="3" PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="12" EstimatedRowsRead="1250000" TableCardinality="1250000" EstimatedTotalSubtreeCost="21.4">
                          <OutputList><ColumnReference Database="[DBCMACICA]" Schema="[dbo]" Table="[colocComiteColocacion]" Alias="[ccc]" Column="cCtaCod" /><ColumnReference Database="[DBCMACICA]" Schema="[dbo]" Table="[colocComiteColocacion]" Alias="[ccc]" Column="cPersCodAnalista" /></OutputList>
                          <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="48500" ActualRowsRead="1250000" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
                          <IndexScan Ordered="false">
                            <Object Database="[DBCMACICA]" Schema="[dbo]" Table="[colocComiteColocacion]" Index="[IX_colocComiteColocacion_cPersCodAnalista]" Alias="[ccc]" />
                            <Predicate><ScalarOperator ScalarString="CONVERT_IMPLICIT(nvarchar(13),[DBCMACICA].[dbo].[colocComiteColocacion].[cPersCodAnalista] as [ccc].[cPersCodAnalista],0)=[@pcPersCod]" /></Predicate>
                          </IndexScan>
                        </RelOp>
                        <RelOp NodeId="4" PhysicalOp="Key Lookup" LogicalOp="Key Lookup" EstimateRows="1" EstimateRebinds="11" EstimateRewinds="0" EstimatedTotalSubtreeCost="18.2">
                          <OutputList><ColumnReference Database="[DBCMACICA]" Schema="[dbo]" Table="[RRHH]" Alias="[rh]" Column="cAgenciaActual" /><ColumnReference Database="[DBCMACICA]" Schema="[dbo]" Table="[RRHH]" Alias="[rh]" Column="cRHCod" /></OutputList>
                          <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="48500" ActualEndOfScans="1" ActualExecutions="48500" /></RunTimeInformation>
                          <IndexScan Lookup="true"><Object Database="[DBCMACICA]" Schema="[dbo]" Table="[RRHH]" Index="[PK_RRHH]" Alias="[rh]" /></IndexScan>
                        </RelOp>
                      </NestedLoops>
                    </RelOp>
                  </Sort>
                </RelOp>
              </Update>
            </RelOp>
          </QueryPlan>
        </StmtSimple>
        <StmtSimple StatementText="SELECT d.*, (SELECT cAgeDescripcion FROM dbo.Agencias a WHERE a.cAgeCod = @cAgeCod) cAgencia,
           (SELECT COUNT(*) FROM #DataCredit) nTotal
    FROM #DataCredit d WITH(NOLOCK)
    WHERE d.cCtaCod NOT IN (SELECT cCtaCod FROM dbo.Producto WHERE nPrdEstado = 2001)" StatementId="2" StatementCompId="7" StatementType="SELECT" StatementSubTreeCost="3.104" StatementEstRows="980000" StatementOptmLevel="FULL" CardinalityEstimationModelVersion="150">
          <QueryPlan DegreeOfParallelism="1" MemoryGrant="524288" CachedPlanSize="64" CompileTime="12" CompileCPU="11">
            <Warnings>
              <MemoryGrantWarning GrantWarningKind="Excessive Grant" RequestedMemory="524288" GrantedMemory="524288" MaxUsedMemory="2048" />
            </Warnings>
            <MemoryGrantInfo SerialRequiredMemory="1024" SerialDesiredMemory="524288" RequiredMemory="1024" DesiredMemory="524288" RequestedMemory="524288" GrantWaitTime="1350" GrantedMemory="524288" MaxUsedMemory="2048" MaxQueryMemory="1520480" />
            <QueryTimeStats CpuTime="310" ElapsedTime="1720" />
            <RelOp NodeId="0" PhysicalOp="Hash Match" LogicalOp="Right Anti Semi Join" EstimateRows="980000" AvgRowSize="4035" EstimatedTotalSubtreeCost="3.104">
              <OutputList><ColumnReference Database="[DBCMACICA]" Schema="[dbo]" Table="[#DataCredit]" Alias="[d]" Column="nIdComite" /><ColumnReference Database="[DBCMACICA]" Schema="[dbo]" Table="[#DataCredit]" Alias="[d]" Column="cCtaCod" /><ColumnReference Database="[DBCMACICA]" Schema="[dbo]" Table="[#DataCredit]" Alias="[d]" Column="cPersNombre" /></OutputList>
              <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1150" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
              <Hash>
                <RelOp NodeId="1" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="980000" EstimatedTotalSubtreeCost="1.2">
                  <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1150" ActualRowsRead="1150" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
                  <IndexScan Ordered="false"><Object Database="[tempdb]" Schema="[dbo]" Table="[#DataCredit__________________________________________________________________________________________________________000000000A1B]" Alias="[d]" /></IndexScan>
                </RelOp>
              </Hash>
            </RelOp>
          </QueryPlan>
        </StmtSimple>
        <StmtSimple StatementText="SELECT d.nIdComite, d.cCtaCod
    INTO #Pendientes
    FROM #DataCredit d
    JOIN dbo.Producto pr WITH(NOLOCK) ON d.cCtaCod = pr.cCtaCod" StatementId="3" StatementCompId="9" StatementType="SELECT INTO" StatementSubTreeCost="12.733" StatementEstRows="1150" StatementOptmLevel="FULL" CardinalityEstimationModelVersion="150">
          <QueryPlan DegreeOfParallelism="1" MemoryGrant="2048" CachedPlanSize="48" CompileTime="6" CompileCPU="6">
            <Warnings>
              <PlanAffectingConvert ConvertIssue="Seek Plan" Expression="CONVERT_IMPLICIT(nvarchar(18),[DBCMACICA].[dbo].[Producto].[cCtaCod] as [pr].[cCtaCod],0)" />
            </Warnings>
            <MemoryGrantInfo SerialRequiredMemory="1024" SerialDesiredMemory="2048" RequiredMemory="1024" DesiredMemory="2048" RequestedMemory="2048" GrantWaitTime="0" GrantedMemory="2048" MaxUsedMemory="1536" MaxQueryMemory="1520480" />
            <QueryTimeStats CpuTime="2100" ElapsedTime="2480" />
            <RelOp NodeId="0" PhysicalOp="Hash Match" LogicalOp="Inner Join" EstimateRows="1150" EstimatedTotalSubtreeCost="12.733">
              <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1150" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
              <Hash>
                <RelOp NodeId="1" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="850000" TableCardinality="850000" EstimatedTotalSubtreeCost="11.9">
                  <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1150" ActualRowsRead="850000" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
                  <IndexScan Ordered="false">
                    <Object Database="[DBCMACICA]" Schema="[dbo]" Table="[Producto]" Index="[PK_Producto]" Alias="[pr]" />
                    <Predicate><ScalarOperator ScalarString="CONVERT_IMPLICIT(nvarchar(18),[DBCMACICA].[dbo].[Producto].[cCtaCod] as [pr].[cCtaCod],0)=[tempdb].[dbo].[#DataCredit__________000000000A1B].[cCtaCod] as [d].[cCtaCod]" /></Predicate>
                  </IndexScan>
                </RelOp>
              </Hash>
            </RelOp>
          </QueryPlan>
        </StmtSimple>
        <StmtSimple StatementText="UPDATE cc SET cc.nEstado = 2
    FROM dbo.colocComite cc WITH (NOLOCK)
    INNER JOIN #Pendientes pe WITH (NOLOCK) ON pe.nIdComite = cc.nIdComite
    INNER JOIN dbo.Agencias ag ON ag.cAgeCod = @cAgeCod" StatementId="4" StatementCompId="12" StatementType="UPDATE" StatementSubTreeCost="0.052" StatementEstRows="1150" StatementOptmLevel="FULL" CardinalityEstimationModelVersion="150">
          <QueryPlan DegreeOfParallelism="1" CachedPlanSize="40" CompileTime="3" CompileCPU="3">
            <QueryTimeStats CpuTime="40" ElapsedTime="55" />
            <RelOp NodeId="0" PhysicalOp="Clustered Index Update" LogicalOp="Update" EstimateRows="1150" EstimatedTotalSubtreeCost="0.052">
              <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1150" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
              <Update>
                <Object Database="[DBCMACICA]" Schema="[dbo]" Table="[colocComite]" Index="[PK_colocComite]" Alias="[cc]" />
                <RelOp NodeId="1" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="1150" EstimatedTotalSubtreeCost="0.05">
                  <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1150" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
                  <NestedLoops Optimized="false">
                    <RelOp NodeId="2" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="1" EstimatedRowsRead="182000" TableCardinality="182000" EstimatedTotalSubtreeCost="0.9">
                      <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1" ActualRowsRead="182000" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
                      <TableScan Ordered="false">
                        <Object Database="[DBCMACICA]" Schema="[dbo]" Table="[Agencias]" Alias="[ag]" />
                        <Predicate><ScalarOperator ScalarString="[DBCMACICA].[dbo].[Agencias].[cAgeCod] as [ag].[cAgeCod]=[@cAgeCod]" /></Predicate>
                      </TableScan>
                    </RelOp>
                    <RelOp NodeId="3" PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" EstimateRows="1150" EstimatedTotalSubtreeCost="0.01">
                      <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1150" ActualRowsRead="1150" ActualEndOfScans="1" ActualExecutions="1" /></RunTimeInformation>
                      <IndexScan Ordered="true"><Object Database="[DBCMACICA]" Schema="[dbo]" Table="[colocComite]" Index="[PK_colocComite]" Alias="[cc]" />
                        <Predicate><ScalarOperator ScalarString="CONVERT_IMPLICIT(int,[tempdb].[dbo].[#Pendientes].[nIdComite] as [pe].[nIdComite],0)=[cc].[nIdComite]" /></Predicate>
                      </IndexScan>
                    </RelOp>
                  </NestedLoops>
                </RelOp>
              </Update>
            </RelOp>
          </QueryPlan>
        </StmtSimple>
      </Statements>
    </Batch>
  </BatchSequence>
</ShowPlanXML>
`;
