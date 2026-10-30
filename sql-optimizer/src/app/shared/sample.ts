/** Procedimiento de ejemplo con malas prácticas típicas (para la demo). */
export const SAMPLE_SQL = `-- =============================================
-- Autor:       Equipo GCN
-- Fecha:       30/10/2026
-- Descripción: Lista comités pendientes (SELECT por agencia FROM colocComite)
-- Modificación: Se agrega filtro por analista
-- =============================================
CREATE PROCEDURE COLOCACIONES.FluCre_SelComitePendiente_SP
    @pcPersCod VARCHAR(13),
    @cAgeCod VARCHAR(2) = NULL,
    @nMonto VARCHAR(20),
    @dFecha DATETIME
AS
BEGIN
    DECLARE @MONTOCOL MONEY, @cLista VARCHAR(MAX)

    CREATE TABLE #DataCredit (nIdComite INT, cCtaCod VARCHAR(18), cPersNombre VARCHAR(200),)

    INSERT INTO #DataCredit (nIdComite, cCtaCod, cPersNombre)
    SELECT cc.nIdComite, ccc.cCtaCod, LTRIM(RTRIM(p.cPersNombre))
    FROM colocComite cc
    INNER JOIN dbo.colocComiteColocacion ccc ON cc.nIdComite = ccc.nIdComite
    INNER JOIN Persona p WITH(NOLOCK) ON ccc.cPersCodAnalista = p.cPersCod
    INNER JOIN dbo.Constante t ON cc.nEstado = t.nConsValor AND t.nConsCod = 2009
    INNER JOIN dbo.Constante t1 ON cc.nTipoComite = t1.nConsValor AND t1.nConsCod = 2010
    INNER JOIN dbo.Constante t2 ON cc.nNivel = t2.nConsValor OR t2.nConsCod = 2011
    INNER JOIN dbo.RRHH rh WITH(NOLOCK) ON p.cPersCod = rh.cPersCod AND LEFT(rh.cRHCod, 1) = 'E'
    INNER JOIN dbo.RHCargos rc WITH(NOLOCK) ON rh.cPersCod = rc.cPersCod
        AND rc.dRHCargoFecha = (SELECT MAX(dRHCargoFecha) FROM RHCargos x WHERE x.cPersCod = rc.cPersCod)
    WHERE cc.nEstado = '1'
      AND (@cAgeCod IS NULL OR rh.cAgenciaActual = @cAgeCod)
      AND dbo.FN_GetDateFormat(cc.dFecha) = @dFecha
    ORDER BY cc.nIdComite DESC

    -- SELECT * FROM #DataCredit WHERE nIdComite = 1
    SELECT d.*, (SELECT cAgeDescripcion FROM dbo.Agencias a WHERE a.cAgeCod = @cAgeCod) cAgencia
    FROM #DataCredit d WITH(NOLOCK)
    WHERE d.cCtaCod NOT IN (SELECT cCtaCod FROM dbo.Producto WHERE nPrdEstado = 2001)

    SET @cLista = STUFF((SELECT ',' + cCtaCod FROM #DataCredit FOR XML PATH('')),1,1,'')

    SELECT d.nIdComite, d.cCtaCod
    INTO #Pendientes
    FROM #DataCredit d
    JOIN dbo.Producto pr WITH(NOLOCK) ON d.cCtaCod = pr.cCtaCod

    BEGIN TRAN
    UPDATE dbo.colocComite SET nEstado = 2 WHERE nIdComite IN (SELECT nIdComite FROM #Pendientes)
END
`;
