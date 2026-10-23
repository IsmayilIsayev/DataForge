// PostgreSQL dollar-quoted strings ($$ ... $$, $tag$ ... $tag$) hold function bodies whose ";" must not split statements.

/** The `$tag$` that opens a dollar-quoted string at `index`, or null. */
export function dollarTagAt(sql: string, index: number): string | null {
  if (sql[index] !== "$") return null;
  // `a$b$` is part of an identifier, not a quote.
  if (index > 0 && /[\p{L}\p{N}_]/u.test(sql[index - 1])) return null;
  const match = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(sql.slice(index, index + 64));
  return match ? match[0] : null;
}

/** Index just past the closing tag, or sql.length when the body is unterminated. */
export function dollarQuoteEnd(sql: string, bodyStart: number, tag: string): number {
  const close = sql.indexOf(tag, bodyStart);
  return close === -1 ? sql.length : close + tag.length;
}
