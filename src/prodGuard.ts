import { isProduction, isReadOnly } from "./environment";
import { classifySql } from "./sqlGuard";
import { useAppStore } from "./store";
import type { ConnectionMeta } from "./types";

export interface SqlGuardResult {
  allow: boolean;
  error?: string;
}

interface GuardOptions {
  title?: string;
  previewSql?: string;
}

function resolveConnection(
  connectionOrId: ConnectionMeta | string | null | undefined,
): ConnectionMeta | null {
  if (!connectionOrId) return null;
  if (typeof connectionOrId !== "string") return connectionOrId;
  return (
    useAppStore
      .getState()
      .connections.find((connection) => connection.id === connectionOrId) ??
    null
  );
}

/**
 * Frontend guard shared by every SQL/write path. Read-only connections always
 * block writes and DDL; production connections ask for confirmation.
 */
export async function guardSqlExecution(
  connectionOrId: ConnectionMeta | string | null | undefined,
  sql: string,
  database?: string,
  options: GuardOptions = {},
): Promise<SqlGuardResult> {
  const connection = resolveConnection(connectionOrId);
  if (!connection || !sql.trim()) return { allow: true };

  const classification = classifySql(sql);
  if (!classification.hasWrite) return { allow: true };

  if (isReadOnly(connection)) {
    return {
      allow: false,
      error: `“${connection.name}” is read-only — writes and DDL are blocked.`,
    };
  }

  if (!isProduction(connection)) return { allow: true };

  const databaseName = (
    database?.trim() ||
    connection.database?.trim() ||
    connection.name.trim()
  );
  const writeStatements = classification.statements.filter(
    (statement) => statement.kind !== "read",
  );
  if (writeStatements.length === 0) return { allow: true };

  const confirmed = await useAppStore.getState().requestProdConfirm({
    connectionName: connection.name,
    databaseName,
    statements: classification.statements,
    title: options.title,
    previewSql: options.previewSql,
  });
  return { allow: confirmed };
}

/** Read-only check for write paths that do not execute SQL through run_query. */
export function readOnlyWriteError(
  connectionOrId: ConnectionMeta | string | null | undefined,
): string | null {
  const connection = resolveConnection(connectionOrId);
  if (!connection || !isReadOnly(connection)) return null;
  return `“${connection.name}” is read-only — writes and DDL are blocked.`;
}
