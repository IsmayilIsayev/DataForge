import { dollarQuoteEnd, dollarTagAt } from "./dollarQuote";

/**
 * Pure SQL classifier used for production safeguards and read-only connections.
 * It deliberately does not depend on any editor or UI code so it stays easy to
 * reason about (and to assert against in development).
 */

export type StatementKind = "read" | "write" | "ddl";

export interface ClassifiedStatement {
  sql: string;
  kind: StatementKind;
  keyword: string;
  /** True when UPDATE/DELETE has a WHERE at the statement's top level. */
  hasWhere: boolean;
  /** DROP/TRUNCATE and UPDATE/DELETE without a WHERE need a typed confirmation. */
  requiresTypedConfirm: boolean;
}

export interface SqlClassification {
  statements: ClassifiedStatement[];
  hasWrite: boolean;
  hasDdl: boolean;
  requiresTypedConfirm: boolean;
}

const WRITE_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "REPLACE",
  "UPSERT",
]);

const READ_KEYWORDS = new Set([
  "SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE",
  "BEGIN", "START", "COMMIT", "ROLLBACK", "END", "SAVEPOINT", "RELEASE",
  "SET", "USE",
]);

const DDL_KEYWORDS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "GRANT",
  "REVOKE",
]);

type ScanState =
  | "normal"
  | "single"
  | "double"
  | "backtick"
  | "bracket"
  | "line"
  | "block";

function isWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$]/.test(char);
}

function blank(char: string): string {
  if (char === "\n" || char === "\r") return char;
  return " ";
}

/**
 * Replace comments and quoted sections with spaces while keeping the original
 * length. This lets us look for keywords and parentheses without being fooled
 * by text inside strings or comments.
 */
function maskSql(sql: string): string {
  let out = "";
  let state: ScanState = "normal";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (state === "line") {
      out += blank(char);
      if (char === "\n") state = "normal";
      index += 1;
      continue;
    }

    if (state === "block") {
      if (char === "*" && next === "/") {
        out += "  ";
        index += 2;
        state = "normal";
      } else {
        out += blank(char);
        index += 1;
      }
      continue;
    }

    if (state !== "normal") {
      const quote =
        state === "single"
          ? "'"
          : state === "double"
            ? '"'
            : state === "backtick"
              ? "`"
              : "]";

      if (state !== "bracket" && char === "\\" && index + 1 < sql.length) {
        out += "  ";
        index += 2;
        continue;
      }

      if (char === quote) {
        if (next === quote) {
          out += "  ";
          index += 2;
        } else {
          out += " ";
          index += 1;
          state = "normal";
        }
      } else {
        out += blank(char);
        index += 1;
      }
      continue;
    }

    const tag = dollarTagAt(sql, index);
    if (tag) {
      // Mask the whole dollar-quoted body so its keywords and ";" are ignored.
      const end = dollarQuoteEnd(sql, index + tag.length, tag);
      out += sql.slice(index, end).replace(/[^\n]/g, " ");
      index = end;
      continue;
    }

    if (char === "-" && next === "-") {
      out += "  ";
      index += 2;
      state = "line";
      continue;
    }
    if (char === "#") {
      out += " ";
      index += 1;
      state = "line";
      continue;
    }
    if (char === "/" && next === "*") {
      out += "  ";
      index += 2;
      state = "block";
      continue;
    }

    if (char === "'") {
      out += " ";
      index += 1;
      state = "single";
      continue;
    }
    if (char === '"') {
      out += " ";
      index += 1;
      state = "double";
      continue;
    }
    if (char === "`") {
      out += " ";
      index += 1;
      state = "backtick";
      continue;
    }
    if (char === "[") {
      out += " ";
      index += 1;
      state = "bracket";
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function tokensOf(masked: string): string[] {
  return masked.match(/[A-Za-z_][A-Za-z0-9_$]*/g)?.map((token) =>
    token.toUpperCase(),
  ) ?? [];
}

function hasTopLevelWhere(masked: string): boolean {
  let depth = 0;

  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];

    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || (char !== "W" && char !== "w")) continue;
    if (isWordChar(masked[index - 1])) continue;
    if (!/^where\b/i.test(masked.slice(index))) continue;
    if (isWordChar(masked[index + 5])) continue;
    return true;
  }

  return false;
}

/** Split on top-level semicolons, ignoring comments, strings and identifiers. */
export function splitStatements(sql: string): string[] {
  const masked = maskSql(sql);
  const statements: string[] = [];
  let start = 0;

  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== ";") continue;
    const statement = sql.slice(start, index).trim();
    if (maskSql(statement).trim()) statements.push(statement);
    start = index + 1;
  }

  const tail = sql.slice(start).trim();
  if (maskSql(tail).trim()) statements.push(tail);
  return statements;
}

export function classifyStatement(sql: string): ClassifiedStatement {
  const masked = maskSql(sql);
  const tokens = tokensOf(masked);
  const first = tokens[0] ?? "";
  let kind: StatementKind = "read";
  let keyword = first || "UNKNOWN";

  // Fail safe: only known read-only / session-control statements skip the
  // prod confirm; anything unrecognised (CALL, EXEC, DO, COPY, PRAGMA, ...)
  // is treated as a write because it may change data.
  const embeddedWrite = (list: string[]) =>
    list.find((token) => WRITE_KEYWORDS.has(token) || DDL_KEYWORDS.has(token));

  if (first === "WITH") {
    // Postgres data-modifying CTEs (WITH ... AS (DELETE ...)) are writes even
    // though the statement starts with WITH.
    const write = embeddedWrite(tokens);
    if (write) {
      keyword = write;
      kind = DDL_KEYWORDS.has(write) ? "ddl" : "write";
    } else {
      keyword = "WITH";
      kind = "read";
    }
  } else if (first === "EXPLAIN") {
    // EXPLAIN ANALYZE really executes the statement it explains.
    const analyze = tokens.includes("ANALYZE") || tokens.includes("ANALYSE");
    const write = analyze ? embeddedWrite(tokens.slice(1)) : undefined;
    if (write) {
      keyword = write;
      kind = DDL_KEYWORDS.has(write) ? "ddl" : "write";
    }
  } else if (first === "SELECT" && tokens.includes("INTO")) {
    // SELECT ... INTO new_table creates a table (Postgres, SQL Server).
    keyword = "SELECT INTO";
    kind = "ddl";
  } else if (WRITE_KEYWORDS.has(first)) {
    keyword = first;
    kind = "write";
  } else if (DDL_KEYWORDS.has(first)) {
    keyword = first;
    kind = "ddl";
  } else if (first && !READ_KEYWORDS.has(first)) {
    kind = "write";
  }

  const hasWhere = hasTopLevelWhere(masked);
  const requiresTypedConfirm =
    (kind === "ddl" && (keyword === "DROP" || keyword === "TRUNCATE")) ||
    (kind === "write" &&
      (keyword === "DELETE" || keyword === "UPDATE") &&
      !hasWhere);

  return {
    sql: sql.trim(),
    kind,
    keyword,
    hasWhere,
    requiresTypedConfirm,
  };
}

export function classifySql(sql: string): SqlClassification {
  const statements = splitStatements(sql).map(classifyStatement);
  return {
    statements,
    hasWrite: statements.some((statement) => statement.kind !== "read"),
    hasDdl: statements.some((statement) => statement.kind === "ddl"),
    requiresTypedConfirm: statements.some(
      (statement) => statement.requiresTypedConfirm,
    ),
  };
}

/**
 * Dev-only sanity checks for the pure classifier. There is no test runner in
 * this project, so failures show up as console.assert messages in development.
 */
export function selfCheck() {
  console.assert(
    !classifySql("-- DROP TABLE x\nSELECT 1").hasWrite,
    "a DROP inside a line comment must not count as a write",
  );
  console.assert(
    !classifySql("SELECT 'DELETE FROM t'").hasWrite,
    "a DELETE inside a string literal must not count as a write",
  );

  const cte = classifySql(
    "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
  );
  console.assert(
    cte.hasWrite && cte.statements[0]?.keyword === "DELETE",
    "a data-modifying CTE must count as a write",
  );

  const deleteWithWhere = classifySql("delete from t where id=1");
  console.assert(
    deleteWithWhere.hasWrite &&
      deleteWithWhere.statements[0]?.hasWhere === true &&
      !deleteWithWhere.requiresTypedConfirm,
    "DELETE with WHERE should be a normal write confirmation",
  );

  const deleteAll = classifySql("DELETE FROM t");
  console.assert(
    deleteAll.hasWrite && deleteAll.requiresTypedConfirm,
    "DELETE without WHERE should require a typed confirmation",
  );

  const updateAll = classifySql("UPDATE t SET x = 1");
  console.assert(
    updateAll.hasWrite && updateAll.requiresTypedConfirm,
    "UPDATE without WHERE should require a typed confirmation",
  );

  const updateNested = classifySql(
    "UPDATE t SET x = (SELECT max(x) FROM u WHERE u.id = t.id)",
  );
  console.assert(
    updateNested.requiresTypedConfirm,
    "a WHERE inside a subquery must not make a top-level UPDATE safe",
  );

  console.assert(
    classifySql("DROP TABLE x").requiresTypedConfirm,
    "DROP should require a typed confirmation",
  );
  console.assert(
    classifySql("SELECT 1; DELETE FROM t WHERE id = 1").hasWrite,
    "batches should be classified statement by statement",
  );
  console.assert(
    splitStatements("SELECT ';'; SELECT 2").length === 2,
    "semicolons inside strings must not split statements",
  );
}

if (import.meta.env.DEV) {
  selfCheck();
}
