use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{Number, Value};
use sqlx::postgres::{
    PgConnectOptions, PgConnection, PgPool, PgPoolOptions, PgRow, PgSslMode, PgValueFormat,
};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::{Column, Connection, Executor, Row, Statement, TypeInfo, ValueRef};
use uuid::Uuid;

use crate::core::drivers::{
    int_json, BoxFuture, ColumnInfo, ConnectionInput, Dialect, Driver, QueryResult, SchemaSnapshot,
    SchemaTable, SslMode, TableInfo, TableKind, TxError, TxInput, TxRowError, TxStreamOutcome,
};
use crate::error::{AppError, AppResult};

const DEFAULT_MAX_ROWS: i64 = 1000;
const MAX_ROWS: i64 = 100_000;

fn map_ssl_mode(mode: SslMode) -> PgSslMode {
    match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require => PgSslMode::Require,
        SslMode::VerifyCa => PgSslMode::VerifyCa,
        SslMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

fn apply_ssl_options(
    mut options: PgConnectOptions,
    ssl_mode: Option<SslMode>,
    ssl_ca_path: Option<&str>,
) -> PgConnectOptions {
    if let Some(mode) = ssl_mode {
        options = options.ssl_mode(map_ssl_mode(mode));
    }

    if let Some(path) = ssl_ca_path.map(str::trim).filter(|path| !path.is_empty()) {
        options = options.ssl_root_cert(path);
    }

    options
}

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

fn row_columns(row: &PgRow) -> Vec<String> {
    row.columns()
        .iter()
        .map(|column| column.name().to_string())
        .collect()
}

fn build_result(
    columns: Vec<String>,
    fetched: Vec<PgRow>,
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

pub struct PostgresDriver {
    pool: PgPool,
    database: String,
    options: PgConnectOptions,
    read_only: bool,
}

impl PostgresDriver {
    pub async fn connect(input: &ConnectionInput, password: Option<&str>) -> AppResult<Self> {
        let port = if input.port == 0 { 5432 } else { input.port };
        let mut options = PgConnectOptions::new()
            .host(&input.host)
            .port(port)
            .username(&input.username)
            .password(password.unwrap_or_default());

        let database = input
            .database
            .clone()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "postgres".to_string());
        options = options.database(&database);
        options = apply_ssl_options(options, input.ssl_mode, input.ssl_ca_path.as_deref());
        let read_only = input.read_only.unwrap_or(false);

        let mut pool_options = PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            // Serverless Postgres (Neon, Supabase, …) suspends idle connections,
            // so a pooled handle can be dead by the next query. Ping-and-replace
            // on acquire and recycle idle/old connections so queries don't fail
            // silently against a stale socket.
            .test_before_acquire(true)
            .idle_timeout(Duration::from_secs(60))
            .max_lifetime(Duration::from_secs(30 * 60))
            .min_connections(0);

        if read_only {
            pool_options = pool_options.after_connect(|conn, _meta| {
                Box::pin(async move {
                    sqlx::query(
                        "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
                    )
                    .execute(&mut *conn)
                    .await?;
                    Ok(())
                })
            });
        }

        let pool = pool_options
            .connect_with(options.clone())
            .await
            .map_err(db_error)?;

        Ok(Self {
            pool,
            database,
            options,
            read_only,
        })
    }

    async fn connect_to(&self, database: &str) -> AppResult<PgConnection> {
        let mut options = self.options.clone();
        if !database.is_empty() {
            options = options.database(database);
        }

        let mut conn = PgConnection::connect_with(&options)
            .await
            .map_err(db_error)?;
        if self.read_only {
            sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
                .execute(&mut conn)
                .await
                .map_err(db_error)?;
        }
        Ok(conn)
    }

    async fn tables_on(conn: &mut PgConnection) -> AppResult<Vec<TableInfo>> {
        let rows = sqlx::query(
            "SELECT table_name, table_type \
             FROM information_schema.tables \
             WHERE table_schema = 'public' ORDER BY table_name",
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(db_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let name = row.try_get::<String, _>(0).unwrap_or_default();
                let table_type = row.try_get::<String, _>(1).unwrap_or_default();
                TableInfo {
                    name,
                    kind: if table_type.eq_ignore_ascii_case("VIEW") {
                        TableKind::View
                    } else {
                        TableKind::Table
                    },
                }
            })
            .collect())
    }

    async fn columns_on(conn: &mut PgConnection, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let rows = sqlx::query(
            "SELECT c.column_name, \
                    CASE WHEN UPPER(c.data_type) = 'USER-DEFINED' AND c.udt_name = 'citext' \
                         THEN 'citext' ELSE c.data_type END AS data_type, \
                    c.is_nullable, \
                    CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE NULL END AS column_key \
             FROM information_schema.columns c \
             LEFT JOIN ( \
               SELECT kcu.column_name \
               FROM information_schema.table_constraints tc \
               JOIN information_schema.key_column_usage kcu \
                 ON tc.constraint_name = kcu.constraint_name \
                AND tc.table_schema = kcu.table_schema \
                AND tc.table_name = kcu.table_name \
               WHERE tc.constraint_type = 'PRIMARY KEY' \
                 AND tc.table_schema = 'public' \
                 AND tc.table_name = $1 \
             ) pk ON pk.column_name = c.column_name \
             WHERE c.table_schema = 'public' AND c.table_name = $1 \
             ORDER BY c.ordinal_position",
        )
        .bind(table)
        .fetch_all(&mut *conn)
        .await
        .map_err(db_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let name = row.try_get::<String, _>(0).unwrap_or_default();
                let data_type = row.try_get::<String, _>(1).unwrap_or_default();
                let nullable = row
                    .try_get::<String, _>(2)
                    .map(|value| value.eq_ignore_ascii_case("YES"))
                    .unwrap_or(true);
                let key = row.try_get::<Option<String>, _>(3).unwrap_or(None);

                ColumnInfo {
                    name,
                    data_type,
                    nullable,
                    key,
                }
            })
            .collect())
    }
}

impl Driver for PostgresDriver {
    fn dialect(&self) -> Dialect {
        Dialect::Postgres
    }

    fn dialect_name(&self) -> &'static str {
        Dialect::Postgres.as_str()
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
                let mut conn = self
                    .connect_to(requested.as_deref().unwrap_or_default())
                    .await?;
                execute_batch(&mut conn, statements, max_rows).await
            }
        })
    }

    fn query_with_timeout<'a>(
        &'a self,
        sql: &'a str,
        max_rows: i64,
        database: Option<String>,
        timeout_ms: Option<u64>,
    ) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let Some(timeout_ms) = timeout_ms else {
                let statements = [sql.to_string()];
                return self.run_statements(&statements, max_rows, database).await;
            };

            let requested = database.filter(|value| !value.trim().is_empty());
            // A pooled connection and a one-off connection differ in type; borrow either as PgConnection.
            let mut pooled;
            let mut direct;
            let conn: &mut PgConnection = if requested.is_none()
                || requested.as_deref() == Some(self.database.as_str())
            {
                pooled = self.pool.acquire().await.map_err(db_error)?;
                &mut pooled
            } else {
                direct = self
                    .connect_to(requested.as_deref().unwrap_or_default())
                    .await?;
                &mut direct
            };

            let mut tx = conn.begin().await.map_err(db_error)?;
            sqlx::query(&format!(
                "SET LOCAL statement_timeout = '{timeout_ms}ms'"
            ))
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;

            match execute_statement(&mut *tx, sql, max_rows).await {
                Ok(result) => {
                    tx.commit().await.map_err(db_error)?;
                    Ok(result)
                }
                Err(error) => {
                    let _ = tx.rollback().await;
                    Err(error)
                }
            }
        })
    }

    fn apply_transaction<'a>(
        &'a self,
        statements: &'a [String],
        database: Option<String>,
    ) -> BoxFuture<'a, Result<u64, TxError>> {
        Box::pin(async move {
            let requested = database.filter(|value| !value.trim().is_empty());

            if requested.is_none() || requested.as_deref() == Some(self.database.as_str()) {
                let mut conn = self
                    .pool
                    .acquire()
                    .await
                    .map_err(|error| TxError::new(None, db_error(error)))?;
                run_transaction(&mut conn, statements).await
            } else {
                let mut conn = self
                    .connect_to(requested.as_deref().unwrap_or_default())
                    .await
                    .map_err(|error| TxError::new(None, error))?;
                run_transaction(&mut conn, statements).await
            }
        })
    }

    fn stream_transaction<'a>(
        &'a self,
        input: tokio::sync::mpsc::Receiver<TxInput>,
        database: Option<String>,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>> {
        Box::pin(async move {
            let requested = database.filter(|value| !value.trim().is_empty());

            if requested.is_none() || requested.as_deref() == Some(self.database.as_str()) {
                let mut conn = self
                    .pool
                    .acquire()
                    .await
                    .map_err(|error| TxError::new(None, db_error(error)))?;
                run_stream_transaction(&mut conn, input).await
            } else {
                let mut conn = self
                    .connect_to(requested.as_deref().unwrap_or_default())
                    .await
                    .map_err(|error| TxError::new(None, error))?;
                run_stream_transaction(&mut conn, input).await
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

            let mut conn = self.connect_to(&database).await?;
            let tables = Self::tables_on(&mut conn).await?;
            let mut snapshot = Vec::with_capacity(tables.len());

            for table in tables {
                let columns = Self::columns_on(&mut conn, &table.name).await?;
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
            sqlx::query_scalar::<_, String>(
                "SELECT datname FROM pg_database \
                 WHERE datistemplate = false ORDER BY datname",
            )
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)
        })
    }

    fn list_tables<'a>(&'a self, database: &'a str) -> BoxFuture<'a, AppResult<Vec<TableInfo>>> {
        Box::pin(async move {
            let database = if database.is_empty() {
                if self.database.is_empty() {
                    "postgres"
                } else {
                    self.database.as_str()
                }
            } else {
                database
            };

            let mut conn = self.connect_to(database).await?;
            Self::tables_on(&mut conn).await
        })
    }

    fn list_columns<'a>(
        &'a self,
        database: &'a str,
        table: &'a str,
    ) -> BoxFuture<'a, AppResult<Vec<ColumnInfo>>> {
        Box::pin(async move {
            let database = if database.is_empty() {
                if self.database.is_empty() {
                    "postgres"
                } else {
                    self.database.as_str()
                }
            } else {
                database
            };

            let mut conn = self.connect_to(database).await?;
            Self::columns_on(&mut conn, table).await
        })
    }
}

async fn run_transaction(
    conn: &mut PgConnection,
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
    conn: &mut PgConnection,
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
    conn: &mut PgConnection,
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
    conn: &mut PgConnection,
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
        "SELECT" | "WITH" | "SHOW" | "EXPLAIN" | "VALUES" | "TABLE"
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
    let mut fetched: Vec<PgRow> = Vec::new();
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

fn parse_numeric(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 8 {
        return None;
    }

    let ndigits = i16::from_be_bytes([bytes[0], bytes[1]]);
    let weight = i16::from_be_bytes([bytes[2], bytes[3]]) as i32;
    let sign = u16::from_be_bytes([bytes[4], bytes[5]]);
    let dscale = u16::from_be_bytes([bytes[6], bytes[7]]) as usize;

    if ndigits < 0 {
        return None;
    }

    if sign == 0xC000 {
        return Some("NaN".to_string());
    }

    let ndigits = ndigits as usize;
    if bytes.len() < 8 + ndigits * 2 {
        return None;
    }

    let mut digits = Vec::with_capacity(ndigits);
    for index in 0..ndigits {
        let offset = 8 + index * 2;
        digits.push(i16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as i32);
    }

    let mut integer_groups = Vec::new();
    if weight >= 0 {
        for index in 0..=weight {
            integer_groups.push(if (index as usize) < ndigits {
                digits[index as usize]
            } else {
                0
            });
        }
    }

    let mut integer = if integer_groups.is_empty() {
        "0".to_string()
    } else {
        integer_groups
            .iter()
            .enumerate()
            .map(|(index, digit)| {
                if index == 0 {
                    digit.to_string()
                } else {
                    format!("{digit:04}")
                }
            })
            .collect()
    };

    let mut fraction = String::new();
    if weight < -1 {
        fraction.push_str(&"0000".repeat((-weight - 1) as usize));
    }

    let start = (weight + 1).max(0) as usize;
    for index in start..ndigits {
        fraction.push_str(&format!("{:04}", digits[index]));
    }

    if dscale == 0 {
        fraction.clear();
    } else if fraction.len() >= dscale {
        fraction.truncate(dscale);
    } else {
        fraction.push_str(&"0".repeat(dscale - fraction.len()));
    }

    if dscale > 0 {
        integer.push('.');
        integer.push_str(&fraction);
    }

    if sign == 0x4000 {
        integer.insert(0, '-');
    }

    Some(integer)
}

#[cfg(test)]
mod tests {
    use super::parse_numeric;

    fn numeric(ndigits: i16, weight: i16, sign: u16, dscale: u16, digits: &[i16]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&ndigits.to_be_bytes());
        bytes.extend_from_slice(&weight.to_be_bytes());
        bytes.extend_from_slice(&sign.to_be_bytes());
        bytes.extend_from_slice(&dscale.to_be_bytes());
        for digit in digits {
            bytes.extend_from_slice(&digit.to_be_bytes());
        }
        bytes
    }

    #[test]
    fn parses_positive_numeric() {
        assert_eq!(
            parse_numeric(&numeric(2, 0, 0, 4, &[1234, 5678])).as_deref(),
            Some("1234.5678")
        );
    }

    #[test]
    fn parses_small_numeric() {
        assert_eq!(
            parse_numeric(&numeric(1, -1, 0, 4, &[12])).as_deref(),
            Some("0.0012")
        );
    }

    #[test]
    fn parses_integer_numeric() {
        assert_eq!(
            parse_numeric(&numeric(1, 1, 0, 0, &[1])).as_deref(),
            Some("10000")
        );
    }

    #[test]
    fn parses_negative_numeric() {
        assert_eq!(
            parse_numeric(&numeric(2, 0, 0x4000, 1, &[12, 5000])).as_deref(),
            Some("-12.5")
        );
    }

    #[test]
    fn parses_nan() {
        assert_eq!(
            parse_numeric(&numeric(0, 0, 0xC000, 0, &[])).as_deref(),
            Some("NaN")
        );
    }
}

fn cell_to_json(row: &PgRow, index: usize) -> Value {
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
        "BOOL" => match row.try_get_unchecked::<Option<bool>, _>(index) {
            Ok(Some(value)) => return Value::Bool(value),
            Ok(None) => return Value::Null,
            Err(_) => {}
        },
        "INT2" => int_value!(i16, |v| Value::from(v as i64)),
        "INT4" => int_value!(i32, |v| Value::from(v as i64)),
        "INT8" => int_value!(i64, int_json),
        "OID" => int_value!(i32, |v: i32| Value::from((v as u32) as u64)),
        "FLOAT4" => int_value!(f32, |v| number(v as f64)),
        "FLOAT8" => int_value!(f64, number),
        "NUMERIC" => {
            if let Ok(raw) = row.try_get_raw(index) {
                if matches!(raw.format(), PgValueFormat::Text) {
                    if let Ok(text) = raw.as_str() {
                        return Value::String(text.to_string());
                    }
                } else if let Ok(bytes) = raw.as_bytes() {
                    if let Some(value) = parse_numeric(bytes) {
                        return Value::String(value);
                    }
                }
            }
        }
        "BYTEA" => {
            if let Ok(value) = row.try_get_unchecked::<Option<Vec<u8>>, _>(index) {
                match value {
                    Some(bytes) => return bytes_value(&bytes),
                    None => return Value::Null,
                }
            }
        }
        "JSON" | "JSONB" => {
            if let Ok(value) = row.try_get_unchecked::<Option<serde_json::Value>, _>(index) {
                match value {
                    Some(value) => {
                        return Value::String(
                            serde_json::to_string(&value).unwrap_or_else(|_| value.to_string()),
                        )
                    }
                    None => return Value::Null,
                }
            }
        }
        "DATE" => chrono_value!(NaiveDate, "%Y-%m-%d"),
        "TIME" => chrono_value!(NaiveTime, "%H:%M:%S%.f"),
        "TIMESTAMP" => chrono_value!(NaiveDateTime, "%Y-%m-%dT%H:%M:%S%.f"),
        "TIMESTAMPTZ" => match row.try_get_unchecked::<Option<DateTime<Utc>>, _>(index) {
            Ok(Some(value)) => return Value::String(value.to_rfc3339()),
            Ok(None) => return Value::Null,
            Err(_) => {}
        },
        "UUID" => {
            if let Ok(raw) = row.try_get_raw(index) {
                if matches!(raw.format(), PgValueFormat::Text) {
                    if let Ok(text) = raw.as_str() {
                        return Value::String(text.to_string());
                    }
                } else if let Ok(bytes) = raw.as_bytes() {
                    if let Ok(uuid) = Uuid::from_slice(bytes) {
                        return Value::String(uuid.to_string());
                    }
                }
            }
        }
        "TEXT" | "VARCHAR" | "BPCHAR" | "CHAR" | "NAME" | "CITEXT" => string_value!(),
        _ => {}
    }

    if let Ok(raw) = row.try_get_raw(index) {
        if matches!(raw.format(), PgValueFormat::Text) {
            if let Ok(text) = raw.as_str() {
                return Value::String(text.to_string());
            }
        } else if let Ok(bytes) = raw.as_bytes() {
            return bytes_value(bytes);
        }
    }

    if let Ok(value) = row.try_get_unchecked::<Option<String>, _>(index) {
        match value {
            Some(value) => return Value::String(value),
            None => return Value::Null,
        }
    }

    Value::Null
}

#[cfg(test)]
mod ssl_tests {
    use super::{apply_ssl_options, map_ssl_mode};
    use crate::core::drivers::SslMode;
    use sqlx::postgres::{PgConnectOptions, PgSslMode};

    #[test]
    fn maps_every_ssl_mode_to_the_postgres_option() {
        assert!(matches!(map_ssl_mode(SslMode::Disable), PgSslMode::Disable));
        assert!(matches!(map_ssl_mode(SslMode::Prefer), PgSslMode::Prefer));
        assert!(matches!(map_ssl_mode(SslMode::Require), PgSslMode::Require));
        assert!(matches!(
            map_ssl_mode(SslMode::VerifyCa),
            PgSslMode::VerifyCa
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::VerifyFull),
            PgSslMode::VerifyFull
        ));
    }

    #[test]
    fn leaves_options_unchanged_when_ssl_is_not_configured() {
        let base = PgConnectOptions::new_without_pgpass();
        let expected = format!("{base:?}");
        let options = apply_ssl_options(base, None, None);

        assert_eq!(format!("{options:?}"), expected);
    }

    #[test]
    fn applies_the_requested_mode_and_root_certificate() {
        let options = apply_ssl_options(
            PgConnectOptions::new_without_pgpass(),
            Some(SslMode::VerifyFull),
            Some(" certs/root.pem "),
        );

        assert!(matches!(
            options.get_ssl_mode(),
            PgSslMode::VerifyFull
        ));
        assert!(format!("{options:?}").contains("certs/root.pem"));
    }
}
