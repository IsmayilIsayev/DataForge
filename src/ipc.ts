import { invoke } from "@tauri-apps/api/core";
import type {
  AiConfig,
  AiExplainResult,
  AiFixResult,
  AiOptimizeResult,
  AiProvider,
  CellRef,
  CellValue,
  ColumnInfo,
  ConnectionInput,
  ConnectionMeta,
  ConnectionState,
  Nl2SqlResult,
  QueryResult,
  SchemaSnapshot,
  TableInfo,
  TestConnectionResult,
} from "./types";

export const listConnections = () =>
  invoke<ConnectionMeta[]>("list_connections");

export const saveConnection = (input: ConnectionInput) =>
  invoke<ConnectionMeta>("save_connection", { input });

export const deleteConnection = (id: string) =>
  invoke<void>("delete_connection", { id });

export const updateConnection = (id: string, input: ConnectionInput) =>
  invoke<ConnectionMeta>("update_connection", { id, input });

export const listConnectionStates = () =>
  invoke<ConnectionState[]>("list_connection_states");

export const connectConnection = (connId: string) =>
  invoke<void>("connect_connection", { conn_id: connId });

export const disconnectConnection = (connId: string) =>
  invoke<void>("disconnect_connection", { conn_id: connId });

export const testConnection = (input: ConnectionInput, id?: string) =>
  invoke<TestConnectionResult>("test_connection", { input, id: id ?? null });

export const pickSqliteFile = () =>
  invoke<string | null>("pick_sqlite_file");

export const runQuery = (
  connId: string,
  sql: string,
  maxRows = 1000,
  database?: string,
  orderBy = "",
) =>
  invoke<QueryResult>("run_query", {
    conn_id: connId,
    sql,
    max_rows: maxRows,
    database: database ?? null,
    order_by: orderBy.trim() ? orderBy : null,
  });

export const listDatabases = (connId: string) =>
  invoke<string[]>("list_databases", { conn_id: connId });

export const listTables = (connId: string, database: string) =>
  invoke<TableInfo[]>("list_tables", {
    conn_id: connId,
    database,
  });

export const listColumns = (
  connId: string,
  database: string,
  table: string,
) =>
  invoke<ColumnInfo[]>("list_columns", {
    conn_id: connId,
    database,
    table,
  });

export const getSchema = (connId: string, database: string) =>
  invoke<SchemaSnapshot>("get_schema", {
    conn_id: connId,
    database,
  });

export interface SearchHit {
  kind: "table" | "column" | "data";
  table: string;
  column?: string;
  value?: string;
}

export const findInDatabase = (
  connId: string,
  database: string,
  term: string,
  caseInsensitive: boolean,
  includeData: boolean,
  onlyTable?: string,
) =>
  invoke<SearchHit[]>("find_in_database", {
    conn_id: connId,
    database,
    term,
    case_insensitive: caseInsensitive,
    include_data: includeData,
    only_table: onlyTable ?? null,
  });

export const exportResultXlsx = (
  columns: string[],
  rows: CellValue[][],
  defaultName: string,
) =>
  invoke<string | null>("export_result_xlsx", {
    columns,
    rows,
    default_name: defaultName,
  });

export type { CellRef } from "./types";

export type ChangeInput =
  | { kind: "update"; pk: CellRef[]; column: string; value: string | null }
  | { kind: "delete"; pk: CellRef[] }
  | { kind: "insert"; values: CellRef[] };

export interface ApplyChangesOutcome {
  ok: boolean;
  rows_affected: number;
  statements: string[];
  failed_change?: number;
  error?: string;
}

export const updateCell = (
  connId: string,
  database: string,
  table: string,
  pk: CellRef[],
  column: string,
  value: string | null,
) =>
  invoke<number>("update_cell", {
    conn_id: connId,
    database,
    table,
    pk,
    column,
    value,
  });

export const insertRow = (
  connId: string,
  database: string,
  table: string,
  values: CellRef[],
) =>
  invoke<number>("insert_row", {
    conn_id: connId,
    database,
    table,
    values,
  });

export const deleteRows = (
  connId: string,
  database: string,
  table: string,
  rows: CellRef[][],
) =>
  invoke<number>("delete_rows", {
    conn_id: connId,
    database,
    table,
    rows,
  });

export const previewChanges = (
  connId: string,
  database: string,
  table: string,
  changes: ChangeInput[],
) =>
  invoke<string[]>("preview_changes", {
    conn_id: connId,
    database,
    table,
    changes,
  });

export const applyChanges = (
  connId: string,
  database: string,
  table: string,
  changes: ChangeInput[],
) =>
  invoke<ApplyChangesOutcome>("apply_changes", {
    conn_id: connId,
    database,
    table,
    changes,
  });

export const aiNl2Sql = (
  connId: string,
  question: string,
  includeSchema = true,
  database?: string,
) =>
  invoke<Nl2SqlResult>("ai_nl2sql", {
    conn_id: connId,
    question,
    include_schema: includeSchema,
    database: database ?? null,
  });

export const aiExplain = (sql: string, language?: string) =>
  invoke<AiExplainResult>("ai_explain", { sql, language: language ?? null });

export const aiFixError = (
  connId: string,
  database: string | undefined,
  sql: string,
  error: string,
) =>
  invoke<AiFixResult>("ai_fix_error", {
    conn_id: connId,
    database: database ?? null,
    sql,
    error,
  });

export const aiOptimize = (
  connId: string,
  database: string | undefined,
  sql: string,
) =>
  invoke<AiOptimizeResult>("ai_optimize", {
    conn_id: connId,
    database: database ?? null,
    sql,
  });

export const aiGetConfig = () => invoke<AiConfig>("ai_get_config");

export const aiSetConfig = (
  provider: AiProvider,
  model: string,
  baseUrl?: string,
  apiKey?: string,
) =>
  invoke<AiConfig>("ai_set_config", {
    provider,
    model,
    base_url: baseUrl ?? null,
    api_key: apiKey ?? null,
  });

export const aiHasKey = () => invoke<boolean>("ai_has_key");

const errorMessages: Record<string, string> = {
  NoApiKey: "AI API key is not set.",
  NoConnection:
    "Connection not found. Select a saved connection or connect to it again.",
};

function normalizeError(text: string): string {
  return errorMessages[text] ?? text;
}

export function errorMessage(error: unknown): string {
  if (typeof error === "string") {
    return normalizeError(error);
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const message = Object.values(error as Record<string, unknown>).find(
      (value) => typeof value === "string",
    );
    if (typeof message === "string") {
      return normalizeError(message);
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}
