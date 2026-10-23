import type { Dialect } from "./types";

export type SqlDialect = "mysql" | "postgres" | "sqlite" | "mssql";

export type CompletionContext =
  | "dot"
  | "table"
  | "select"
  | "where"
  | "order"
  | "group"
  | "columns"
  | "general";

export interface TableRef {
  table: string;
  alias: string | null;
}

export interface StatementAnalysis {
  statement: string;
  beforeCursor: string;
  prefix: string;
  context: CompletionContext;
  qualifier: string | null;
  qualifierTable: string | null;
  refs: TableRef[];
  referencedTables: string[];
  selectAtStart: boolean;
}

export interface CompletionSchema {
  tables: string[];
  /** Lower-case table name (schema stripped) -> column names. */
  columns: Record<string, string[]>;
}

export type SuggestionKind = "keyword" | "template" | "table" | "column" | "starFrom";

export interface SqlSuggestion {
  label: string;
  insertText: string;
  kind: SuggestionKind;
  detail: string;
  snippet?: boolean;
  sortText?: string;
}

interface SqlTemplateDef {
  label: string;
  detail: string;
  insertText: string;
  variants?: Partial<Record<SqlDialect, string>>;
}

const MAX_SUGGESTIONS = 50;

export function toSqlDialect(dialect: Dialect | string): SqlDialect {
  if (dialect === "postgres" || dialect === "sqlite" || dialect === "mssql") {
    return dialect;
  }
  return "mysql";
}

const BASE_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "INSERT INTO",
  "UPDATE",
  "DELETE FROM",
  "VALUES",
  "SET",
  "AND",
  "OR",
  "NOT",
  "IN",
  "LIKE",
  "BETWEEN",
  "IS NULL",
  "IS NOT NULL",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "DISTINCT",
  "AS",
  "ON",
  "HAVING",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "ASC",
  "DESC",
  "OFFSET",
  "UNION",
  "UNION ALL",
  "EXISTS",
  "WITH",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "CREATE INDEX",
  "CREATE VIEW",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "TRUNCATE TABLE",
  "PRIMARY KEY",
  "NOT NULL",
  "DEFAULT",
];

const DIALECT_KEYWORDS: Record<SqlDialect, string[]> = {
  mysql: [
    "AUTO_INCREMENT",
    "START TRANSACTION",
    "REPLACE INTO",
    "ON DUPLICATE KEY UPDATE",
  ],
  postgres: ["ILIKE", "RETURNING", "ON CONFLICT", "SERIAL", "BIGSERIAL"],
  sqlite: ["AUTOINCREMENT", "ON CONFLICT", "REPLACE INTO"],
  mssql: ["TOP", "FETCH NEXT", "IDENTITY", "MERGE", "BEGIN TRANSACTION"],
};

function keywordsFor(dialect: SqlDialect): string[] {
  const keywords = new Set(BASE_KEYWORDS);
  for (const keyword of DIALECT_KEYWORDS[dialect]) keywords.add(keyword);
  if (dialect === "mssql") keywords.delete("LIMIT");
  return [...keywords];
}

const SQL_TEMPLATES: SqlTemplateDef[] = [
  {
    label: "sel",
    detail: "Select all rows from a table",
    insertText: "SELECT * FROM ${1:table}",
  },
  {
    label: "sf",
    detail: "Select rows matching a condition",
    insertText: "SELECT * FROM ${1:table} WHERE ${2:condition}",
  },
  {
    label: "scount",
    detail: "Count rows in a table",
    insertText: "SELECT COUNT(*) FROM ${1:table}",
  },
  {
    label: "ins",
    detail: "Insert one row into a table",
    insertText:
      "INSERT INTO ${1:table} (${2:columns}) VALUES (${3:values})",
  },
  {
    label: "upd",
    detail: "Update rows matching a condition",
    insertText:
      "UPDATE ${1:table} SET ${2:col} = ${3:value} WHERE ${4:condition}",
  },
  {
    label: "del",
    detail: "Delete rows matching a condition",
    insertText: "DELETE FROM ${1:table} WHERE ${2:condition}",
  },
  {
    label: "join",
    detail: "Join another table on a condition",
    insertText: "JOIN ${1:table} ON ${2:a.id} = ${3:b.id}",
  },
  {
    label: "gb",
    detail: "Group rows by a column",
    insertText: "GROUP BY ",
  },
  {
    label: "ob",
    detail: "Sort rows by a column, descending",
    insertText: "ORDER BY ${1:col} DESC",
  },
  {
    label: "cte",
    detail: "Common table expression (WITH query)",
    insertText:
      "WITH ${1:name} AS (\n  ${2:SELECT ...}\n)\nSELECT * FROM ${1:name};",
  },
  {
    label: "ljoin",
    detail: "Left join another table",
    insertText: "LEFT JOIN ${1:table} ON ${2:a.id} = ${3:b.id}",
  },
  {
    label: "rjoin",
    detail: "Right join another table",
    insertText: "RIGHT JOIN ${1:table} ON ${2:a.id} = ${3:b.id}",
  },
  {
    label: "ijoin",
    detail: "Inner join another table",
    insertText: "INNER JOIN ${1:table} ON ${2:a.id} = ${3:b.id}",
  },
  {
    label: "union",
    detail: "Combine two result sets",
    insertText: "UNION ALL\n${1:SELECT ...}",
  },
  {
    label: "exists",
    detail: "Keep rows that have a matching row",
    insertText:
      "WHERE EXISTS (SELECT 1 FROM ${1:t} WHERE ${2:cond})",
  },
  {
    label: "case",
    detail: "Conditional CASE expression",
    insertText:
      "CASE WHEN ${1:cond} THEN ${2:a} ELSE ${3:b} END",
  },
  {
    label: "win",
    detail: "Window row number partitioned by a column",
    insertText:
      "ROW_NUMBER() OVER (PARTITION BY ${1:col} ORDER BY ${2:col})",
  },
  {
    label: "page",
    detail: "Page results with limit and offset",
    insertText: "LIMIT ${1:50} OFFSET ${2:0}",
    variants: {
      mssql: "OFFSET ${1:0} ROWS FETCH NEXT ${2:50} ROWS ONLY",
    },
  },
  {
    label: "upsert",
    detail: "Insert, or update when the row already exists",
    insertText:
      "INSERT INTO ${1:t} (${2:cols}) VALUES (${3:values}) ON CONFLICT (${4:id}) DO UPDATE SET ${5:col} = EXCLUDED.${5:col};",
    variants: {
      mysql:
        "INSERT INTO ${1:t} (${2:cols}) VALUES (${3:values}) ON DUPLICATE KEY UPDATE ${4:col} = VALUES(${4:col});",
      mssql:
        "MERGE INTO ${1:t} AS target USING (SELECT ${2:vals}) AS source ON ${3:target.id} = source.id WHEN MATCHED THEN UPDATE SET ${4:col} = source.${4:col} WHEN NOT MATCHED THEN INSERT (${5:cols}) VALUES (source.${5:cols});",
    },
  },
  {
    label: "insel",
    detail: "Insert the result of a SELECT",
    insertText:
      "INSERT INTO ${1:t} (${2:cols}) SELECT ${2:cols} FROM ${3:src};",
  },
  {
    label: "ct",
    detail: "Create a table with an auto-increment key",
    insertText:
      "CREATE TABLE ${1:name} (\n  id BIGSERIAL PRIMARY KEY,\n  ${2:col} ${3:type}\n);",
    variants: {
      mysql:
        "CREATE TABLE ${1:name} (\n  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  ${2:col} ${3:type}\n);",
      sqlite:
        "CREATE TABLE ${1:name} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ${2:col} ${3:type}\n);",
      mssql:
        "CREATE TABLE ${1:name} (\n  id INT IDENTITY(1,1) PRIMARY KEY,\n  ${2:col} ${3:type}\n);",
    },
  },
  {
    label: "addcol",
    detail: "Add a column to a table",
    insertText: "ALTER TABLE ${1:t} ADD COLUMN ${2:col} ${3:type};",
    variants: {
      mssql: "ALTER TABLE ${1:t} ADD ${2:col} ${3:type};",
    },
  },
  {
    label: "dropcol",
    detail: "Drop a column from a table",
    insertText: "ALTER TABLE ${1:t} DROP COLUMN ${2:col};",
  },
  {
    label: "idx",
    detail: "Create an index",
    insertText: "CREATE INDEX ${1:idx_name} ON ${2:t} (${3:col});",
  },
  {
    label: "uidx",
    detail: "Create a unique index",
    insertText:
      "CREATE UNIQUE INDEX ${1:idx_name} ON ${2:t} (${3:col});",
  },
  {
    label: "view",
    detail: "Create a view from a query",
    insertText: "CREATE VIEW ${1:v} AS SELECT ${2:*}\nFROM ${3:t};",
  },
  {
    label: "tx",
    detail: "Start a transaction and commit it",
    insertText: "BEGIN;\n${1:-- statements}\nCOMMIT;",
    variants: {
      mysql: "START TRANSACTION;\n${1:-- statements}\nCOMMIT;",
      mssql: "BEGIN TRANSACTION;\n${1:-- statements}\nCOMMIT;",
    },
  },
  {
    label: "trunc",
    detail: "Remove all rows from a table",
    insertText: "TRUNCATE TABLE ${1:t};",
  },
  {
    label: "today",
    detail: "Filter rows created today",
    insertText: "created_at >= CURRENT_DATE",
    variants: {
      mysql: "created_at >= CURDATE()",
      sqlite: "created_at >= date('now')",
      mssql: "created_at >= CAST(GETDATE() AS DATE)",
    },
  },
  {
    label: "thismonth",
    detail: "Filter rows created this month",
    insertText: "created_at >= date_trunc('month', now())",
    variants: {
      mysql: "created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')",
      sqlite: "created_at >= date('now','start of month')",
      mssql:
        "created_at >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)",
    },
  },
  {
    label: "lastdays",
    detail: "Filter rows created in the last N days",
    insertText: "created_at >= now() - INTERVAL '${1:7} days'",
    variants: {
      mysql: "created_at >= DATE_SUB(NOW(), INTERVAL ${1:7} DAY)",
      sqlite: "created_at >= date('now','-${1:7} days')",
      mssql: "created_at >= DATEADD(DAY, -${1:7}, GETDATE())",
    },
  },
  {
    label: "dup",
    detail: "Find duplicate values in a column",
    insertText:
      "SELECT ${1:col}, COUNT(*) FROM ${2:t} GROUP BY ${1:col} HAVING COUNT(*) > 1;",
  },
];

const RESERVED = new Set([
  ...BASE_KEYWORDS.flatMap((keyword) => keyword.split(/\s+/)),
  "WHERE",
  "GROUP",
  "ORDER",
  "BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "RETURNING",
  "ON",
  "USING",
  "SET",
  "VALUES",
  "INTO",
  "FROM",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "CROSS",
  "FULL",
  "NATURAL",
  "AS",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "TRUE",
  "FALSE",
  "WITH",
  "SELECT",
  "UPDATE",
  "DELETE",
  "INSERT",
  "TRUNCATE",
  "CREATE",
  "ALTER",
  "DROP",
]);

function unquote(raw: string): string {
  let value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "`" && last === "`") ||
      (first === "[" && last === "]")
    ) {
      value = value.slice(1, -1);
    }
  }
  return value;
}

export function cleanIdentifier(raw: string): string {
  return raw
    .split(".")
    .map((part) => unquote(part))
    .join(".");
}

export function baseTableName(table: string): string {
  const clean = cleanIdentifier(table);
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1) : clean;
}

/**
 * Statement (between semicolons) that contains the cursor. Quotes and comments
 * are skipped so a semicolon inside a string does not split the statement.
 */
export function statementAtCursor(
  sql: string,
  offset: number,
): { text: string; start: number; end: number; cursor: number } {
  const cursorOffset = Math.max(0, Math.min(offset, sql.length));
  let start = 0;
  let end = sql.length;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === ";") {
      if (index < cursorOffset) {
        start = index + 1;
      } else {
        end = index;
        break;
      }
    }
  }

  while (start < end && /\s/.test(sql[start])) start += 1;
  while (end > start && /\s/.test(sql[end - 1])) end -= 1;

  return {
    text: sql.slice(start, end),
    start,
    end,
    // Keep the real cursor offset: it may sit in trailing whitespace that was
    // trimmed from `text`, and context detection needs that space (e.g. "FROM ").
    cursor: Math.max(start, Math.min(cursorOffset, sql.length)),
  };
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        if (text[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

const FROM_STOP =
  /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT|RETURNING|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|NATURAL|ON|USING|SET|VALUES)\b/i;

function parseTableItem(item: string): TableRef | null {
  const match = /^\s*([`"\[\]\w$.]+)(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/i.exec(
    item,
  );
  if (!match) return null;
  return { table: match[1], alias: match[2] ?? null };
}

/** Tolerant FROM/JOIN/UPDATE/INTO parser used for alias resolution. */
export function parseTableRefs(statement: string): TableRef[] {
  const refs: TableRef[] = [];
  const seen = new Set<string>();

  const add = (tableRaw: string | undefined, aliasRaw?: string | null) => {
    if (!tableRaw) return;
    const table = cleanIdentifier(tableRaw);
    if (!table || RESERVED.has(table.toLowerCase())) return;

    let alias = aliasRaw ? cleanIdentifier(aliasRaw) : null;
    if (alias && RESERVED.has(alias.toLowerCase())) alias = null;

    const key = `${table.toLowerCase()}|${(alias ?? "").toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ table, alias });
  };

  const fromRe = /\bFROM\b/gi;
  let fromMatch: RegExpExecArray | null;
  while ((fromMatch = fromRe.exec(statement))) {
    const rest = statement.slice(fromMatch.index + fromMatch[0].length);
    const stop = FROM_STOP.exec(rest);
    const list = stop ? rest.slice(0, stop.index) : rest;
    for (const item of splitTopLevel(list, ",")) {
      const parsed = parseTableItem(item);
      if (parsed) add(parsed.table, parsed.alias);
    }
  }

  const refRe =
    /\b(?:JOIN|UPDATE|INTO)\s+([`"\[\]\w$.]+)(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/gi;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = refRe.exec(statement))) {
    add(refMatch[1], refMatch[2] ?? null);
  }

  return refs;
}

export function resolveQualifierTable(
  statement: string,
  qualifier: string,
  refs = parseTableRefs(statement),
): string | null {
  const wanted = cleanIdentifier(qualifier).toLowerCase();
  if (!wanted) return null;

  for (const ref of refs) {
    if (ref.alias && ref.alias.toLowerCase() === wanted) return ref.table;
    if (
      ref.table.toLowerCase() === wanted ||
      baseTableName(ref.table).toLowerCase() === wanted
    ) {
      return ref.table;
    }
  }

  // Allow "table." before any FROM clause has been typed.
  return cleanIdentifier(qualifier);
}

function lastClause(beforeCursor: string): string | null {
  const clauseRe =
    /\b(SELECT|WHERE|HAVING|ORDER\s+BY|GROUP\s+BY|ON|FROM|JOIN|SET|VALUES|LIMIT|OFFSET|INTO|UPDATE|DELETE)\b/gi;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = clauseRe.exec(beforeCursor))) {
    last = match[1].replace(/\s+/g, " ").toUpperCase();
  }
  return last;
}

export function analyzeCompletion(sql: string, offset: number): StatementAnalysis {
  const statement = statementAtCursor(sql, offset);
  const beforeCursor = sql.slice(statement.start, statement.cursor);
  const prefixMatch = /([A-Za-z_][\w$]*)$/.exec(beforeCursor);
  const prefix = prefixMatch ? prefixMatch[1] : "";
  const refs = parseTableRefs(statement.text);
  const referencedTables = [...new Set(refs.map((ref) => ref.table))];

  const tablePosition =
    /(?:\bFROM\b|\bJOIN\b|\bUPDATE\b|\bINTO\b)\s+[`"\[\]\w$]*$/i.test(
      beforeCursor,
    );
  const dotMatch = /([`"\[\]\w$]+)\.([`"\[\]\w$]*)$/.exec(beforeCursor);

  let context: CompletionContext = "general";
  let qualifier: string | null = null;
  let qualifierTable: string | null = null;

  if (dotMatch) {
    qualifier = unquote(dotMatch[1]);
    qualifierTable = resolveQualifierTable(statement.text, qualifier, refs);
    context = "dot";
  } else if (tablePosition) {
    context = "table";
  } else {
    const clause = lastClause(beforeCursor);
    if (clause === "SELECT") context = "select";
    else if (clause === "WHERE" || clause === "HAVING" || clause === "ON") {
      context = "where";
    } else if (clause === "ORDER BY") context = "order";
    else if (clause === "GROUP BY") context = "group";
    else if (clause === "FROM" || clause === "JOIN" || clause === "SET") {
      context = "columns";
    }
  }

  return {
    statement: statement.text,
    beforeCursor,
    prefix,
    context,
    qualifier,
    qualifierTable,
    refs,
    referencedTables,
    selectAtStart: /^\s*SELECT\s+$/i.test(beforeCursor),
  };
}

function columnsFor(schema: CompletionSchema, table: string): string[] {
  const full = cleanIdentifier(table).toLowerCase();
  const base = baseTableName(table).toLowerCase();
  return schema.columns[full] ?? schema.columns[base] ?? [];
}

export function buildSuggestions(input: {
  analysis: StatementAnalysis;
  dialect: Dialect | string;
  schema: CompletionSchema;
  prefix?: string;
}): SqlSuggestion[] {
  const dialect = toSqlDialect(input.dialect);
  const { analysis, schema } = input;
  const prefix = (input.prefix ?? analysis.prefix).toLowerCase();
  const matches = (label: string) =>
    !prefix || label.toLowerCase().startsWith(prefix);
  const suggestions: SqlSuggestion[] = [];
  const seen = new Set<string>();

  const push = (suggestion: SqlSuggestion) => {
    const key = `${suggestion.kind}:${suggestion.label.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push(suggestion);
  };

  const pushTable = (table: string) => {
    if (!matches(table)) return;
    push({
      label: table,
      insertText: table,
      kind: "table",
      detail: "Table",
      sortText: `1${table.toLowerCase()}`,
    });
  };

  const pushColumn = (column: string, source: string) => {
    if (!matches(column)) return;
    push({
      label: column,
      insertText: column,
      kind: "column",
      detail: source ? `Column of ${source}` : "Column",
      sortText: `2${column.toLowerCase()}`,
    });
  };

  const pushKeyword = (keyword: string) => {
    if (!matches(keyword)) return;
    push({
      label: keyword,
      insertText: keyword,
      kind: "keyword",
      detail: "Keyword",
      sortText: `3${keyword.toLowerCase()}`,
    });
  };

  const pushTemplate = (template: SqlTemplateDef) => {
    if (!matches(template.label)) return;
    push({
      label: template.label,
      insertText: template.variants?.[dialect] ?? template.insertText,
      kind: "template",
      detail: template.detail,
      snippet: true,
      sortText: `4${template.label}`,
    });
  };

  if (
    analysis.selectAtStart &&
    !prefix &&
    !suggestions.some((item) => item.kind === "starFrom")
  ) {
    push({
      label: "* FROM",
      insertText: "* FROM ${1:table}",
      kind: "starFrom",
      detail: "All columns from a table",
      snippet: true,
      sortText: "0",
    });
  }

  if (analysis.context === "dot") {
    if (analysis.qualifierTable) {
      for (const column of columnsFor(schema, analysis.qualifierTable)) {
        pushColumn(column, analysis.qualifierTable);
      }
    }
    return capSuggestions(suggestions);
  }

  if (analysis.context === "table") {
    for (const table of schema.tables) pushTable(table);
  }

  if (isColumnContext(analysis.context)) {
    for (const table of analysis.referencedTables) {
      for (const column of columnsFor(schema, table)) {
        pushColumn(column, baseTableName(table));
      }
    }
  }

  for (const keyword of keywordsFor(dialect)) pushKeyword(keyword);
  for (const template of SQL_TEMPLATES) pushTemplate(template);

  return capSuggestions(suggestions);
}

export function isColumnContext(context: CompletionContext): boolean {
  return (
    context === "select" ||
    context === "where" ||
    context === "order" ||
    context === "group" ||
    context === "columns"
  );
}

function capSuggestions(suggestions: SqlSuggestion[]): SqlSuggestion[] {
  suggestions.sort((a, b) => {
    const left = a.sortText ?? a.label.toLowerCase();
    const right = b.sortText ?? b.label.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return suggestions.slice(0, MAX_SUGGESTIONS);
}

/**
 * Tiny dev-only sanity check for the pure parser/completion logic. There is no
 * test runner in this project, so failures show up as console.assert messages
 * while developing.
 */
export function selfCheck() {
  const empty: CompletionSchema = { tables: [], columns: {} };

  const text = "SELECT ';' FROM t; SELECT 2";
  const lastStatement = analyzeCompletion(text, text.length);
  console.assert(
    lastStatement.statement === "SELECT 2",
    "statementAtCursor should ignore semicolons inside strings",
  );

  const table = analyzeCompletion("SELECT * FROM ", "SELECT * FROM ".length);
  console.assert(
    table.context === "table",
    "FROM should be a table context",
  );

  const dot = analyzeCompletion(
    "SELECT u. FROM users u",
    "SELECT u.".length,
  );
  console.assert(
    dot.context === "dot" && dot.qualifierTable === "users",
    "alias before a dot should resolve to its table",
  );

  const refs = parseTableRefs(
    "SELECT * FROM users u, orders AS o WHERE u.id = o.user_id",
  );
  console.assert(
    refs.length === 2 &&
      refs[0].alias === "u" &&
      refs[1].alias === "o",
    "FROM lists and aliases should be parsed",
  );

  const star = buildSuggestions({
    analysis: analyzeCompletion("SELECT ", 7),
    dialect: "postgres",
    schema: empty,
  });
  console.assert(
    star[0]?.label === "* FROM" && star[0].snippet === true,
    "'* FROM' should be the first suggestion after SELECT",
  );

  const from = buildSuggestions({
    analysis: analyzeCompletion("fr", 2),
    dialect: "mysql",
    schema: empty,
  });
  console.assert(
    from.some((item) => item.label === "FROM" && item.insertText === "FROM"),
    "prefix fr should offer FROM in upper case",
  );

  const select = buildSuggestions({
    analysis: analyzeCompletion("sel", 3),
    dialect: "sqlite",
    schema: empty,
  });
  console.assert(
    select.some((item) => item.label === "SELECT"),
    "prefix sel should offer SELECT",
  );
  console.assert(
    select.some((item) => item.label === "sel" && item.snippet === true),
    "prefix sel should also offer the sel template",
  );

  const pgILike = buildSuggestions({
    analysis: analyzeCompletion("il", 2),
    dialect: "postgres",
    schema: empty,
  });
  const myILike = buildSuggestions({
    analysis: analyzeCompletion("il", 2),
    dialect: "mysql",
    schema: empty,
  });
  console.assert(
    pgILike.some((item) => item.label === "ILIKE"),
    "postgres should offer ILIKE",
  );
  console.assert(
    !myILike.some((item) => item.label === "ILIKE"),
    "mysql should not offer ILIKE",
  );

  const mssqlPage = buildSuggestions({
    analysis: analyzeCompletion("page", 4),
    dialect: "mssql",
    schema: empty,
  });
  console.assert(
    mssqlPage.some(
      (item) =>
        item.label === "page" && item.insertText.includes("FETCH NEXT"),
    ),
    "mssql paging should use OFFSET/FETCH",
  );

  const withColumns = buildSuggestions({
    analysis: analyzeCompletion("SELECT * FROM users u WHERE u.", "SELECT * FROM users u WHERE u.".length),
    dialect: "postgres",
    schema: { tables: ["users"], columns: { users: ["id", "email"] } },
  });
  console.assert(
    withColumns.some(
      (item) => item.label === "email" && item.kind === "column",
    ),
    "dot completion should use the lazily cached column list",
  );
}

if (import.meta.env.DEV) {
  selfCheck();
}
