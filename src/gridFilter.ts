import { escapeLikePattern, quoteIdentifier, stringLiteral } from "./sql";
import type { CellValue, Dialect } from "./types";

export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty"
  | "isNull"
  | "isNotNull"
  | "inList";

export interface ColumnFilter {
  column: string;
  op: FilterOperator;
  value: string;
}

export interface SortSpec {
  column: string;
  dir: "asc" | "desc";
}

export const FILTER_OPERATORS: Array<{
  value: FilterOperator;
  label: string;
  needsValue: boolean;
}> = [
  { value: "eq", label: "=", needsValue: true },
  { value: "neq", label: "≠", needsValue: true },
  { value: "gt", label: ">", needsValue: true },
  { value: "gte", label: "≥", needsValue: true },
  { value: "lt", label: "<", needsValue: true },
  { value: "lte", label: "≤", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "startsWith", label: "starts with", needsValue: true },
  { value: "endsWith", label: "ends with", needsValue: true },
  { value: "isEmpty", label: "is empty", needsValue: false },
  { value: "isNotEmpty", label: "is not empty", needsValue: false },
  { value: "isNull", label: "is NULL", needsValue: false },
  { value: "isNotNull", label: "is not NULL", needsValue: false },
  { value: "inList", label: "in list", needsValue: true },
];

export function filterNeedsValue(op: FilterOperator): boolean {
  return FILTER_OPERATORS.find((item) => item.value === op)?.needsValue ?? true;
}

export function describeFilter(filter: ColumnFilter): string {
  const meta = FILTER_OPERATORS.find((item) => item.value === filter.op);
  const label = meta?.label ?? filter.op;
  return meta?.needsValue
    ? `${filter.column} ${label} ${filter.value}`
    : `${filter.column} ${label}`;
}

function likeCondition(
  dialect: Dialect,
  column: string,
  pattern: string,
): string {
  const literal = stringLiteral(dialect, pattern);
  if (dialect === "postgres") {
    return `${column} ILIKE ${literal}`;
  }
  const escape =
    dialect === "sqlite" || dialect === "mssql" ? " ESCAPE '\\'" : "";
  return `LOWER(${column}) LIKE LOWER(${literal})${escape}`;
}

function inListCondition(
  dialect: Dialect,
  column: string,
  value: string,
): string {
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (values.length === 0) return "1 = 0";
  const literals = values.map((item) => stringLiteral(dialect, item));
  return `${column} IN (${literals.join(", ")})`;
}

export function buildWhere(
  dialect: Dialect,
  columns: string[],
  filters: ColumnFilter[],
): string {
  const known = new Set(columns);
  const parts: string[] = [];

  for (const filter of filters) {
    if (!known.has(filter.column)) continue;
    const column = quoteIdentifier(dialect, filter.column);
    switch (filter.op) {
      case "isNull":
        parts.push(`${column} IS NULL`);
        break;
      case "isNotNull":
        parts.push(`${column} IS NOT NULL`);
        break;
      case "isEmpty":
        parts.push(`${column} = ''`);
        break;
      case "isNotEmpty":
        parts.push(`${column} <> ''`);
        break;
      case "eq":
        parts.push(`${column} = ${stringLiteral(dialect, filter.value)}`);
        break;
      case "neq":
        parts.push(`${column} <> ${stringLiteral(dialect, filter.value)}`);
        break;
      case "gt":
        parts.push(`${column} > ${stringLiteral(dialect, filter.value)}`);
        break;
      case "gte":
        parts.push(`${column} >= ${stringLiteral(dialect, filter.value)}`);
        break;
      case "lt":
        parts.push(`${column} < ${stringLiteral(dialect, filter.value)}`);
        break;
      case "lte":
        parts.push(`${column} <= ${stringLiteral(dialect, filter.value)}`);
        break;
      case "contains":
        parts.push(
          likeCondition(
            dialect,
            column,
            `%${escapeLikePattern(filter.value)}%`,
          ),
        );
        break;
      case "startsWith":
        parts.push(
          likeCondition(
            dialect,
            column,
            `${escapeLikePattern(filter.value)}%`,
          ),
        );
        break;
      case "endsWith":
        parts.push(
          likeCondition(
            dialect,
            column,
            `%${escapeLikePattern(filter.value)}`,
          ),
        );
        break;
      case "inList":
        parts.push(inListCondition(dialect, column, filter.value));
        break;
    }
  }

  return parts.join(" AND ");
}

export function buildOrderBy(
  dialect: Dialect,
  columns: string[],
  sort: SortSpec | null,
): string {
  if (!sort || !columns.includes(sort.column)) return "";
  return `${quoteIdentifier(dialect, sort.column)} ${
    sort.dir === "desc" ? "DESC" : "ASC"
  }`;
}

function cellText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function compareValues(value: CellValue, target: string): number {
  if (typeof value === "number") {
    const numeric = Number(target);
    if (Number.isFinite(numeric)) return value - numeric;
  }
  return cellText(value).localeCompare(target, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function matches(filter: ColumnFilter, value: CellValue): boolean {
  const text = cellText(value);
  const target = filter.value;
  switch (filter.op) {
    case "isNull":
      return value === null;
    case "isNotNull":
      return value !== null;
    case "isEmpty":
      return value !== null && text === "";
    case "isNotEmpty":
      return value !== null && text !== "";
    case "eq":
      return value !== null && text === target;
    case "neq":
      return value !== null && text !== target;
    case "gt":
      return value !== null && compareValues(value, target) > 0;
    case "gte":
      return value !== null && compareValues(value, target) >= 0;
    case "lt":
      return value !== null && compareValues(value, target) < 0;
    case "lte":
      return value !== null && compareValues(value, target) <= 0;
    case "contains":
      return text.toLowerCase().includes(target.toLowerCase());
    case "startsWith":
      return text.toLowerCase().startsWith(target.toLowerCase());
    case "endsWith":
      return text.toLowerCase().endsWith(target.toLowerCase());
    case "inList": {
      const values = target
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return values.some(
        (item) => item.toLowerCase() === text.toLowerCase(),
      );
    }
  }
}

export function rowMatchesFilters(
  columns: string[],
  row: CellValue[],
  filters: ColumnFilter[],
): boolean {
  for (const filter of filters) {
    const index = columns.indexOf(filter.column);
    if (index < 0) continue;
    if (!matches(filter, row[index] ?? null)) return false;
  }
  return true;
}

export function filterRows(
  columns: string[],
  rows: CellValue[][],
  filters: ColumnFilter[],
): CellValue[][] {
  if (filters.length === 0) return rows;
  return rows.filter((row) => rowMatchesFilters(columns, row, filters));
}

export function selfCheck() {
  console.assert(
    escapeLikePattern("50%_off\\sale") === "50\\%\\_off\\\\sale",
    "LIKE escaping should cover %, _ and backslash",
  );

  const columns = ["email", "name"];
  const tricky = "O'Brien\\100%_x";
  const mysqlWhere = buildWhere("mysql", columns, [
    { column: "email", op: "eq", value: tricky },
  ]);
  console.assert(
    mysqlWhere === "`email` = 'O''Brien\\\\100%_x'",
    "MySQL equality should escape quotes and backslashes",
  );
  console.assert(
    buildWhere("postgres", columns, [
      { column: "email", op: "eq", value: tricky },
    ]) === `"email" = E'O''Brien\\\\100%_x'`,
    "Postgres equality should use an E literal",
  );

  const contains = [
    { column: "email", op: "contains" as const, value: "100%'\\" },
  ];
  console.assert(
    buildWhere("postgres", columns, contains) ===
      `"email" ILIKE E'%100\\\\%''\\\\\\\\%'`,
    "Postgres contains should use ILIKE and escaped LIKE patterns",
  );
  console.assert(
    buildWhere("mysql", columns, contains) ===
      "LOWER(`email`) LIKE LOWER('%100\\\\%''\\\\\\\\%')",
    "MySQL contains should be case-insensitive with LOWER",
  );
  console.assert(
    buildWhere("sqlite", columns, contains) ===
      `LOWER("email") LIKE LOWER('%100\\%''\\\\%') ESCAPE '\\'`,
    "SQLite contains should include the ESCAPE clause",
  );

  console.assert(
    buildWhere("mysql", columns, [
      { column: "email", op: "inList", value: "a, B'b" },
    ]) === "`email` IN ('a', 'B''b')",
    "in list should escape each value",
  );
  console.assert(
    buildWhere("mysql", columns, [
      { column: "email", op: "inList", value: " , " },
    ]) === "1 = 0",
    "an empty in list should match nothing",
  );

  console.assert(
    buildOrderBy("postgres", columns, { column: "email", dir: "desc" }) ===
      '"email" DESC',
    "ORDER BY should quote a known column",
  );
  console.assert(
    buildOrderBy("postgres", columns, {
      column: "email; DROP TABLE users",
      dir: "asc",
    }) === "",
    "ORDER BY should reject unknown columns",
  );

  const rows: CellValue[][] = [
    ["a@GMAIL.com", "Alice"],
    [null, "Bob"],
    ["b@example.com", "Carol"],
  ];
  console.assert(
    filterRows(columns, rows, [
      { column: "email", op: "contains", value: "gmail" },
    ]).length === 1,
    "client contains should be case-insensitive",
  );
  console.assert(
    filterRows(columns, rows, [
      { column: "email", op: "isNull", value: "" },
    ]).length === 1,
    "client is NULL should match null cells",
  );
  console.assert(
    filterRows(columns, rows, [
      { column: "name", op: "inList", value: "alice, carol" },
    ]).length === 2,
    "client in list should combine values",
  );
}

if (import.meta.env.DEV) {
  selfCheck();
}
