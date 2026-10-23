export type Dialect = "mysql" | "postgres" | "sqlite" | "mssql" | "mongodb";

export interface ConnectionMeta {
  id: string;
  name: string;
  dialect: Dialect;
  host: string;
  port: number;
  username: string;
  database?: string;
  read_only?: boolean;
}

export interface ConnectionInput extends Omit<ConnectionMeta, "id"> {
  password?: string;
  save_password?: boolean;
}

export interface ConnectionState {
  id: string;
  connected: boolean;
}

export type AiProvider = "openai" | "openai_compatible" | "google";

export interface AiConfig {
  provider: AiProvider;
  model: string;
  base_url?: string;
  has_key: boolean;
}

export type CellValue = string | number | boolean | null;

export interface QueryResult {
  columns: string[];
  rows: CellValue[][];
  rows_affected?: number;
  elapsed_ms: number;
  truncated: boolean;
}

export interface TableInfo {
  name: string;
  kind: "table" | "view";
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  key?: "PRI" | "UNI" | "MUL";
}

export interface SchemaSnapshot {
  database: string;
  tables: Array<{ name: string; columns: ColumnInfo[] }>;
}

export interface Nl2SqlResult {
  sql: string;
  explanation: string;
  warnings: string[];
  needs_confirmation: boolean;
  schema_tables: string[];
  schema_total_tables: number;
  schema_tokens: number;
  schema_truncated: boolean;
  raw: string;
}

export interface AiExplainResult {
  summary: string;
}

export interface AiOptimizeResult {
  suggestions: string[];
  rewritten_sql?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}
