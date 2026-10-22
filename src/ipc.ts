import { invoke } from "@tauri-apps/api/core";
import type {
  AiConfig,
  AiExplainResult,
  AiProvider,
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
) =>
  invoke<QueryResult>("run_query", {
    conn_id: connId,
    sql,
    max_rows: maxRows,
    database: database ?? null,
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

export interface CellRef {
  column: string;
  value: string | null;
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

export const aiExplain = (sql: string) =>
  invoke<AiExplainResult>("ai_explain", { sql });

export const aiGetConfig = () => invoke<AiConfig>("ai_get_config");

export const aiSetConfig = (
  provider: AiProvider,
  model: string,
  baseUrl?: string,
  apiKey?: string,
  schemaTokenBudget?: number,
) =>
  invoke<AiConfig>("ai_set_config", {
    provider,
    model,
    base_url: baseUrl ?? null,
    api_key: apiKey ?? null,
    schema_token_budget: schemaTokenBudget ?? null,
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
