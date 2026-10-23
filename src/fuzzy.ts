const EXACT_SCORE = 1000;
const PREFIX_SCORE = 700;
const WORD_PREFIX_SCORE = 550;
const SUBSTRING_SCORE = 300;
const SUBSEQUENCE_SCORE = 80;

export function azLower(value: string): string {
  return value
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .replace(/Ə/g, "ə")
    .toLowerCase();
}

function fold(value: string): string {
  return azLower(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function wordPrefix(value: string, needle: string): boolean {
  return value
    .split(/[\s._\-/\\]+/)
    .some((word) => word.length > 0 && word.startsWith(needle));
}

function subsequenceScore(value: string, needle: string): number {
  let index = 0;
  let first = -1;
  let last = -1;
  let gaps = 0;

  for (let position = 0; position < value.length && index < needle.length; position += 1) {
    if (value[position] !== needle[index]) continue;
    if (first < 0) {
      first = position;
    } else {
      gaps += position - last - 1;
    }
    last = position;
    index += 1;
  }

  if (index < needle.length) return 0;

  const lengthBoost = Math.min(needle.length, 20) * 4;
  return Math.max(1, SUBSEQUENCE_SCORE + lengthBoost - gaps * 3 - first * 2);
}

export function fuzzyScore(text: string, query: string): number {
  const needle = fold(query.trim());
  if (!needle) return 1;

  const value = fold(text);
  if (!value) return 0;
  if (value === needle) return EXACT_SCORE;
  if (value.startsWith(needle)) {
    return PREFIX_SCORE + Math.round((needle.length / value.length) * 100);
  }
  if (wordPrefix(value, needle)) {
    return WORD_PREFIX_SCORE + Math.round((needle.length / value.length) * 100);
  }

  const at = value.indexOf(needle);
  if (at >= 0) {
    return SUBSTRING_SCORE + Math.round((needle.length / value.length) * 100) - at;
  }

  return subsequenceScore(value, needle);
}

export function bestScore(fields: readonly string[], query: string): number {
  if (!query.trim()) return 1;

  let best = 0;
  fields.forEach((field, index) => {
    const weighted = fuzzyScore(field, query) * (index === 0 ? 1.2 : 1);
    if (weighted > best) best = weighted;
  });
  return best;
}

export interface RankedItem<T> {
  item: T;
  score: number;
}

export function rankItems<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => readonly string[],
): RankedItem<T>[] {
  return items
    .map((item) => ({ item, score: bestScore(fields(item), query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function matchPositions(text: string, query: string): number[] {
  const needle = fold(query.trim());
  if (!needle) return [];

  const value = fold(text);
  const direct = value.indexOf(needle);
  if (direct >= 0) {
    return Array.from({ length: needle.length }, (_, index) => direct + index);
  }

  const positions: number[] = [];
  let queryIndex = 0;
  for (let index = 0; index < value.length && queryIndex < needle.length; index += 1) {
    if (value[index] === needle[queryIndex]) {
      positions.push(index);
      queryIndex += 1;
    }
  }
  return queryIndex === needle.length ? positions : [];
}

export function selfCheck(): void {
  console.assert(azLower("İSTANBUL") === "istanbul", "azLower: İ -> i");
  console.assert(azLower("IŞIQ") === "ışıq", "azLower: I -> ı");
  console.assert(azLower("ƏLA") === "əla", "azLower: Ə -> ə");
  console.assert(
    fuzzyScore("orders", "ord") > fuzzyScore("word_order", "ord"),
    "ranking: prefix match should beat substring match",
  );
  console.assert(
    fuzzyScore("ODƏNİŞ", "ödəniş") === EXACT_SCORE,
    "matching: ödəniş should match ODƏNİŞ exactly",
  );
  console.assert(
    matchPositions("Orders", "ord").join(",") === "0,1,2",
    "highlight: prefix positions",
  );
}

if (import.meta.env.DEV) selfCheck();
