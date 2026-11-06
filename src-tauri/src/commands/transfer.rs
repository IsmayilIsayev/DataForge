//! Data transfer: copy tables from one connection/database to another.
//!
//! Each table is read with the export pager (`read_table`) and written through
//! the import transaction stream, one transaction per table, so a failing table
//! leaves the target as it was and the next table still runs.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::commands::edit::{quote_ident, table_ref};
use crate::commands::export::read_table;
use crate::core::backup::{insert_batch_sql, DumpColumn};
use crate::core::drivers::{ColumnInfo, Dialect, Driver, TableKind, TxInput};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const PAGE_SIZE: i64 = 2_000;
const INSERT_ROWS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IfExists {
    /// Add the rows to what is already there.
    Append,
    /// Delete the target's rows first (same transaction), then copy.
    Replace,
    /// Leave an existing target table untouched.
    Skip,
}

#[derive(Debug, Serialize)]
pub struct TableTransfer {
    pub table: String,
    pub rows: u64,
    pub created: bool,
    pub skipped: bool,
    /// Source columns the existing target table does not have.
    pub dropped_columns: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TransferSummary {
    pub tables: Vec<TableTransfer>,
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
struct TransferProgress {
    id: String,
    table: String,
    table_index: usize,
    tables_total: usize,
    rows: u64,
    done: bool,
}

fn writable(dialect: Dialect) -> bool {
    matches!(
        dialect,
        Dialect::Mysql | Dialect::Postgres | Dialect::Sqlite | Dialect::Mssql
    )
}

fn base_type(data_type: &str) -> String {
    let lower = data_type.trim().to_ascii_lowercase();
    let base = lower.split('(').next().unwrap_or("").trim();
    // ClickHouse wraps types: Nullable(Int32), LowCardinality(String).
    if base == "nullable" || base == "lowcardinality" {
        let inner = lower
            .split_once('(')
            .map(|(_, rest)| rest.trim_end_matches(')'))
            .unwrap_or("");
        return base_type(inner);
    }
    base.trim_end_matches(" unsigned").to_string()
}

/// Precision suffix such as "(10,2)", when the source type carries one.
fn precision(data_type: &str) -> Option<&str> {
    let start = data_type.find('(')?;
    let end = data_type[start..].find(')')? + start;
    Some(&data_type[start..=end])
}

/// Column type for `target`. Same-dialect MySQL and SQLite types are complete
/// (COLUMN_TYPE, declared type) and copied as is; everything else is mapped by
/// family, because PostgreSQL and SQL Server report types without lengths.
pub(crate) fn transfer_type(source: Dialect, target: Dialect, data_type: &str, key: bool) -> String {
    if source == target && matches!(target, Dialect::Mysql | Dialect::Sqlite) && !data_type.trim().is_empty() {
        return data_type.trim().to_string();
    }

    let lower = data_type.to_ascii_lowercase();
    let base = base_type(data_type);
    let pick = |pg: &str, my: &str, ms: &str, lite: &str| -> String {
        match target {
            Dialect::Postgres => pg,
            Dialect::Mysql => my,
            Dialect::Mssql => ms,
            _ => lite,
        }
        .to_string()
    };

    let tinyint_bool = base == "tinyint" && lower.contains("(1)");
    if matches!(base.as_str(), "bool" | "boolean" | "bit") || tinyint_bool {
        return pick("BOOLEAN", "TINYINT(1)", "BIT", "INTEGER");
    }
    if matches!(base.as_str(), "bigint" | "int8" | "bigserial" | "int64" | "uint32" | "uint64") {
        return pick("BIGINT", "BIGINT", "BIGINT", "INTEGER");
    }
    if matches!(
        base.as_str(),
        "int" | "integer" | "int4" | "int2" | "smallint" | "tinyint" | "mediumint" | "serial"
            | "smallserial" | "int16" | "int32" | "uint8" | "uint16" | "year"
    ) {
        return pick("INTEGER", "INT", "INT", "INTEGER");
    }
    if matches!(base.as_str(), "decimal" | "numeric" | "money" | "smallmoney" | "decimal32" | "decimal64" | "decimal128") {
        let size = precision(data_type).unwrap_or("(38,10)");
        return pick("NUMERIC", &format!("DECIMAL{size}"), &format!("DECIMAL{size}"), "NUMERIC");
    }
    if matches!(base.as_str(), "float" | "double" | "double precision" | "real" | "float4" | "float8" | "float32" | "float64") {
        return pick("DOUBLE PRECISION", "DOUBLE", "FLOAT", "REAL");
    }
    if base == "date" || base == "date32" {
        return pick("DATE", "DATE", "DATE", "TEXT");
    }
    if base.starts_with("timestamp") || base.starts_with("datetime") || base == "smalldatetime" {
        let zoned = lower.contains("with time zone") || base == "timestamptz" || base == "datetimeoffset";
        return if zoned {
            pick("TIMESTAMPTZ", "DATETIME(6)", "DATETIMEOFFSET", "TEXT")
        } else {
            pick("TIMESTAMP", "DATETIME(6)", "DATETIME2", "TEXT")
        };
    }
    if base.starts_with("time") {
        return pick("TIME", "TIME(6)", "TIME", "TEXT");
    }
    if base == "json" || base == "jsonb" {
        return pick("JSONB", "JSON", "NVARCHAR(MAX)", "TEXT");
    }
    if base == "uuid" || base == "uniqueidentifier" {
        return pick("UUID", "CHAR(36)", "UNIQUEIDENTIFIER", "TEXT");
    }
    if lower.contains("blob") || lower.contains("binary") || base == "bytea" || base == "image" {
        return pick("BYTEA", "LONGBLOB", "VARBINARY(MAX)", "BLOB");
    }
    // Text: key columns need a bounded type to be indexable on MySQL / SQL Server.
    if key {
        pick("TEXT", "VARCHAR(255)", "NVARCHAR(450)", "TEXT")
    } else {
        pick("TEXT", "LONGTEXT", "NVARCHAR(MAX)", "TEXT")
    }
}

pub(crate) fn create_table_sql(
    source: Dialect,
    target: Dialect,
    database: &str,
    table: &str,
    columns: &[ColumnInfo],
) -> String {
    let mut parts: Vec<String> = columns
        .iter()
        .map(|column| {
            let key = column.key.as_deref() == Some("PRI");
            let null = if column.nullable && !key { "" } else { " NOT NULL" };
            format!(
                "{} {}{null}",
                quote_ident(target, &column.name),
                transfer_type(source, target, &column.data_type, key)
            )
        })
        .collect();
    let pk: Vec<String> = columns
        .iter()
        .filter(|column| column.key.as_deref() == Some("PRI"))
        .map(|column| quote_ident(target, &column.name))
        .collect();
    if !pk.is_empty() {
        parts.push(format!("PRIMARY KEY ({})", pk.join(", ")));
    }
    format!(
        "CREATE TABLE {} (\n  {}\n)",
        table_ref(target, database, table),
        parts.join(",\n  ")
    )
}

fn sql_text(value: &str) -> String {
    value.replace('\'', "''")
}

fn is_integer(data_type: &str) -> bool {
    matches!(
        base_type(data_type).as_str(),
        "int" | "integer" | "int2" | "int4" | "int8" | "smallint" | "bigint" | "serial" | "bigserial"
            | "smallserial"
    )
}

/// After copying into an existing PostgreSQL table, move each serial/identity
/// sequence past the copied ids so the next INSERT does not collide.
/// Columns without a sequence make `setval(NULL, ..)` return NULL, a no-op.
pub(crate) fn sequence_fixes(database: &str, table: &str, columns: &[DumpColumn]) -> Vec<String> {
    let target = table_ref(Dialect::Postgres, database, table);
    columns
        .iter()
        .filter(|column| is_integer(&column.data_type))
        .map(|column| {
            format!(
                "SELECT setval(pg_get_serial_sequence('{}', '{}'), m) FROM (SELECT MAX({}) AS m FROM {target}) s WHERE m IS NOT NULL",
                sql_text(&target),
                sql_text(&column.name),
                quote_ident(Dialect::Postgres, &column.name),
            )
        })
        .collect()
}

/// SQL Server rejects explicit values for an IDENTITY column unless
/// IDENTITY_INSERT is on. The setting only lasts for one batch here, so it
/// wraps each INSERT, and only when a written column is the identity column.
pub(crate) fn with_identity_insert(database: &str, table: &str, columns: &[DumpColumn], insert: &str) -> String {
    let target = table_ref(Dialect::Mssql, database, table);
    let names: Vec<String> = columns
        .iter()
        .map(|column| format!("N'{}'", sql_text(&column.name)))
        .collect();
    format!(
        "DECLARE @df_identity bit = CASE WHEN EXISTS (SELECT 1 FROM sys.identity_columns WHERE object_id = OBJECT_ID(N'{}') AND name IN ({})) THEN 1 ELSE 0 END;\n\
         IF @df_identity = 1 SET IDENTITY_INSERT {target} ON;\n\
         {};\n\
         IF @df_identity = 1 SET IDENTITY_INSERT {target} OFF;",
        sql_text(&target),
        names.join(", "),
        insert.trim_end().trim_end_matches(';'),
    )
}

fn is_cancelled(app: &tauri::AppHandle, id: &str) -> bool {
    app.state::<AppState>()
        .cancelled
        .try_read()
        .map(|guard| guard.contains(id))
        .unwrap_or(false)
}

struct Plan {
    table: String,
    target_table: String,
    /// Source column names to read, in target order.
    read: Vec<String>,
    write: Vec<DumpColumn>,
    pk: Vec<String>,
    pk_types: Vec<String>,
    create: Option<String>,
    clear: bool,
    dropped: Vec<String>,
}

impl Plan {
    /// Statements run after the last row, in the same transaction.
    fn finish(&self, target: Dialect, database: &str) -> Vec<String> {
        if self.create.is_none() && target == Dialect::Postgres {
            sequence_fixes(database, &self.target_table, &self.write)
        } else {
            Vec::new()
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn copy_table(
    app: &tauri::AppHandle,
    id: &str,
    source: Arc<dyn Driver>,
    target: Arc<dyn Driver>,
    source_db: &str,
    target_db: &str,
    plan: Plan,
    progress: (usize, usize),
) -> AppResult<(u64, bool)> {
    let target_dialect = target.dialect();
    let (tx, rx) = mpsc::channel::<TxInput>(8);

    let reader = {
        let app = app.clone();
        let id = id.to_string();
        let source_db = source_db.to_string();
        let target_db = target_db.to_string();
        let table = plan.table.clone();
        let target_table = plan.target_table.clone();
        let read = plan.read.clone();
        let write = plan.write.clone();
        let pk = plan.pk.clone();
        let pk_types = plan.pk_types.clone();
        let finish = plan.finish(target_dialect, &target_db);
        let identity = plan.create.is_none() && target_dialect == Dialect::Mssql;
        let mut setup = Vec::new();
        if let Some(create) = &plan.create {
            setup.push(create.clone());
        }
        if plan.clear {
            setup.push(format!(
                "DELETE FROM {}",
                table_ref(target_dialect, &target_db, &target_table)
            ));
        }
        let tx = tx;
        tokio::spawn(async move {
            // The writer runs on this task's peer; blocking here only parks this
            // reader until the transaction has room for the next batch.
            let send = |item: TxInput| tokio::task::block_in_place(|| tx.blocking_send(item).is_ok());
            for sql in setup {
                if !send(TxInput::Sql { sql, row: None }) {
                    return Ok((0, true));
                }
            }
            let mut rows = 0u64;
            let mut on_batch = |batch: Vec<Vec<Value>>| -> AppResult<bool> {
                if is_cancelled(&app, &id) {
                    send(TxInput::Rollback);
                    return Ok(false);
                }
                for chunk in batch.chunks(INSERT_ROWS) {
                    let mut sql = insert_batch_sql(target_dialect, &target_db, &target_table, &write, chunk);
                    if identity {
                        sql = with_identity_insert(&target_db, &target_table, &write, &sql);
                    }
                    if !send(TxInput::Sql { sql, row: None }) {
                        return Ok(false);
                    }
                }
                rows += batch.len() as u64;
                let _ = app.emit(
                    "transfer:progress",
                    TransferProgress {
                        id: id.clone(),
                        table: table.clone(),
                        table_index: progress.0,
                        tables_total: progress.1,
                        rows,
                        done: false,
                    },
                );
                Ok(true)
            };
            let result = read_table(
                source.as_ref(),
                source.dialect(),
                &source_db,
                &table,
                &read,
                &pk,
                &pk_types,
                PAGE_SIZE,
                &mut on_batch,
            )
            .await;
            if result.is_err() {
                send(TxInput::Rollback);
            }
            if matches!(result, Ok(true)) {
                for sql in finish {
                    if !send(TxInput::Sql { sql, row: None }) {
                        break;
                    }
                }
            }
            result.map(|completed| (rows, !completed))
        })
    };

    let written = target.stream_transaction(rx, Some(target_db.to_string())).await;
    let read = reader
        .await
        .map_err(|error| AppError::Internal(format!("transfer: {error}")))?;
    let outcome = written.map_err(|failure| failure.error)?;
    let (rows, stopped) = read?;
    Ok((rows, stopped || outcome.cancelled))
}

async fn plan_table(
    source: &dyn Driver,
    target: &dyn Driver,
    source_db: &str,
    target_db: &str,
    table: &str,
    existing: &[String],
    if_exists: IfExists,
) -> AppResult<Option<Plan>> {
    let columns = source.list_columns(source_db, table).await?;
    if columns.is_empty() {
        return Err(AppError::Config("the source table has no columns".to_string()));
    }
    let pk_info: Vec<&ColumnInfo> = columns
        .iter()
        .filter(|column| column.key.as_deref() == Some("PRI"))
        .collect();
    let pk: Vec<String> = pk_info.iter().map(|column| column.name.clone()).collect();
    let pk_types: Vec<String> = pk_info.iter().map(|column| column.data_type.clone()).collect();

    let found = existing
        .iter()
        .find(|name| name.as_str() == table)
        .or_else(|| existing.iter().find(|name| name.eq_ignore_ascii_case(table)));
    let Some(target_table) = found.cloned() else {
        return Ok(Some(Plan {
            table: table.to_string(),
            target_table: table.to_string(),
            read: columns.iter().map(|column| column.name.clone()).collect(),
            write: columns
                .iter()
                .map(|column| DumpColumn {
                    name: column.name.clone(),
                    data_type: transfer_type(source.dialect(), target.dialect(), &column.data_type, false),
                })
                .collect(),
            pk,
            pk_types,
            create: Some(create_table_sql(source.dialect(), target.dialect(), target_db, table, &columns)),
            clear: false,
            dropped: Vec::new(),
        }));
    };
    if if_exists == IfExists::Skip {
        return Ok(None);
    }

    let target_columns = target.list_columns(target_db, &target_table).await?;
    let mut read = Vec::new();
    let mut write = Vec::new();
    let mut dropped = Vec::new();
    for column in &columns {
        match target_columns
            .iter()
            .find(|item| item.name.eq_ignore_ascii_case(&column.name))
        {
            Some(item) => {
                read.push(column.name.clone());
                write.push(DumpColumn {
                    name: item.name.clone(),
                    data_type: item.data_type.clone(),
                });
            }
            None => dropped.push(column.name.clone()),
        }
    }
    if read.is_empty() {
        return Err(AppError::Config(
            "the target table has none of the source columns".to_string(),
        ));
    }
    Ok(Some(Plan {
        table: table.to_string(),
        target_table,
        read,
        write,
        pk,
        pk_types,
        create: None,
        clear: if_exists == IfExists::Replace,
        dropped,
    }))
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_tables(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    source_conn: String,
    source_db: String,
    target_conn: String,
    target_db: String,
    tables: Vec<String>,
    if_exists: IfExists,
    transfer_id: String,
) -> AppResult<TransferSummary> {
    let target_meta = state
        .connections
        .read()
        .await
        .find(&target_conn)
        .ok_or(AppError::NoConnection)?;
    if target_meta.read_only.unwrap_or(false) {
        return Err(AppError::Config(format!(
            "“{}” is read-only — transfer is blocked.",
            target_meta.name
        )));
    }
    if source_conn == target_conn && source_db == target_db {
        return Err(AppError::Config(
            "choose a different target database".to_string(),
        ));
    }

    let source = state.pool.get(&source_conn).await?;
    let target = state.pool.get(&target_conn).await?;
    if !writable(target.dialect()) {
        return Err(AppError::Config(format!(
            "Transfer into {} is not supported yet",
            target.dialect_name()
        )));
    }
    if matches!(source.dialect(), Dialect::Mongodb | Dialect::Redis) {
        return Err(AppError::Config(format!(
            "Transfer from {} is not supported yet",
            source.dialect_name()
        )));
    }

    let existing: Vec<String> = target
        .list_tables(&target_db)
        .await?
        .into_iter()
        .filter(|table| table.kind == TableKind::Table)
        .map(|table| table.name)
        .collect();

    state.cancelled.write().await.remove(&transfer_id);
    let total = tables.len();
    let mut results = Vec::with_capacity(total);
    let mut cancelled = false;

    for (index, table) in tables.iter().enumerate() {
        if cancelled || is_cancelled(&app, &transfer_id) {
            cancelled = true;
            break;
        }
        let mut result = TableTransfer {
            table: table.clone(),
            rows: 0,
            created: false,
            skipped: false,
            dropped_columns: Vec::new(),
            error: None,
        };

        let plan = plan_table(
            source.as_ref(),
            target.as_ref(),
            &source_db,
            &target_db,
            table,
            &existing,
            if_exists,
        )
        .await;

        match plan {
            Ok(None) => result.skipped = true,
            Err(error) => result.error = Some(error.to_string()),
            Ok(Some(plan)) => {
                result.created = plan.create.is_some();
                result.dropped_columns = plan.dropped.clone();
                match copy_table(
                    &app,
                    &transfer_id,
                    source.clone(),
                    target.clone(),
                    &source_db,
                    &target_db,
                    plan,
                    (index, total),
                )
                .await
                {
                    Ok((rows, stopped)) => {
                        result.rows = rows;
                        if stopped {
                            cancelled = true;
                            result.rows = 0;
                            result.created = false;
                            result.error = Some("cancelled — rolled back".to_string());
                        }
                    }
                    Err(error) => {
                        result.created = false;
                        result.error = Some(error.to_string());
                    }
                }
            }
        }
        results.push(result);
    }

    state.cancelled.write().await.remove(&transfer_id);
    let _ = app.emit(
        "transfer:progress",
        TransferProgress {
            id: transfer_id,
            table: String::new(),
            table_index: total,
            tables_total: total,
            rows: 0,
            done: true,
        },
    );
    Ok(TransferSummary {
        tables: results,
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::{create_table_sql, sequence_fixes, transfer_type, with_identity_insert};
    use crate::core::backup::DumpColumn;
    use crate::core::drivers::{ColumnInfo, Dialect};

    fn dump(name: &str, data_type: &str) -> DumpColumn {
        DumpColumn {
            name: name.to_string(),
            data_type: data_type.to_string(),
        }
    }

    #[test]
    fn moves_postgres_sequences_only_for_integer_columns() {
        let fixes = sequence_fixes("", "Orders", &[dump("id", "integer"), dump("note", "text"), dump("o'k", "bigint")]);
        assert_eq!(fixes.len(), 2);
        assert_eq!(
            fixes[0],
            "SELECT setval(pg_get_serial_sequence('\"Orders\"', 'id'), m) FROM (SELECT MAX(\"id\") AS m FROM \"Orders\") s WHERE m IS NOT NULL"
        );
        assert!(fixes[1].contains("'o''k'"));
    }

    #[test]
    fn wraps_sql_server_inserts_in_identity_insert() {
        let sql = with_identity_insert("shop", "users", &[dump("id", "int")], "INSERT INTO x (id) VALUES (1);");
        assert!(sql.contains("OBJECT_ID(N'[shop].[dbo].[users]') AND name IN (N'id')"));
        assert!(sql.contains("SET IDENTITY_INSERT [shop].[dbo].[users] ON;"));
        assert!(sql.contains("INSERT INTO x (id) VALUES (1);\n"));
        assert!(!sql.contains(";;"));
        assert!(sql.ends_with("SET IDENTITY_INSERT [shop].[dbo].[users] OFF;"));
    }

    fn column(name: &str, data_type: &str, nullable: bool, key: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable,
            key: key.then(|| "PRI".to_string()),
        }
    }

    #[test]
    fn maps_types_across_dialects() {
        let pg = Dialect::Postgres;
        let my = Dialect::Mysql;
        assert_eq!(transfer_type(pg, my, "character varying", false), "LONGTEXT");
        assert_eq!(transfer_type(pg, my, "character varying", true), "VARCHAR(255)");
        assert_eq!(transfer_type(pg, my, "timestamp with time zone", false), "DATETIME(6)");
        assert_eq!(transfer_type(my, pg, "tinyint(1)", false), "BOOLEAN");
        assert_eq!(transfer_type(my, pg, "int unsigned", false), "INTEGER");
        assert_eq!(transfer_type(my, pg, "decimal(10,2)", false), "NUMERIC");
        assert_eq!(transfer_type(pg, my, "numeric", false), "DECIMAL(38,10)");
        assert_eq!(transfer_type(my, Dialect::Mssql, "decimal(10,2)", false), "DECIMAL(10,2)");
        assert_eq!(transfer_type(pg, Dialect::Mssql, "uuid", false), "UNIQUEIDENTIFIER");
        assert_eq!(transfer_type(Dialect::Clickhouse, pg, "Nullable(Int64)", false), "BIGINT");
        assert_eq!(transfer_type(Dialect::Mssql, pg, "datetime2", false), "TIMESTAMP");
        assert_eq!(transfer_type(pg, Dialect::Sqlite, "bytea", false), "BLOB");
        // Same dialect keeps MySQL's full column type.
        assert_eq!(transfer_type(my, my, "varchar(64)", false), "varchar(64)");
        // "interval" contains "int" but is not an integer.
        assert_eq!(transfer_type(pg, my, "interval", false), "LONGTEXT");
    }

    #[test]
    fn creates_table_with_primary_key() {
        let sql = create_table_sql(
            Dialect::Postgres,
            Dialect::Mysql,
            "shop",
            "users",
            &[
                column("id", "integer", false, true),
                column("email", "text", true, false),
            ],
        );
        assert_eq!(
            sql,
            "CREATE TABLE `shop`.`users` (\n  `id` INT NOT NULL,\n  `email` LONGTEXT,\n  PRIMARY KEY (`id`)\n)"
        );
    }
}
