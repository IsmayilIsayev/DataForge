export interface FindMatch {
  row: number;
  col: number;
}

/**
 * Substring search over a precomputed grid of cell text.
 *
 * `cellsLower` must already be lowercased when `matchCase` is false; pass the
 * display strings when `matchCase` is true. This keeps the hot loop free of
 * extra lowercasing while still allowing an exact-case search.
 */
export function findMatches(
  cellsLower: readonly (readonly string[])[],
  query: string,
  matchCase: boolean,
): FindMatch[] {
  if (query.length === 0) return [];
  const needle = matchCase ? query : query.toLowerCase();
  const matches: FindMatch[] = [];
  for (let row = 0; row < cellsLower.length; row++) {
    const cells = cellsLower[row];
    for (let col = 0; col < cells.length; col++) {
      if (cells[col].includes(needle)) {
        matches.push({ row, col });
      }
    }
  }
  return matches;
}

export function selfCheck() {
  const lower = [
    ["hello world", "null"],
    ["hello", "other"],
  ];
  console.assert(
    findMatches(lower, "HELLO", false).length === 2,
    "case-insensitive find should lowercase the query",
  );
  console.assert(
    findMatches(lower, "null", false)[0]?.col === 1,
    "NULL cells should match their display text",
  );

  const mixed = [
    ["hello world", "null"],
    ["HELLO", "other"],
  ];
  const exact = findMatches(mixed, "HELLO", true);
  console.assert(
    exact.length === 1 && exact[0].row === 1 && exact[0].col === 0,
    "match case should only find the exact-case cell",
  );
  console.assert(
    findMatches(mixed, "hello", true).length === 1,
    "match case should still find lowercase text",
  );
  console.assert(
    findMatches(mixed, "", true).length === 0,
    "an empty query should match nothing",
  );
}

if (import.meta.env.DEV) {
  selfCheck();
}
