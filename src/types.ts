export type Dialect = "mysql" | "postgres" | "sqlite" | "mssql" | "mongodb" | "clickhouse";

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

export interface AiModelList {
  models: string[];
  offline: boolean;
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

export interface DatabaseTable {
  database: string;
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

export interface ErColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  pk: boolean;
}

export interface ErTable {
  name: string;
  columns: ErColumn[];
}

export interface ErForeignKey {
  name: string;
  from_table: string;
  from_columns: string[];
  to_table: string;
  to_columns: string[];
}

export interface ErSchema {
  database: string;
  tables: ErTable[];
  foreign_keys: ErForeignKey[];
  truncated: boolean;
}

export interface SchemaColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
  default?: string | null;
  auto_increment: boolean;
}

export interface SchemaIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface SchemaForeignKey {
  name: string;
  from_table: string;
  from_columns: string[];
  to_table: string;
  to_columns: string[];
}

export interface SchemaView {
  name: string;
  definition?: string | null;
}

export interface DiffSummary {
  added_tables: number;
  removed_tables: number;
  changed_tables: number;
  added_columns: number;
  removed_columns: number;
  changed_columns: number;
  added_indexes: number;
  removed_indexes: number;
  added_foreign_keys: number;
  removed_foreign_keys: number;
  added_views: number;
  removed_views: number;
  changed_views: number;
  statements: number;
  destructive: number;
}

export interface DiffStatement {
  sql: string;
  kind: string;
  table?: string | null;
  destructive: boolean;
  reason?: string | null;
}

export interface TableDiffItem {
  kind: string;
  label: string;
  destructive: boolean;
  reason?: string | null;
  before?: string | null;
  after?: string | null;
  before_column?: SchemaColumn | null;
  after_column?: SchemaColumn | null;
  changes?: string[];
}

export interface TableDiff {
  name: string;
  status: "added" | "removed" | "changed";
  items: TableDiffItem[];
}

export interface ViewDiff {
  name: string;
  status: "added" | "removed" | "changed";
  definition?: string | null;
}

export interface SchemaDiff {
  dialect: Dialect;
  source_database: string;
  target_database: string;
  source_truncated: boolean;
  target_truncated: boolean;
  summary: DiffSummary;
  tables: TableDiff[];
  views: ViewDiff[];
  statements: DiffStatement[];
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

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatResultContext {
  sql: string;
  columns: string[];
  rows: CellValue[][];
}

export interface ChatRequest {
  id: number;
  content: string;
  result?: ChatResultContext;
}

export interface PlanNode {
  label: string;
  relation?: string;
  index?: string;
  rows_estimated?: number;
  rows_actual?: number;
  cost?: number;
  time_ms?: number;
  warnings: string[];
  children: PlanNode[];
}

export interface ExplainPlan {
  dialect: string;
  analyzed: boolean;
  sql: string;
  root: PlanNode;
  raw: string;
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

export interface SavedQueryFolder {
  id: string;
  name: string;
  created_at: number;
}

export interface SavedQuery {
  id: string;
  name: string;
  description?: string;
  folder_id?: string;
  sql: string;
  conn_id?: string;
  database?: string;
  created_at: number;
  updated_at: number;
}

export interface SavedQueriesFile {
  version: number;
  folders: SavedQueryFolder[];
  queries: SavedQuery[];
}

export interface PortableSshConfig {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  key_path?: string;
}

/** Metadata-only connection representation used by .dataforge.json files. */
export interface PortableConnection {
  name: string;
  dialect: Dialect;
  host: string;
  port: number;
  username: string;
  database?: string;
  environment?: ConnectionEnvironment;
  flavor?: string;
  ssl_mode?: SslMode;
  ssl_ca_path?: string;
  ssh?: PortableSshConfig;
  read_only?: boolean;
}

export interface ConnectionImportPreviewItem {
  index: number;
  connection: PortableConnection;
  conflict: "name" | "endpoint" | "both" | null;
  conflict_with: string | null;
}

export interface ConnectionImportPreview {
  path: string;
  header: string;
  connections: ConnectionImportPreviewItem[];
  saved_query_count: number;
}

export interface ConnectionImportDecision {
  index: number;
  action: "new" | "skip" | "replace";
}

export interface ConnectionImportResult {
  imported: number;
  replaced: number;
  skipped: number;
  saved_queries: number;
}

export type TestDataLocale = "en" | "az";

export type TestDataGeneratorKind =
  | "skip"
  | "null"
  | "constant"
  | "sequence"
  | "int"
  | "decimal"
  | "boolean"
  | "date"
  | "time"
  | "uuid"
  | "list"
  | "regex"
  | "lorem_words"
  | "lorem_sentence"
  | "first_name"
  | "last_name"
  | "full_name"
  | "email"
  | "phone"
  | "city"
  | "street_address"
  | "company"
  | "product_name"
  | "price"
  | "status"
  | "color"
  | "url"
  | "ip"
  | "foreign_key";

export interface TestDataGenerator {
  kind: TestDataGeneratorKind;
  constant?: string | null;
  start?: number | null;
  step?: number | null;
  min?: number | null;
  max?: number | null;
  precision?: number | null;
  date_from?: string | null;
  date_to?: string | null;
  items?: string[] | null;
  pattern?: string | null;
  words?: number | null;
  locale?: TestDataLocale | null;
  table?: string | null;
  column?: string | null;
}

export interface TestDataForeignKey {
  table: string;
  column: string;
}

export interface TestDataColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
  auto_increment: boolean;
  unique: boolean;
  default?: string | null;
  foreign_key?: TestDataForeignKey | null;
  suggested: TestDataGenerator;
}

export interface TestDataColumnConfig {
  name: string;
  generator: TestDataGenerator;
  null_percent: number;
}

export interface TestDataPreview {
  columns: string[];
  rows: CellValue[][];
}

export interface GenerateSummary {
  inserted: number;
  cancelled: boolean;
}

export interface GenerateProgress {
  id: string;
  done: boolean;
  cancelled: boolean;
  generated: number;
  total: number;
}
