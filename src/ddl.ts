// SQL builders for structural (DDL) changes. They quote identifiers per dialect
// but pass column types and DEFAULT expressions through as the user typed them —
// this is a DB tool where the user already has full SQL access, and the exact
// statement is always shown for confirmation before it runs.
import { quoteIdentifier } from "./sql";
import type { Dialect } from "./types";

export interface ColumnSpec {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primaryKey?: boolean;
}

export function tableRef(
  dialect: Dialect,
  database: string,
  table: string,
): string {
  const t = quoteIdentifier(dialect, table);
  if (dialect === "mysql" && database.trim()) {
    return `${quoteIdentifier(dialect, database)}.${t}`;
  }
  return t;
}

function columnClause(dialect: Dialect, col: ColumnSpec): string {
  let clause = `${quoteIdentifier(dialect, col.name)} ${col.type.trim()}`;
  if (!col.nullable) clause += " NOT NULL";
  if (col.default && col.default.trim()) {
    clause += ` DEFAULT ${col.default.trim()}`;
  }
  return clause;
}

export function addColumnSql(
  dialect: Dialect,
  database: string,
  table: string,
  col: ColumnSpec,
): string {
  return `ALTER TABLE ${tableRef(dialect, database, table)} ADD COLUMN ${columnClause(
    dialect,
    col,
  )}`;
}

export function dropColumnSql(
  dialect: Dialect,
  database: string,
  table: string,
  name: string,
): string {
  return `ALTER TABLE ${tableRef(dialect, database, table)} DROP COLUMN ${quoteIdentifier(
    dialect,
    name,
  )}`;
}

export function renameColumnSql(
  dialect: Dialect,
  database: string,
  table: string,
  oldName: string,
  newName: string,
): string {
  return `ALTER TABLE ${tableRef(
    dialect,
    database,
    table,
  )} RENAME COLUMN ${quoteIdentifier(dialect, oldName)} TO ${quoteIdentifier(
    dialect,
    newName,
  )}`;
}

/** Null when the dialect can't change a column's type with a simple ALTER. */
export function changeTypeSql(
  dialect: Dialect,
  database: string,
  table: string,
  name: string,
  type: string,
  nullable: boolean,
): string | null {
  const ref = tableRef(dialect, database, table);
  const col = quoteIdentifier(dialect, name);
  if (dialect === "mysql") {
    return `ALTER TABLE ${ref} MODIFY COLUMN ${col} ${type.trim()}${
      nullable ? "" : " NOT NULL"
    }`;
  }
  if (dialect === "postgres") {
    const nullClause = nullable
      ? `ALTER COLUMN ${col} DROP NOT NULL`
      : `ALTER COLUMN ${col} SET NOT NULL`;
    return `ALTER TABLE ${ref} ALTER COLUMN ${col} TYPE ${type.trim()}, ${nullClause}`;
  }
  return null; // sqlite / mssql
}

export function canChangeType(dialect: Dialect): boolean {
  return dialect === "mysql" || dialect === "postgres";
}

export function dropTableSql(
  dialect: Dialect,
  database: string,
  table: string,
): string {
  return `DROP TABLE ${tableRef(dialect, database, table)}`;
}

export function createTableSql(
  dialect: Dialect,
  database: string,
  table: string,
  cols: ColumnSpec[],
): string {
  const defs = cols.map((col) => columnClause(dialect, col));
  const pks = cols
    .filter((col) => col.primaryKey)
    .map((col) => quoteIdentifier(dialect, col.name));
  if (pks.length > 0) defs.push(`PRIMARY KEY (${pks.join(", ")})`);
  return `CREATE TABLE ${tableRef(dialect, database, table)} (\n  ${defs.join(
    ",\n  ",
  )}\n)`;
}
