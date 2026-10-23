# 04 — IPC Kontraktı (Tauri komandaları)

Frontend `invoke("<command>", args)` ilə backend-i çağırır. Bütün komandalar `Result<T, AppError>` qaytarır (JS tərəfdə uğursuzluq `Promise.reject` olur).

## Paylaşılan tiplər (`src/types.ts`)

```ts
export type Dialect = "mysql" | "postgres" | "sqlite" | "mssql" | "mongodb";

export interface ConnectionMeta {
  id: string;            // uuid
  name: string;          // istifadəçi adı: "clopos prod"
  dialect: Dialect;
  host: string;
  port: number;
  username: string;
  database?: string;
  // parol BURADA YOX — backend keychain-də saxlayır
}

export interface ConnectionInput extends Omit<ConnectionMeta, "id"> {
  password?: string;     // yalnız yaradılanda/redaktədə göndərilir
}

export interface QueryResult {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  rows_affected?: number;
  elapsed_ms: number;
  truncated: boolean;    // limit tətbiq olundumu
}

export interface TableInfo { name: string; kind: "table" | "view"; }
export interface ColumnInfo { name: string; data_type: string; nullable: boolean; key?: "PRI" | "UNI" | "MUL"; }

export interface SchemaSnapshot {
  database: string;
  tables: Array<{ name: string; columns: ColumnInfo[] }>;
}

// AI
export interface Nl2SqlResult {
  sql: string;
  explanation: string;
  warnings: string[];      // məs: "bu sorğu bütün cədvəli skan edir"
  needs_confirmation: boolean; // DDL/DML olanda true
  schema_tables: string[];     // sütunları göndərilən relevant cədvəllər
  schema_total_tables: number; // bütün cədvəl adları
  schema_tokens: number;       // təxmini sxem tokeni
  schema_truncated: boolean;   // büdcəyə görə sütunlar kəsilıb
  raw: string;                 // modelin xam cavabı (debug)
}

export interface AiExplainResult { summary: string; }
export interface AiOptimizeResult { suggestions: string[]; rewritten_sql?: string; }
```

## Komandalar

### Bağlantı
| Komanda | Arqumentlər | Qaytarır |
|---|---|---|
| `list_connections` | — | `ConnectionMeta[]` |
| `save_connection` | `{ input: ConnectionInput }` | `ConnectionMeta` (id ilə) |
| `delete_connection` | `{ id: string }` | `void` |
| `test_connection` | `{ input: ConnectionInput }` | `{ ok: boolean, message: string }` |

### Sorğu
| Komanda | Arqumentlər | Qaytarır |
|---|---|---|
| `run_query` | `{ conn_id, sql, max_rows?: number, database?: string, order_by?: string }` | `QueryResult` |
| `cancel_query` | `{ conn_id }` | `void` |

### Sxem
| Komanda | Arqumentlər | Qaytarır |
|---|---|---|
| `list_databases` | `{ conn_id }` | `string[]` |
| `list_tables` | `{ conn_id, database }` | `TableInfo[]` |
| `list_columns` | `{ conn_id, database, table }` | `ColumnInfo[]` |
| `get_schema` | `{ conn_id, database }` | `SchemaSnapshot` |

### İxrac
| Komanda | Arqumentlər | Qaytarır |
|---|---|---|
| `export_result` | `{ format: "csv"\|"xlsx"\|"json", result: QueryResult, path: string }` | `void` |

### AI
| Komanda | Arqumentlər | Qaytarır |
|---|---|---|
| `ai_nl2sql` | `{ conn_id, question, include_schema?: boolean, database?: string }` | `Nl2SqlResult` |
| `ai_explain` | `{ sql }` | `AiExplainResult` |
| `ai_optimize` | `{ conn_id, sql, explain_plan?: string }` | `AiOptimizeResult` |
| `ai_fix_error` | `{ sql, error_message }` | `Nl2SqlResult` |
| `ai_set_key` | `{ api_key }` | `void` (keychain-ə yazır) |
| `ai_has_key` | — | `boolean` |

## Rust tərəf nümunəsi (`commands/query.rs`)

```rust
#[tauri::command]
pub async fn run_query(
    state: tauri::State<'_, AppState>,
    conn_id: String,
    sql: String,
    max_rows: Option<i64>,
) -> Result<QueryResult, AppError> {
    let driver = state.pool.get(&conn_id).await?;      // bağlantı hovuzundan
    let limit = max_rows.unwrap_or(1000);
    driver.query(&sql, limit).await                     // trait Driver
}
```

## Frontend örtüyü nümunəsi (`src/ipc.ts`)

```ts
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult, Nl2SqlResult } from "./types";

export const runQuery = (conn_id: string, sql: string, max_rows = 1000) =>
  invoke<QueryResult>("run_query", { conn_id, sql, max_rows });

export const aiNl2Sql = (conn_id: string, question: string, include_schema = true) =>
  invoke<Nl2SqlResult>("ai_nl2sql", { conn_id, question, include_schema });
```
