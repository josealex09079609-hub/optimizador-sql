import { OptionDef } from './models';

/** Correcciones automáticas disponibles. "default" refleja la regla de oro de la skill. */
export const OPTIMIZE_OPTIONS: OptionDef[] = [
  { key: 'addNolock', label: 'WITH (NOLOCK): uno por tabla física', hint: 'Agrega donde falta, quita duplicados y (NOLOCK) antiguo; en UPDATE/DELETE solo en las tablas unidas, no en la que se modifica', default: true },
  { key: 'countOne', label: 'COUNT(*) → COUNT(1)', hint: 'Estándar del área', default: true },
  { key: 'existsOne', label: 'EXISTS (SELECT …) → SELECT 1', hint: 'IF EXISTS / NOT EXISTS / WHERE EXISTS', default: true },
  { key: 'collateTemp', label: 'COLLATE en texto de temporales', hint: 'SKILL §3.2', default: true },
  { key: 'dropIfExists', label: 'DROP TABLE IF EXISTS', hint: 'SKILL §6', default: true },
  { key: 'singleIn', label: 'IN (x) → = x', hint: 'SKILL §3 – code review senior', default: true },
  { key: 'throwSemicolon', label: '; antes de THROW', hint: 'SKILL §3 – THROW', default: true },
  { key: 'closeTran', label: 'Cerrar transacciones abiertas', hint: 'TRY/CATCH + COMMIT/ROLLBACK', default: true },
  { key: 'selectInto', label: 'SELECT INTO # → CREATE TABLE', hint: 'SKILL §3.2', default: true },
  { key: 'innerJoin', label: 'JOIN → INNER JOIN', hint: 'Formato', default: true },
  { key: 'trim', label: 'LTRIM(RTRIM()) → TRIM()', hint: 'SKILL §3 – nativas 2019', default: true },
  { key: 'sarg', label: 'LEFT(col,n)=\'x\' → LIKE \'x%\'', hint: 'Predicado SARGable', default: true },
  { key: 'nolockTemp', label: 'Quitar NOLOCK de temporales', hint: 'SKILL §3.1', default: true },
  { key: 'trailingComma', label: 'Corregir coma final en tablas', hint: 'Sintaxis', default: true },
  { key: 'removeComments', label: 'Eliminar código comentado (no la cabecera)', hint: 'SKILL §3', default: true },
  { key: 'stringAgg', label: 'STUFF/FOR XML → STRING_AGG (condicional)', hint: 'No equivalente con & < > o > 8000 bytes', default: false },
  { key: 'schema', label: 'Agregar esquema dbo. a tablas', hint: '', default: false },
  { key: 'upper', label: 'Palabras clave en MAYÚSCULAS', hint: 'SKILL §5', default: false },
  { key: 'nocount', label: 'SET NOCOUNT ON (solo PA nuevo)', hint: 'SKILL §6', default: false },
  { key: 'reviewNotes', label: 'Insertar notas -- [REVISAR]', hint: '', default: false },
  { key: 'planConvert', label: 'Corregir conversiones implícitas con alerta', hint: 'NVARCHAR vs VARCHAR: variable local del tipo de la columna, quitar N\'\' o definir la columna de la temporal como VARCHAR', default: true, group: 'plan' },
  { key: 'planSort', label: 'Quitar ORDER BY en INSERT a temporal (Sort con spill)', hint: 'Solo si la temporal no tiene IDENTITY ni hay TOP/OFFSET', default: true, group: 'plan' },
  { key: 'planCode', label: 'Aplicar también el estándar de código (NOLOCK, COUNT(1), INNER JOIN…)', hint: 'Usa las mismas opciones marcadas en Procedimiento', default: true, group: 'plan' }
];
