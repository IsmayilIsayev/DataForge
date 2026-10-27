import { dollarQuoteEnd, dollarTagAt } from "./dollarQuote";
import type { QueryParamType } from "./types";

/** One unique `:name` placeholder and where it first appears. */
export interface SqlParam {
  name: string;
  start: number;
  end: number;
}

/**
 * Find `:name` placeholders outside strings, quoted identifiers, comments,
 * dollar-quoted bodies and bracketed sections (array slices / `[ident]`).
 * Names are unique and ordered by their first appearance.
 */
export function findParams(sql: string): SqlParam[] {
  const found = new Map<string, SqlParam>();
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "-" && next === "-") {
      index = endOfLine(sql, index + 2);
      continue;
    }
    if (char === "#") {
      index = endOfLine(sql, index + 1);
      continue;
    }
    if (char === "/" && next === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      index = endOfQuoted(sql, index, char);
      continue;
    }

    const tag = dollarTagAt(sql, index);
    if (tag) {
      index = dollarQuoteEnd(sql, index + tag.length, tag);
      continue;
    }

    if (char === "[") {
      index = endOfBracket(sql, index + 1);
      continue;
    }

    if (char === ":") {
      const previous = index > 0 ? sql[index - 1] : "";
      if (
        next !== ":" &&
        next !== "=" &&
        previous !== ":" &&
        !/[A-Za-z0-9_$]/.test(previous ?? "") &&
        /[A-Za-z_]/.test(next ?? "")
      ) {
        let end = index + 2;
        while (/[A-Za-z0-9_]/.test(sql[end] ?? "")) end += 1;
        const name = sql.slice(index + 1, end);
        if (!found.has(name)) {
          found.set(name, { name, start: index, end });
        }
        index = end;
        continue;
      }
    }

    index += 1;
  }

  return [...found.values()];
}

export function paramNames(sql: string): string[] {
  return findParams(sql).map((param) => param.name);
}

/** Number when the remembered/typed value looks numeric, otherwise Text. */
export function guessParamType(value: string): QueryParamType {
  const trimmed = value.trim();
  if (!trimmed) return "Text";
  return Number.isFinite(Number(trimmed)) ? "Number" : "Text";
}

function endOfLine(sql: string, from: number): number {
  const newline = sql.indexOf("\n", from);
  return newline === -1 ? sql.length : newline + 1;
}

function endOfQuoted(sql: string, index: number, quote: string): number {
  let cursor = index + 1;
  while (cursor < sql.length) {
    const char = sql[cursor];
    if (char === "\\" && cursor + 1 < sql.length) {
      cursor += 2;
      continue;
    }
    if (char === quote) {
      if (sql[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return sql.length;
}

function endOfBracket(sql: string, from: number): number {
  const close = sql.indexOf("]", from);
  return close === -1 ? sql.length : close + 1;
}

/**
 * Dev-only sanity checks (there is no frontend test runner). The same cases
 * are covered by the Rust rewrite tests so both scanners stay in sync.
 */
export function selfCheck() {
  const sql = "SELECT * FROM users WHERE id = :id AND status = :status";
  const params = findParams(sql);
  console.assert(
    params.length === 2 && params[0]?.name === "id" && params[1]?.name === "status",
    "named placeholders should be found in order",
  );
  console.assert(
    params[0]?.start === sql.indexOf(":id") &&
      params[0]?.end === sql.indexOf(":id") + 3,
    "placeholder positions should point at the source text",
  );

  const repeated = findParams("SELECT :id, :id, :name");
  console.assert(
    repeated.length === 2 && repeated[0]?.name === "id" && repeated[1]?.name === "name",
    "the same name used twice is one parameter",
  );

  console.assert(
    findParams("SELECT '10:30', \"a:b\", `c:d`").length === 0,
    "colons inside strings and quoted identifiers are not parameters",
  );
  console.assert(
    findParams("-- :line\n/* :block */ SELECT 1").length === 0,
    "colons inside comments are not parameters",
  );
  console.assert(
    findParams("CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM ':x'; END $$").length === 0,
    "colons inside dollar-quoted bodies are not parameters",
  );
  console.assert(
    findParams("SELECT value::int, label := 1 FROM t").length === 0,
    "Postgres casts and assignments are not parameters",
  );
  console.assert(
    findParams("SELECT @var, data[1:2], arr[3:4] FROM t").length === 0,
    "MySQL variables and array slices are not parameters",
  );
}

if (import.meta.env.DEV) {
  selfCheck();
}
