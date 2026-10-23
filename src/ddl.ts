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
  if ((dialect === "mysql" || dialect === "clickhouse") && database.trim()) {
    return `${quoteIdentifier(dialect, database)}.${t}`;
  }
  if (dialect === "mssql" && database.trim()) {
    return `${quoteIdentifier(dialect, database)}.${quoteIdentifier(
      dialect,
      "dbo",
    )}.${t}`;
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

export interface ChangeTypeContext {
  /** Full output of SHOW CREATE TABLE. */
  definition: string;
  /** The column's current COLUMN_TYPE, used to locate the type inside it. */
  currentType: string;
  /** Current name when the same edit also renames the column. */
  currentName?: string;
}

function findMysqlColumnDefinition(
  createSql: string,
  name: string,
): string | null {
  const quoted = quoteIdentifier("mysql", name);
  for (const rawLine of createSql.split("\n")) {
    let line = rawLine.trim();
    if (!line.startsWith(quoted)) continue;
    const next = line.charAt(quoted.length);
    if (next !== " " && next !== "\t") continue;
    if (line.endsWith(",")) line = line.slice(0, -1).trimEnd();
    return line;
  }
  return null;
}

// Remove a top-level column attribute (e.g. NOT NULL) without touching the same
// text inside a quoted default/comment or a parenthesised expression.
function removeAttribute(attributes: string, attribute: string): string {
  const target = attribute.toLowerCase();
  let result = "";
  let quote: string | null = null;
  let depth = 0;
  let index = 0;

  while (index < attributes.length) {
    const char = attributes[index];
    if (quote) {
      result += char;
      if (char === "\\" && index + 1 < attributes.length) {
        result += attributes[index + 1];
        index += 2;
        continue;
      }
      if (char === quote) {
        if (attributes[index + 1] === quote) {
          result += attributes[index + 1];
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      result += char;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      result += char;
      index += 1;
      continue;
    }

    const after = index + target.length;
    if (
      depth === 0 &&
      attributes.slice(index, after).toLowerCase() === target &&
      (index === 0 || !/[A-Za-z0-9_$]/.test(attributes[index - 1])) &&
      (after >= attributes.length || !/[A-Za-z0-9_$]/.test(attributes[after]))
    ) {
      while (result.length > 0 && /\s/.test(result[result.length - 1])) {
        result = result.slice(0, -1);
      }
      let next = after;
      while (next < attributes.length && /\s/.test(attributes[next])) {
        next += 1;
      }
      if (result.length > 0 && next < attributes.length) result += " ";
      index = next;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function replaceMysqlColumnDefinition(
  definition: string,
  currentName: string,
  nextName: string,
  currentType: string,
  nextType: string,
  nullable: boolean,
): string | null {
  const column = findMysqlColumnDefinition(definition, currentName);
  if (!column) return null;

  const currentQuoted = quoteIdentifier("mysql", currentName);
  if (!column.startsWith(currentQuoted)) return null;

  const rest = column.slice(currentQuoted.length);
  const leading = rest.length - rest.trimStart().length;
  const typeText = currentType.trim();
  if (
    !rest
      .slice(leading)
      .slice(0, typeText.length)
      .toLowerCase()
      .startsWith(typeText.toLowerCase())
  ) {
    return null;
  }

  const attributes = removeAttribute(
    rest.slice(leading + typeText.length),
    "NOT NULL",
  ).trim();
  const nullClause = nullable ? "" : " NOT NULL";
  const nextQuoted = quoteIdentifier("mysql", nextName);
  return `${nextQuoted} ${nextType}${nullClause}${
    attributes ? ` ${attributes}` : ""
  }`;
}

/** Null when the dialect can't change a column's type with a simple ALTER. */
export function changeTypeSql(
  dialect: Dialect,
  database: string,
  table: string,
  name: string,
  type: string,
  nullable: boolean,
  context?: ChangeTypeContext,
): string | null {
  const ref = tableRef(dialect, database, table);
  if (dialect === "mysql") {
    // MODIFY COLUMN replaces the entire definition, so without the original
    // definition we would drop DEFAULT / AUTO_INCREMENT / EXTRA. Refuse rather
    // than generate a destructive statement.
    if (!context) return null;
    const definition = replaceMysqlColumnDefinition(
      context.definition,
      context.currentName ?? name,
      name,
      context.currentType,
      type.trim(),
      nullable,
    );
    return definition ? `ALTER TABLE ${ref} MODIFY COLUMN ${definition}` : null;
  }

  const col = quoteIdentifier(dialect, name);
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
