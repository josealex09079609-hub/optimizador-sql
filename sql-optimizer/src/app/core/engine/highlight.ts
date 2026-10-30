/** Resaltado de sintaxis T-SQL (devuelve HTML escapado). */
const KW = /^(SELECT|FROM|WHERE|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|OUTER|APPLY|ON|AND|OR|NOT|IN|IS|NULL|EXISTS|GROUP|ORDER|BY|HAVING|UNION|ALL|INSERT|INTO|UPDATE|DELETE|SET|VALUES|AS|WITH|NOLOCK|CASE|WHEN|THEN|ELSE|END|BEGIN|IF|WHILE|DECLARE|EXEC|EXECUTE|RETURN|TOP|DISTINCT|CREATE|ALTER|PROCEDURE|PROC|TABLE|TRY|CATCH|TRAN|TRANSACTION|COMMIT|ROLLBACK|THROW|LIKE|BETWEEN|OVER|PARTITION|NOCOUNT|DESC|ASC|GO|OUTPUT|TRUNCATE|DROP|MERGE|USING|COLLATE|STRING_AGG|STRING_SPLIT|TRIM|COALESCE|ISNULL|CONVERT|CAST|CONCAT|IIF|COUNT|MAX|MIN|SUM|AVG|ROW_NUMBER|GETDATE|INT|BIGINT|VARCHAR|NVARCHAR|CHAR|BIT|DATE|DATETIME|DECIMAL|MONEY|NUMERIC)$/i;

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function highlightSql(code: string): string {
  let out = '', i = 0, m: RegExpExecArray | null;
  const re = /(--[^\n]*|\/\*[\s\S]*?\*\/)|(N?'(?:[^']|'')*')|(@@?\w+)|(#\w+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(i, m.index)); i = re.lastIndex;
    if (m[1]) out += `<span class="com">${escapeHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="str">${escapeHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="var">${escapeHtml(m[3])}</span>`;
    else if (m[4]) out += `<span class="tmp">${escapeHtml(m[4])}</span>`;
    else if (m[5]) out += `<span class="num">${m[5]}</span>`;
    else out += KW.test(m[6]) ? `<span class="kw">${m[6]}</span>` : escapeHtml(m[6]);
  }
  return out + escapeHtml(code.slice(i));
}
