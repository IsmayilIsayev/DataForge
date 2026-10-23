use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{Number, Value};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteConnection, SqlitePool, SqlitePoolOptions, SqliteRow,
};
use sqlx::{Column, Connection, Executor, Row, Statement, TypeInfo, ValueRef};

use crate::core::drivers::{
    int_json, BoxFuture, ColumnInfo, ConnectionInput, Dialect, Driver, QueryResult,
    SchemaSnapshot, SchemaTable, TableInfo, TableKind, TxError, TxInput, TxRowError,
    TxStreamOutcome,
};
use crate::error::{AppError, AppResult};

const DEFAULT_MAX_ROWS: i64 = 1000;
const MAX_ROWS: i64 = 100_000;

fn trim_statement(sql: &str) -> &str {
    sql.trim().trim_end_matches(';').trim_end()
}

/// A read-only SQLite connection must never create the database file either.
fn read_only_flags(read_only: Option<bool>) -> (bool, bool) {
    let read_only = read_only.unwrap_or(false);
    (read_only, !read_only)
}

fn first_keyword(sql: &str) -> String {
    let mut rest = sql.trim_start();

    loop {
        if rest.starts_with("--") || rest.starts_with('#') {
            rest = rest.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
        } else if rest.starts_with("/*") {
            rest = rest.split_once("*/").map(|(_, tail)| tail).unwrap_or("");
        } else if rest.starts_with('(') {
            rest = &rest[1..];
        } else {
            break;
        }
        rest = rest.trim_start();
    }

    rest.split(|c: char| c.is_whitespace() || c == '(' || c == ';')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn row_columns(row: &SqliteRow) -> Vec<String> {
    row.columns()
        .iter()
        .map(|column| column.name().to_string())
        .collect()
}

fn build_result(
    columns: Vec<String>,
    fetched: Vec<SqliteRow>,
    limit: i64,
    truncated: bool,
    started: Instant,
    rows_affected: Option<u64>,
) -> QueryResult {
    let rows = fetched
        .into_iter()
        .take(limit as usize)
        .map(|row| {
            (0..columns.len())
                .map(|index| cell_to_json(&row, index))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    QueryResult {
        columns,
        rows,
        rows_affected,
        elapsed_ms: started.elapsed().as_millis() as u64,
        truncated,
    }
}

pub struct SqliteDriver {
    pool: SqlitePool,
}

impl SqliteDriver {
    pub async fn connect(input: &ConnectionInput, _password: Option<&str>) -> AppResult<Self> {
        let path = input.database.clone().unwrap_or_default();
        if path.trim().is_empty() {
            return Err(AppError::Config(
                "SQLite database file is required".to_string(),
            ));
        }

        let (read_only, create_if_missing) = read_only_flags(input.read_only);
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .read_only(read_only)
            .create_if_missing(create_if_missing);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await
            .map_err(db_error)?;

        Ok(Self { pool })
    }

    async fn tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        let schema = quote_identifier(if database.is_empty() {
            "main"
        } else {
            database
        });
        let sql = format!(
            "SELECT name, type FROM {schema}.sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name"
        );

        let rows = sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let name = row.try_get::<String, _>(0).unwrap_or_default();
                let kind = row.try_get::<String, _>(1).unwrap_or_default();
                TableInfo {
                    name,
                    kind: if kind.eq_ignore_ascii_case("view") {
                        TableKind::View
                    } else {
                        TableKind::Table
                    },
                }
            })
            .collect())
    }

    async fn columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let schema = quote_identifier(if database.is_empty() {
            "main"
        } else {
            database
        });
        let sql = format!("PRAGMA {schema}.table_info({})", quote_identifier(table));

        let rows = sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let name = row.try_get::<String, _>(1).unwrap_or_default();
                let data_type = row.try_get::<String, _>(2).unwrap_or_default();
                let notnull = row.try_get::<i64, _>(3).unwrap_or(0);
                let primary = row.try_get::<i64, _>(5).unwrap_or(0);

                ColumnInfo {
                    name,
                    data_type,
                    nullable: notnull == 0 && primary == 0,
                    key: if primary > 0 {
                        Some("PRI".to_string())
                    } else {
                        None
                    },
                }
            })
            .collect())
    }
}

impl Driver for SqliteDriver {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    fn dialect_name(&self) -> &'static str {
        Dialect::Sqlite.as_str()
    }

    fn query<'a>(&'a self, sql: &'a str, max_rows: i64) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let mut conn = self.pool.acquire().await.map_err(db_error)?;
            execute_statement(&mut conn, sql, max_rows).await
        })
    }

    fn run_statements<'a>(
        &'a self,
        statements: &'a [String],
        max_rows: i64,
        _database: Option<String>,
    ) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let mut conn = self.pool.acquire().await.map_err(db_error)?;
            execute_batch(&mut conn, statements, max_rows).await
        })
    }

    fn apply_transaction<'a>(
        &'a self,
        statements: &'a [String],
        _database: Option<String>,
    ) -> BoxFuture<'a, Result<u64, TxError>> {
        Box::pin(async move {
            let mut conn = self
                .pool
                .acquire()
                .await
                .map_err(|error| TxError::new(None, db_error(error)))?;
            run_transaction(&mut conn, statements).await
        })
    }

    fn stream_transaction<'a>(
        &'a self,
        input: tokio::sync::mpsc::Receiver<TxInput>,
        _database: Option<String>,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>> {
        Box::pin(async move {
            let mut conn = self
                .pool
                .acquire()
                .await
                .map_err(|error| TxError::new(None, db_error(error)))?;
            run_stream_transaction(&mut conn, input).await
        })
    }

    fn get_schema<'a>(
        &'a self,
        database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<SchemaSnapshot>> {
        Box::pin(async move {
            let database = database
                .filter(|value| !value.is_empty())
                .unwrap_or("main")
                .to_string();

            let tables = self.tables(&database).await?;
            let mut snapshot = Vec::with_capacity(tables.len());

            for table in tables {
                let columns = self.columns(&database, &table.name).await?;
                snapshot.push(SchemaTable {
                    name: table.name,
                    columns,
                });
            }

            Ok(SchemaSnapshot {
                database,
                tables: snapshot,
            })
        })
    }

    fn list_databases<'a>(&'a self) -> BoxFuture<'a, AppResult<Vec<String>>> {
        Box::pin(async move {
            let rows = sqlx::query("PRAGMA database_list")
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;

            let mut names = Vec::new();
            for row in rows {
                if let Ok(name) = row.try_get::<String, _>(1) {
                    if !name.is_empty() && name != "temp" {
                        names.push(name);
                    }
                }
            }

            if names.is_empty() {
                names.push("main".to_string());
            }

            Ok(names)
        })
    }

    fn list_tables<'a>(&'a self, database: &'a str) -> BoxFuture<'a, AppResult<Vec<TableInfo>>> {
        Box::pin(async move { self.tables(database).await })
    }

    fn list_columns<'a>(
        &'a self,
        database: &'a str,
        table: &'a str,
    ) -> BoxFuture<'a, AppResult<Vec<ColumnInfo>>> {
        Box::pin(async move { self.columns(database, table).await })
    }
}

async fn run_transaction(
    conn: &mut SqliteConnection,
    statements: &[String],
) -> Result<u64, TxError> {
    let mut tx = conn
        .begin()
        .await
        .map_err(|error| TxError::new(None, db_error(error)))?;

    let mut affected = 0u64;
    for (index, statement) in statements.iter().enumerate() {
        let statement = trim_statement(statement);
        if statement.is_empty() {
            continue;
        }
        match sqlx::query(statement).execute(&mut *tx).await {
            Ok(result) => affected += result.rows_affected(),
            Err(error) => {
                let _ = tx.rollback().await;
                return Err(TxError::new(Some(index), db_error(error)));
            }
        }
    }

    tx.commit()
        .await
        .map_err(|error| TxError::new(None, db_error(error)))?;
    Ok(affected)
}

async fn run_stream_transaction(
    conn: &mut SqliteConnection,
    mut input: tokio::sync::mpsc::Receiver<TxInput>,
) -> Result<TxStreamOutcome, TxError> {
    let mut tx = conn
        .begin()
        .await
        .map_err(|error| TxError::new(None, db_error(error)))?;
    let mut outcome = TxStreamOutcome::default();
    let mut savepoints: Vec<String> = Vec::new();

    while let Some(item) = input.recv().await {
        match item {
            TxInput::Savepoint(name) => {
                sqlx::query(&format!("SAVEPOINT {name}"))
                    .execute(&mut *tx)
                    .await
                    .map_err(|error| TxError::new(None, db_error(error)))?;
                savepoints.push(name);
            }
            TxInput::ReleaseSavepoint(name) => {
                sqlx::query(&format!("RELEASE SAVEPOINT {name}"))
                    .execute(&mut *tx)
                    .await
                    .map_err(|error| TxError::new(None, db_error(error)))?;
                savepoints.pop();
            }
            TxInput::Sql { sql, row } => {
                let statement = trim_statement(&sql);
                if statement.is_empty() {
                    continue;
                }
                match sqlx::query(statement).execute(&mut *tx).await {
                    Ok(result) => outcome.rows_affected += result.rows_affected(),
                    Err(error) => {
                        let message = error.to_string();
                        if let Some(name) = savepoints.last().cloned() {
                            let _ = sqlx::query(&format!("ROLLBACK TO SAVEPOINT {name}"))
                                .execute(&mut *tx)
                                .await;
                            if let Some(row) = row {
                                outcome.errors.push(TxRowError {
                                    row,
                                    error: message,
                                });
                            }
                        } else {
                            let _ = tx.rollback().await;
                            return Err(TxError::new(None, db_error(error)));
                        }
                    }
                }
            }
            TxInput::Rollback => {
                let _ = tx.rollback().await;
                outcome.cancelled = true;
                return Ok(outcome);
            }
        }
    }

    tx.commit()
        .await
        .map_err(|error| TxError::new(None, db_error(error)))?;
    Ok(outcome)
}

async fn execute_batch(
    conn: &mut SqliteConnection,
    statements: &[String],
    max_rows: i64,
) -> AppResult<QueryResult> {
    let (last, earlier) = statements
        .split_last()
        .ok_or_else(|| AppError::Config("SQL boşdur".to_string()))?;

    for statement in earlier {
        let statement = trim_statement(statement);
        if statement.is_empty() {
            continue;
        }

        sqlx::query(statement)
            .execute(&mut *conn)
            .await
            .map_err(db_error)?;
    }

    execute_statement(conn, last, max_rows).await
}

async fn execute_statement(
    conn: &mut SqliteConnection,
    sql: &str,
    max_rows: i64,
) -> AppResult<QueryResult> {
    let started = Instant::now();
    let limit = if max_rows <= 0 {
        DEFAULT_MAX_ROWS
    } else {
        max_rows.clamp(1, MAX_ROWS)
    };
    let body = trim_statement(sql);
    let row_returning = matches!(
        first_keyword(body).as_str(),
        "SELECT" | "WITH" | "PRAGMA" | "EXPLAIN" | "VALUES" | "TABLE"
    );

    if !row_returning {
        let result = sqlx::query(body)
            .execute(&mut *conn)
            .await
            .map_err(db_error)?;

        return Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: Some(result.rows_affected()),
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated: false,
        });
    }

    // Column names from a prepared statement (works even with zero rows). The
    // borrow ends here so the fetch stream can reborrow the connection.
    let mut columns: Vec<String> = match (&mut *conn).prepare(body).await {
        Ok(statement) => statement
            .columns()
            .iter()
            .map(|column| column.name().to_string())
            .collect(),
        Err(_) => Vec::new(),
    };

    // Stream rows and stop after limit + 1 — no derived-table wrapping, so JOINs
    // with duplicate column names, CTEs and parenthesised SELECTs all work.
    let mut fetched: Vec<SqliteRow> = Vec::new();
    {
        let mut stream = sqlx::query(body).fetch(&mut *conn);
        while let Some(row) = stream.next().await {
            let row = row.map_err(db_error)?;
            if columns.is_empty() {
                columns = row_columns(&row);
            }
            fetched.push(row);
            if fetched.len() > limit as usize {
                break;
            }
        }
    }

    let truncated = fetched.len() > limit as usize;
    Ok(build_result(columns, fetched, limit, truncated, started, None))
}

fn db_error(error: sqlx::Error) -> AppError {
    AppError::Db(error.to_string())
}

fn number(value: f64) -> Value {
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or_else(|| Value::String(value.to_string()))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn bytes_value(bytes: &[u8]) -> Value {
    match std::str::from_utf8(bytes) {
        Ok(text) => Value::String(text.to_string()),
        Err(_) => Value::String(format!("0x{}", hex(bytes))),
    }
}

fn cell_to_json(row: &SqliteRow, index: usize) -> Value {
    let Some(column) = row.columns().get(index) else {
        return Value::Null;
    };

    let raw = match row.try_get_raw(index) {
        Ok(raw) => raw,
        Err(_) => return Value::Null,
    };

    if raw.is_null() {
        return Value::Null;
    }

    let declared_type = column.type_info().name().to_ascii_uppercase();
    let value_type = raw.type_info().name().to_ascii_uppercase();

    macro_rules! int_value {
        ($ty:ty, $map:expr) => {
            match row.try_get_unchecked::<Option<$ty>, _>(index) {
                Ok(Some(value)) => return $map(value),
                Ok(None) => return Value::Null,
                Err(_) => {}
            }
        };
    }

    macro_rules! string_value {
        () => {
            match row.try_get_unchecked::<Option<String>, _>(index) {
                Ok(Some(value)) => return Value::String(value),
                Ok(None) => return Value::Null,
                Err(_) => {}
            }
        };
    }

    if declared_type.contains("BOOL") && value_type == "INTEGER" {
        int_value!(i64, |v: i64| Value::Bool(v != 0));
    }

    match value_type.as_str() {
        "INTEGER" => int_value!(i64, int_json),
        "REAL" => int_value!(f64, number),
        "TEXT" => string_value!(),
        "BLOB" => {
            if let Ok(value) = row.try_get_unchecked::<Option<Vec<u8>>, _>(index) {
                match value {
                    Some(bytes) => return bytes_value(&bytes),
                    None => return Value::Null,
                }
            }
        }
        _ => {}
    }

    int_value!(i64, Value::from);
    int_value!(f64, number);
    string_value!();

    if let Ok(value) = row.try_get_unchecked::<Option<Vec<u8>>, _>(index) {
        match value {
            Some(bytes) => return bytes_value(&bytes),
            None => return Value::Null,
        }
    }

    Value::Null
}

#[cfg(test)]
mod tests {
    use super::read_only_flags;

    #[test]
    fn read_only_disables_file_creation() {
        assert_eq!(read_only_flags(None), (false, true));
        assert_eq!(read_only_flags(Some(false)), (false, true));
        assert_eq!(read_only_flags(Some(true)), (true, false));
    }
}
