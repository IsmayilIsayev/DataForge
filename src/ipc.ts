import { invoke } from "@tauri-apps/api/core";
import type {
  AiConfig,
  AiExplainResult,
  AiFixResult,
  AiOptimizeResult,
  AiProvider,
  CellRef,
  CellValue,
  ChatMessage,
  ChatResultContext,
  ColumnInfo,
  ConnectionInput,
  ConnectionMeta,
  ConnectionState,
  Dialect,
  ExplainPlan,
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

export const pickSshKeyFile = () =>
  invoke<string | null>("pick_ssh_key_file");

export const pickCaCertificateFile = () =>
  invoke<string | null>("pick_ca_certificate_file");

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

export const explainPlan = (
  connId: string,
  database: string | undefined,
  sql: string,
  analyze: boolean,
) =>
  invoke<ExplainPlan>("explain_plan", {
    conn_id: connId,
    database: database ?? null,
    sql,
    analyze,
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

export type FindMode = "contains" | "starts_with" | "exact";

export interface FindProgress {
  id: string;
  done: number;
  total: number;
  table?: string;
  hits: SearchHit[];
  skipped: boolean;
}

export interface FindSummary {
  hits: SearchHit[];
  skipped: string[];
  cancelled: boolean;
  done: number;
  total: number;
}

export const findInDatabase = (
  connId: string,
  database: string,
  term: string,
  caseInsensitive: boolean,
  includeData: boolean,
  onlyTable?: string,
  mode: FindMode = "contains",
  findId?: string,
  noTimeout = false,
) =>
  invoke<FindSummary>("find_in_database", {
    conn_id: connId,
    database,
    term,
    case_insensitive: caseInsensitive,
    include_data: includeData,
    only_table: onlyTable ?? null,
    mode,
    find_id: findId ?? null,
    no_timeout: noTimeout,
  });

export const tableRowEstimate = (
  connId: string,
  database: string,
  table: string,
) =>
  invoke<number | null>("table_row_estimate", {
    conn_id: connId,
    database,
    table,
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

export type ExportFormat = "xlsx" | "csv" | "json" | "sql";

export interface ExportOptions {
  bom?: boolean;
  dialect?: Dialect;
  database?: string;
  table?: string;
}

export const exportResult = (
  format: ExportFormat,
  columns: string[],
  rows: CellValue[][],
  defaultName: string,
  options: ExportOptions = {},
) =>
  invoke<string | null>("export_result", {
    format,
    columns,
    rows,
    default_name: defaultName,
    bom: options.bom ?? null,
    dialect: options.dialect ?? null,
    database: options.database ?? null,
    table: options.table ?? null,
  });

export const exportTable = (
  connId: string,
  database: string,
  table: string,
  format: ExportFormat,
  exportId: string,
  bom?: boolean,
) =>
  invoke<string | null>("export_table", {
    conn_id: connId,
    database,
    table,
    format,
    export_id: exportId,
    bom: bom ?? null,
  });

export const cancelOperation = (operationId: string) =>
  invoke<void>("cancel_operation", { operation_id: operationId });

export interface CsvPreview {
  delimiter: string;
  rows: string[][];
}

export const previewCsv = (path: string, delimiter?: string | null) =>
  invoke<CsvPreview>("preview_csv", {
    path,
    delimiter: delimiter ?? null,
  });

export interface ColumnMapping {
  csv_index: number;
  column: string | null;
}

export interface ImportCsvParams {
  connId: string;
  database: string;
  table: string;
  path: string;
  delimiter?: string | null;
  hasHeader: boolean;
  mapping: ColumnMapping[];
  emptyAsNull: boolean;
  skipBadRows: boolean;
  importId: string;
}

export interface ImportSummary {
  inserted: number;
  skipped: number;
  errors: string[];
  cancelled: boolean;
}

export const importCsv = (params: ImportCsvParams) =>
  invoke<ImportSummary>("import_csv", {
    conn_id: params.connId,
    database: params.database,
    table: params.table,
    path: params.path,
    delimiter: params.delimiter ?? null,
    has_header: params.hasHeader,
    mapping: params.mapping,
    empty_as_null: params.emptyAsNull,
    skip_bad_rows: params.skipBadRows,
    import_id: params.importId,
  });

export interface TransferProgress {
  id: string;
  rows?: number;
  processed?: number;
  inserted?: number;
  skipped?: number;
  done: boolean;
  cancelled: boolean;
}

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

export const aiChat = (
  connId: string,
  database: string | undefined,
  messages: ChatMessage[],
  uiLanguage?: string,
  result?: ChatResultContext,
) =>
  invoke<string>("ai_chat", {
    conn_id: connId,
    database: database ?? null,
    messages,
    ui_language: uiLanguage ?? null,
    result: result ?? null,
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
  plan?: string,
) =>
  invoke<AiOptimizeResult>("ai_optimize", {
    conn_id: connId,
    database: database ?? null,
    sql,
    plan: plan ?? null,
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
