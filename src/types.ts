export type Dialect = "mysql" | "postgres" | "sqlite" | "mssql" | "mongodb";

export type ConnectionEnvironment = "dev" | "test" | "prod";

export type SslMode =
  | "disable"
  | "prefer"
  | "require"
  | "verify_ca"
  | "verify_full";

export type SshAuth = "password" | "key";

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  key_path?: string;
  /** SHA256 fingerprint learned on the first successful connection. */
  host_key?: string;
}

export interface ConnectionMeta {
  id: string;
  name: string;
  dialect: Dialect;
  host: string;
  port: number;
  username: string;
  database?: string;
  read_only?: boolean;
  environment?: ConnectionEnvironment;
  flavor?: string;
  trust_cert?: boolean;
  ssl_mode?: SslMode;
  ssl_ca_path?: string;
  ssh?: SshConfig;
}

export interface ConnectionInput extends Omit<ConnectionMeta, "id"> {
  password?: string;
  save_password?: boolean;
  /** Transient SSH password or key passphrase; stored in the OS keychain. */
  ssh_secret?: string;
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

/** One column reference with its value, used for primary-key WHERE clauses and
 * INSERT payloads. `value: null` means SQL NULL. */
export interface CellRef {
  column: string;
  value: string | null;
}

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

export interface AiFixResult {
  sql: string;
  explanation: string;
  warnings: string[];
  needs_confirmation: boolean;
}

export interface AiOptimizeResult {
  suggestions: string[];
  rewritten_sql?: string | null;
}

export interface AiTextTarget {
  sql: string;
  start: number;
  end: number;
}

export type AiActionState =
  | {
      kind: "fix";
      originalSql: string;
      target: AiTextTarget | null;
      result: AiFixResult | null;
      error: string | null;
    }
  | {
      kind: "explain";
      originalSql: string;
      target: AiTextTarget | null;
      result: AiExplainResult | null;
      error: string | null;
    }
  | {
      kind: "optimize";
      originalSql: string;
      target: AiTextTarget | null;
      result: AiOptimizeResult | null;
      error: string | null;
    };

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  ssh_host_key?: string;
}
