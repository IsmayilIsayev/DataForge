import type { SavedQueriesFile, SavedQuery } from "./types";

/** Same heuristic the query-history filter uses. */
export const SAVED_QUERY_SECRET =
  /(IDENTIFIED\s+BY|PASSWORD|SECRET|TOKEN|API_KEY)/i;

export function emptySavedQueries(): SavedQueriesFile {
  return { version: 1, folders: [], queries: [] };
}

export function looksLikeSecret(sql: string): boolean {
  return SAVED_QUERY_SECRET.test(sql);
}

export function newSavedId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

export function upsertSavedQuery(
  document: SavedQueriesFile,
  query: SavedQuery,
): SavedQueriesFile {
  const exists = document.queries.some((item) => item.id === query.id);
  return {
    ...document,
    queries: exists
      ? document.queries.map((item) => (item.id === query.id ? query : item))
      : [...document.queries, query],
  };
}

export function removeSavedQuery(
  document: SavedQueriesFile,
  id: string,
): SavedQueriesFile {
  return {
    ...document,
    queries: document.queries.filter((item) => item.id !== id),
  };
}

export function duplicateSavedQuery(
  document: SavedQueriesFile,
  id: string,
): { document: SavedQueriesFile; query: SavedQuery | null } {
  const source = document.queries.find((item) => item.id === id);
  if (!source) return { document, query: null };
  const now = Date.now();
  const query: SavedQuery = {
    ...source,
    id: newSavedId("q"),
    name: `${source.name} (copy)`,
    created_at: now,
    updated_at: now,
  };
  return { document: upsertSavedQuery(document, query), query };
}

export function moveSavedQuery(
  document: SavedQueriesFile,
  id: string,
  folderId: string | undefined,
): SavedQueriesFile {
  return {
    ...document,
    queries: document.queries.map((item) =>
      item.id === id
        ? { ...item, folder_id: folderId, updated_at: Date.now() }
        : item,
    ),
  };
}

export function savedQueryMatches(query: SavedQuery, needle: string): boolean {
  if (!needle) return true;
  return (
    query.name.toLowerCase().includes(needle) ||
    (query.description ?? "").toLowerCase().includes(needle) ||
    query.sql.toLowerCase().includes(needle)
  );
}
