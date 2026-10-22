use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{Number, Value};
use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::types::chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use sqlx::{Column, Connection, Executor, Row, Statement, TypeInfo, ValueRef};

use crate::core::drivers::{
    BoxFuture, ColumnInfo, ConnectionInput, Dialect, Driver, QueryResult, SchemaSnapshot,
    SchemaTable, TableInfo, TableKind,
};
use crate::error::{AppError, AppResult};

const DEFAULT_MAX_ROWS: i64 = 1000;
const MAX_ROWS: i64 = 100_000;

fn trim_statement(sql: &str) -> &str {
    sql.trim().trim_end_matches(';').trim_end()
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

fn row_columns(row: &MySqlRow) -> Vec<String> {
    row.columns()
        .iter()
        .map(|column| column.name().to_string())
        .collect()
}

fn build_result(
    columns: Vec<String>,
    fetched: Vec<MySqlRow>,
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

pub struct MySqlDriver {
    pool: MySqlPool,
    database: String,
    options: MySqlConnectOptions,
}

impl MySqlDriver {
    pub async fn connect(input: &ConnectionInput, password: Option<&str>) -> AppResult<Self> {
        let mut options = MySqlConnectOptions::new()
            .host(&input.host)
            .port(input.port)
            .username(&input.username)
            .password(password.unwrap_or_default());

        let database = input.database.clone().unwrap_or_default();
        if !database.is_empty() {
            options = options.database(&database);
        }

        let pool = MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            // Remote MySQL (PlanetScale, managed hosts) drops idle connections,
            // so validate on acquire and recycle idle/old handles to avoid
            // queries failing against a dead socket.
            .test_before_acquire(true)
            .idle_timeout(Duration::from_secs(60))
            .max_lifetime(Duration::from_secs(30 * 60))
            .min_connections(0)
            .connect_with(options.clone())
            .await
            .map_err(db_error)?;

        Ok(Self {
            pool,
            database,
            options,
        })
    }

    async fn tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let table_type = cell_to_text(&row, 1);
                TableInfo {
                    name: cell_to_text(&row, 0),
                    kind: if table_type.to_ascii_uppercase().contains("VIEW") {
                        TableKind::View
                    } else {
                        TableKind::Table
                    },
                }
            })
            .collect())
    }

    async fn columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let rows = sqlx::query(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let key = cell_to_text(&row, 3);
                ColumnInfo {
                    name: cell_to_text(&row, 0),
                    data_type: cell_to_text(&row, 1),
                    nullable: cell_to_text(&row, 2).eq_ignore_ascii_case("YES"),
                    key: if key.is_empty() { None } else { Some(key) },
                }
            })
            .collect())
    }
}

async fn execute_batch(
    conn: &mut MySqlConnection,
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
    conn: &mut MySqlConnection,
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
        "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN"
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
    let mut fetched: Vec<MySqlRow> = Vec::new();
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

impl Driver for MySqlDriver {
    fn dialect(&self) -> Dialect {
        Dialect::Mysql
    }

    fn dialect_name(&self) -> &'static str {
        Dialect::Mysql.as_str()
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
        database: Option<String>,
    ) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let requested = database.filter(|value| !value.trim().is_empty());

            if requested.is_none() || requested.as_deref() == Some(self.database.as_str()) {
                let mut conn = self.pool.acquire().await.map_err(db_error)?;
                execute_batch(&mut conn, statements, max_rows).await
            } else {
                let options = self
                    .options
                    .clone()
                    .database(requested.as_deref().unwrap_or_default());
                let mut conn = MySqlConnection::connect_with(&options)
                    .await
                    .map_err(db_error)?;
                execute_batch(&mut conn, statements, max_rows).await
            }
        })
    }

    fn get_schema<'a>(
        &'a self,
        database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<SchemaSnapshot>> {
        Box::pin(async move {
            let database = database.unwrap_or(&self.database).to_string();
            if database.is_empty() {
                return Err(AppError::Config("sxem üçün baza seçilməyib".to_string()));
            }

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
            let rows = sqlx::query("SHOW DATABASES")
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;

            Ok(rows.iter().map(|row| cell_to_text(row, 0)).collect())
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

fn bytes_value(bytes: Vec<u8>) -> Value {
    match String::from_utf8(bytes) {
        Ok(text) => Value::String(text),
        Err(error) => Value::String(format!("0x{}", hex(&error.into_bytes()))),
    }
}

fn decode_bytes(row: &MySqlRow, index: usize) -> Option<Value> {
    match row.try_get_unchecked::<Option<Vec<u8>>, _>(index) {
        Ok(Some(bytes)) => Some(bytes_value(bytes)),
        Ok(None) => Some(Value::Null),
        Err(_) => None,
    }
}

fn cell_to_text(row: &MySqlRow, index: usize) -> String {
    match cell_to_json(row, index) {
        Value::String(value) => value,
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn cell_to_json(row: &MySqlRow, index: usize) -> Value {
    let Some(column) = row.columns().get(index) else {
        return Value::Null;
    };

    if row
        .try_get_raw(index)
        .map(|value| value.is_null())
        .unwrap_or(true)
    {
        return Value::Null;
    }

    let type_name = column.type_info().name().to_ascii_uppercase();

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

    macro_rules! chrono_value {
        ($ty:ty, $fmt:expr) => {
            match row.try_get_unchecked::<Option<$ty>, _>(index) {
                Ok(Some(value)) => return Value::String(value.format($fmt).to_string()),
                Ok(None) => return Value::Null,
                Err(_) => {}
            }
        };
    }

    match type_name.as_str() {
        "BOOLEAN" | "BOOL" => match row.try_get_unchecked::<Option<bool>, _>(index) {
            Ok(Some(value)) => return Value::Bool(value),
            Ok(None) => return Value::Null,
            Err(_) => {}
        },
        "TINYINT" => int_value!(i8, |v| Value::from(v as i64)),
        "TINYINT UNSIGNED" => int_value!(u8, |v| Value::from(v as u64)),
        "SMALLINT" => int_value!(i16, |v| Value::from(v as i64)),
        "SMALLINT UNSIGNED" => int_value!(u16, |v| Value::from(v as u64)),
        "MEDIUMINT" | "INT" | "INTEGER" => int_value!(i32, |v| Value::from(v as i64)),
        "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "INTEGER UNSIGNED" => {
            int_value!(u32, |v| Value::from(v as u64))
        }
        "BIGINT" => int_value!(i64, Value::from),
        "BIGINT UNSIGNED" => int_value!(u64, Value::from),
        "FLOAT" | "DOUBLE" | "FLOAT UNSIGNED" | "DOUBLE UNSIGNED" => {
            match row.try_get_unchecked::<Option<f64>, _>(index) {
                Ok(Some(value)) => return number(value),
                Ok(None) => return Value::Null,
                Err(_) => {}
            }
        }
        "DECIMAL" | "NEWDECIMAL" | "NUMERIC" => string_value!(),
        "BIT" => int_value!(u64, Value::from),
        "DATE" => chrono_value!(NaiveDate, "%Y-%m-%d"),
        "DATETIME" | "TIMESTAMP" => chrono_value!(NaiveDateTime, "%Y-%m-%dT%H:%M:%S%.f"),
        "TIME" => chrono_value!(NaiveTime, "%H:%M:%S%.f"),
        "YEAR" => int_value!(u16, |v: u16| Value::String(v.to_string())),
        "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET"
        | "JSON" => string_value!(),
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "GEOMETRY" => {
            if let Some(value) = decode_bytes(row, index) {
                return value;
            }
        }
        "NULL" => return Value::Null,
        _ => {}
    }

    if let Some(value) = decode_bytes(row, index) {
        return value;
    }

    Value::Null
}
