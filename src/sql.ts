import { format } from "sql-formatter";
import type { SqlLanguage } from "sql-formatter";
import type { Dialect } from "./types";

function formatterLanguage(dialect: Dialect | string): SqlLanguage {
  if (dialect === "postgres") return "postgresql";
  if (dialect === "mysql") return "mysql";
  if (dialect === "sqlite") return "sqlite";
  if (dialect === "mssql") return "transactsql";
  return "sql";
}

export function formatSql(sql: string, dialect: Dialect | string = "mysql"): string {
  const source = sql.trim();
  if (!source) return "";
  try {
    return format(source, {
      language: formatterLanguage(dialect),
      keywordCase: "upper",
      dataTypeCase: "upper",
      functionCase: "upper",
      identifierCase: "preserve",
      indentStyle: "standard",
      tabWidth: 2,
      useTabs: false,
      expressionWidth: 50,
      linesBetweenQueries: 1,
      logicalOperatorNewline: "before",
      denseOperators: false,
      newlineBeforeSemicolon: false,
    }).trim();
  } catch {
    return source;
  }
}

export function quoteIdentifier(dialect: Dialect, value: string): string {
  if (dialect === "mysql") {
    return `\`${value.replace(/`/g, "``")}\``;
  }
  if (dialect === "mssql") {
    return `[${value.replace(/\]/g, "]]")}]`;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

export function sqliteBooleanLiteral(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "t", "yes", "y"].includes(normalized)) return "1";
  if (["0", "false", "f", "no", "n"].includes(normalized)) return "0";
  return null;
}

export function qualifiedTable(
  dialect: Dialect,
  database: string,
  table: string,
): string {
  if (dialect === "postgres") {
    return quoteIdentifier(dialect, table);
  }
  if (dialect === "mssql") {
    return `${quoteIdentifier(dialect, database)}.${quoteIdentifier(
      dialect,
      "dbo",
    )}.${quoteIdentifier(dialect, table)}`;
  }
  return `${quoteIdentifier(dialect, database)}.${quoteIdentifier(
    dialect,
    table,
  )}`;
}

export function selectAllSql(
  dialect: Dialect,
  database: string,
  table: string,
  limit = 1000,
  where = "",
): string {
  const filter = where.trim();
  return `SELECT *\nFROM ${qualifiedTable(dialect, database, table)}${
    filter ? `\nWHERE ${filter}` : ""
  }\nLIMIT ${limit};`;
}
