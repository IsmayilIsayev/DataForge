use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{Number, Value};
use sqlx::mysql::{
    MySqlConnectOptions, MySqlConnection, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode,
};
use sqlx::types::chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use sqlx::{Column, Connection, Executor, Row, Statement, TypeInfo, ValueRef};

use crate::core::drivers::{
    all_tables_sql, er, group_foreign_keys, int_json, uint_json, BoxFuture, ColumnInfo,
    ConnectionInput, DatabaseTable, Dialect, Driver, ErColumn, ErSchema, ErTable, ForeignKeyRow,
    QueryResult, SchemaSnapshot, SchemaTable, SslMode, TableInfo, TableKind, TxError, TxInput,
    TxRowError, TxStreamOutcome, ER_TABLE_LIMIT,
};
use crate::core::schema_diff::{
    ColumnSchema, ForeignKeySchema, IndexSchema, SchemaData, TableSchema, ViewSchema,
    DIFF_TABLE_LIMIT,
};
use crate::core::restore::truncate_preview;
use crate::error::{AppError, AppResult};

const DEFAULT_MAX_ROWS: i64 = 1000;
const MAX_ROWS: i64 = 100_000;

fn map_ssl_mode(mode: SslMode) -> MySqlSslMode {
    match mode {
        SslMode::Disable => MySqlSslMode::Disabled,
        SslMode::Prefer => MySqlSslMode::Preferred,
        SslMode::Require => MySqlSslMode::Required,
        SslMode::VerifyCa => MySqlSslMode::VerifyCa,
        SslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
    }
}

fn apply_ssl_options(
    mut options: MySqlConnectOptions,
    ssl_mode: Option<SslMode>,
    ssl_ca_path: Option<&str>,
) -> MySqlConnectOptions {
    if let Some(mode) = ssl_mode {
        options = options.ssl_mode(map_ssl_mode(mode));
    }

    if let Some(path) = ssl_ca_path.map(str::trim).filter(|path| !path.is_empty()) {
        options = options.ssl_ca(path);
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
    read_only: bool,
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
        options = apply_ssl_options(options, input.ssl_mode, input.ssl_ca_path.as_deref());
        let read_only = input.read_only.unwrap_or(false);

        let mut pool_options = MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            // Remote MySQL (PlanetScale, managed hosts) drops idle connections,
            // so validate on acquire and recycle idle/old handles to avoid
            // queries failing against a dead socket.
            .test_before_acquire(true)
            .idle_timeout(Duration::from_secs(60))
            .max_lifetime(Duration::from_secs(30 * 60))
            .min_connections(0);

        if read_only {
            pool_options = pool_options.after_connect(|conn, _meta| {
                Box::pin(async move {
                    sqlx::query("SET SESSION TRANSACTION READ ONLY")
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

async fn run_transaction(
    conn: &mut MySqlConnection,
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
    conn: &mut MySqlConnection,
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
                                    statement: None,
                                });
                            }
                        } else {
                            let _ = tx.rollback().await;
                            return Err(TxError::new(
                                row.map(|value| value as usize),
                                db_error(error),
                            )
                            .with_statement(statement));
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


async fn run_stream_restore(
    conn: &mut MySqlConnection,
    mut input: tokio::sync::mpsc::Receiver<TxInput>,
) -> Result<TxStreamOutcome, TxError> {
    let mut outcome = TxStreamOutcome::default();
    let mut savepoints: Vec<String> = Vec::new();

    while let Some(item) = input.recv().await {
        match item {
            TxInput::Savepoint(name) => savepoints.push(name),
            TxInput::ReleaseSavepoint(_) => {
                savepoints.pop();
            }
            TxInput::Sql { sql, row } => {
                let statement = trim_statement(&sql);
                if statement.is_empty() {
                    continue;
                }
                match sqlx::query(statement).execute(&mut *conn).await {
                    Ok(result) => outcome.rows_affected += result.rows_affected(),
                    Err(error) => {
                        let message = error.to_string();
                        if !savepoints.is_empty() {
                            if let Some(row) = row {
                                outcome.errors.push(TxRowError {
                                    row,
                                    error: message,
                                    statement: Some(truncate_preview(statement, 200)),
                                });
                            }
                        } else {
                            return Err(TxError::new(
                                row.map(|value| value as usize),
                                db_error(error),
                            )
                            .with_statement(statement));
                        }
                    }
                }
            }
            TxInput::Rollback => {
                outcome.cancelled = true;
                return Ok(outcome);
            }
        }
    }

    Ok(outcome)
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

async fn stream_rows(
    conn: &mut MySqlConnection,
    sql: &str,
    batch_size: usize,
    on_batch: &mut (dyn FnMut(Vec<Vec<Value>>) -> AppResult<bool> + Send),
) -> AppResult<bool> {
    let body = trim_statement(sql);
    let mut columns: Vec<String> = match (&mut *conn).prepare(body).await {
        Ok(statement) => statement
            .columns()
            .iter()
            .map(|column| column.name().to_string())
            .collect(),
        Err(_) => Vec::new(),
    };

    let batch_size = batch_size.max(1);
    let mut batch: Vec<Vec<Value>> = Vec::with_capacity(batch_size);
    let mut stream = sqlx::query(body).fetch(&mut *conn);
    while let Some(row) = stream.next().await {
        let row = row.map_err(db_error)?;
        if columns.is_empty() {
            columns = row_columns(&row);
        }
        batch.push(
            (0..columns.len())
                .map(|index| cell_to_json(&row, index))
                .collect(),
        );
        if batch.len() >= batch_size {
            if !on_batch(std::mem::take(&mut batch))? {
                return Ok(false);
            }
            batch = Vec::with_capacity(batch_size);
        }
    }

    if !batch.is_empty() && !on_batch(batch)? {
        return Ok(false);
    }
    Ok(true)
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
                if self.read_only {
                    sqlx::query("SET SESSION TRANSACTION READ ONLY")
                        .execute(&mut conn)
                        .await
                        .map_err(db_error)?;
                }
                execute_batch(&mut conn, statements, max_rows).await
            }
        })
    }

    fn stream_table<'a>(
        &'a self,
        sql: &'a str,
        database: Option<String>,
        batch_size: usize,
        on_batch: &'a mut (dyn FnMut(Vec<Vec<Value>>) -> AppResult<bool> + Send),
    ) -> BoxFuture<'a, AppResult<bool>> {
        Box::pin(async move {
            let requested = database.filter(|value| !value.trim().is_empty());

            if requested.is_none() || requested.as_deref() == Some(self.database.as_str()) {
                let mut conn = self.pool.acquire().await.map_err(db_error)?;
                stream_rows(&mut conn, sql, batch_size, on_batch).await
            } else {
                let options = self
                    .options
                    .clone()
                    .database(requested.as_deref().unwrap_or_default());
                let mut conn = MySqlConnection::connect_with(&options)
                    .await
                    .map_err(db_error)?;
                if self.read_only {
                    sqlx::query("SET SESSION TRANSACTION READ ONLY")
                        .execute(&mut conn)
                        .await
                        .map_err(db_error)?;
                }
                stream_rows(&mut conn, sql, batch_size, on_batch).await
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
                let options = self
                    .options
                    .clone()
                    .database(requested.as_deref().unwrap_or_default());
                let mut conn = MySqlConnection::connect_with(&options)
                    .await
                    .map_err(|error| TxError::new(None, db_error(error)))?;
                if self.read_only {
                    sqlx::query("SET SESSION TRANSACTION READ ONLY")
                        .execute(&mut conn)
                        .await
                        .map_err(|error| TxError::new(None, db_error(error)))?;
                }
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
                let options = self
                    .options
                    .clone()
                    .database(requested.as_deref().unwrap_or_default());
                let mut conn = MySqlConnection::connect_with(&options)
                    .await
                    .map_err(|error| TxError::new(None, db_error(error)))?;
                if self.read_only {
                    sqlx::query("SET SESSION TRANSACTION READ ONLY")
                        .execute(&mut conn)
                        .await
                        .map_err(|error| TxError::new(None, db_error(error)))?;
                }
                run_stream_transaction(&mut conn, input).await
            }
        })
    }

    fn stream_restore<'a>(
        &'a self,
        input: tokio::sync::mpsc::Receiver<TxInput>,
        database: Option<String>,
        transactional: bool,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>> {
        Box::pin(async move {
            if transactional {
                return self.stream_transaction(input, database).await;
            }

            let requested = database.filter(|value| !value.trim().is_empty());

            if requested.is_none() || requested.as_deref() == Some(self.database.as_str()) {
                let mut conn = self
                    .pool
                    .acquire()
                    .await
                    .map_err(|error| TxError::new(None, db_error(error)))?;
                run_stream_restore(&mut conn, input).await
            } else {
                let options = self
                    .options
                    .clone()
                    .database(requested.as_deref().unwrap_or_default());
                let mut conn = MySqlConnection::connect_with(&options)
                    .await
                    .map_err(|error| TxError::new(None, db_error(error)))?;
                if self.read_only {
                    sqlx::query("SET SESSION TRANSACTION READ ONLY")
                        .execute(&mut conn)
                        .await
                        .map_err(|error| TxError::new(None, db_error(error)))?;
                }
                run_stream_restore(&mut conn, input).await
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

    fn get_er_schema<'a>(
        &'a self,
        database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<ErSchema>> {
        Box::pin(async move {
            let database = database
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&self.database)
                .to_string();
            if database.is_empty() {
                return Err(AppError::Config("sxem üçün baza seçilməyib".to_string()));
            }

            let rows = sqlx::query(er::mysql_tables_sql())
                .bind(&database)
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;
            let mut names: Vec<String> = rows.iter().map(|row| cell_to_text(row, 0)).collect();
            names.sort();
            names.dedup();

            let truncated = names.len() > ER_TABLE_LIMIT;
            names.truncate(ER_TABLE_LIMIT);
            let included: std::collections::HashSet<String> =
                names.iter().cloned().collect();
            let mut tables: Vec<ErTable> = names
                .into_iter()
                .map(|name| ErTable {
                    name,
                    columns: Vec::new(),
                })
                .collect();
            let index: std::collections::HashMap<String, usize> = tables
                .iter()
                .enumerate()
                .map(|(index, table)| (table.name.clone(), index))
                .collect();

            let column_rows = sqlx::query(er::mysql_columns_sql())
                .bind(&database)
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;
            for row in column_rows {
                let table = cell_to_text(&row, 0);
                let Some(&position) = index.get(&table) else {
                    continue;
                };
                let pk = cell_to_text(&row, 4);
                tables[position].columns.push(ErColumn {
                    name: cell_to_text(&row, 1),
                    data_type: cell_to_text(&row, 2),
                    nullable: cell_to_text(&row, 3).eq_ignore_ascii_case("YES"),
                    pk: pk == "1" || pk.eq_ignore_ascii_case("true"),
                });
            }

            let fk_rows = sqlx::query(er::mysql_foreign_keys_sql())
                .bind(&database)
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;
            let mut foreign_key_rows = Vec::new();
            for row in fk_rows {
                let from_table = cell_to_text(&row, 1);
                let to_table = cell_to_text(&row, 4);
                if !included.contains(&from_table) || !included.contains(&to_table) {
                    continue;
                }
                foreign_key_rows.push(ForeignKeyRow {
                    constraint_name: cell_to_text(&row, 0),
                    from_table,
                    from_column: cell_to_text(&row, 2),
                    from_position: row.try_get::<u64, _>(3).unwrap_or(0) as i64,
                    to_table,
                    to_column: cell_to_text(&row, 5),
                    to_position: row.try_get::<u64, _>(6).unwrap_or(0) as i64,
                });
            }

            Ok(ErSchema {
                database,
                tables,
                foreign_keys: group_foreign_keys(foreign_key_rows),
                truncated,
            })
        })
    }

    fn get_diff_schema<'a>(
        &'a self,
        database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<SchemaData>> {
        Box::pin(async move {
            let database = database
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&self.database)
                .to_string();
            if database.is_empty() {
                return Err(AppError::Config("sxem üçün baza seçilməyib".to_string()));
            }

            let rows = sqlx::query(er::mysql_tables_sql())
                .bind(&database)
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;
            let mut names: Vec<String> = rows.iter().map(|row| cell_to_text(row, 0)).collect();
            names.sort();
            names.dedup();

            let truncated = names.len() > DIFF_TABLE_LIMIT;
            names.truncate(DIFF_TABLE_LIMIT);
            let included: std::collections::HashSet<String> = names.iter().cloned().collect();
            let mut tables: std::collections::HashMap<String, TableSchema> = names
                .iter()
                .map(|name| {
                    (
                        name.clone(),
                        TableSchema {
                            name: name.clone(),
                            columns: Vec::new(),
                            indexes: Vec::new(),
                            pk_constraint: None,
                        },
                    )
                })
                .collect();

            let column_rows = sqlx::query(er::mysql_columns_sql())
                .bind(&database)
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;
            for row in column_rows {
                let table = cell_to_text(&row, 0);
                let Some(schema) = tables.get_mut(&table) else {
                    continue;
                };
                let pk = cell_to_text(&row, 4);
                schema.columns.push(ColumnSchema {
                    name: cell_to_text(&row, 1),
                    data_type: cell_to_text(&row, 2),
                    nullable: cell_to_text(&row, 3).eq_ignore_ascii_case("YES"),
                    primary_key: pk == "1" || pk.eq_ignore_ascii_case("true"),
                    default: None,
                    auto_increment: false,
                });
            }

            let extra_rows = sqlx::query(
                "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_DEFAULT, EXTRA \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?",
            )
            .bind(&database)
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;
            for row in extra_rows {
                let table = cell_to_text(&row, 0);
                let Some(schema) = tables.get_mut(&table) else {
                    continue;
                };
                let column_name = cell_to_text(&row, 1);
                let default = row
                    .try_get::<Option<String>, _>(2)
                    .unwrap_or(None);
                let extra = cell_to_text(&row, 3);
                let auto_increment = extra.to_ascii_lowercase().contains("auto_increment");
                if let Some(column) = schema
                    .columns
                    .iter_mut()
                    .find(|column| column.name == column_name)
                {
                    column.auto_increment = auto_increment;
                    column.default = render_mysql_default(default.as_deref(), &extra);
                }
            }

            let index_rows = sqlx::query(
                "SELECT INDEX_NAME, TABLE_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE \
                 FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = ? AND INDEX_NAME <> 'PRIMARY' \
                 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
            )
            .bind(&database)
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;
            let mut grouped_indexes: std::collections::BTreeMap<
                (String, String),
                (bool, Vec<(i64, String)>),
            > = std::collections::BTreeMap::new();
            for row in index_rows {
                let index_name = cell_to_text(&row, 0);
                let table_name = cell_to_text(&row, 1);
                if !included.contains(&table_name) {
                    continue;
                }
                let column_name = row.try_get::<Option<String>, _>(2).unwrap_or(None);
                let Some(column_name) = column_name.filter(|value| !value.is_empty()) else {
                    continue;
                };
                let unique = cell_to_text(&row, 4).trim() == "0";
                let position = cell_to_text(&row, 3).parse::<i64>().unwrap_or(0);
                let entry = grouped_indexes
                    .entry((table_name, index_name))
                    .or_insert((unique, Vec::new()));
                entry.0 = unique;
                entry.1.push((position, column_name));
            }
            for ((table_name, index_name), (unique, mut columns)) in grouped_indexes {
                let Some(schema) = tables.get_mut(&table_name) else {
                    continue;
                };
                columns.sort_by_key(|(position, _)| *position);
                schema.indexes.push(IndexSchema {
                    name: index_name,
                    columns: columns.into_iter().map(|(_, column)| column).collect(),
                    unique,
                });
            }

            let view_rows = sqlx::query(
                "SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS \
                 WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            )
            .bind(&database)
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;
            let views = view_rows
                .into_iter()
                .take(DIFF_TABLE_LIMIT)
                .map(|row| ViewSchema {
                    name: cell_to_text(&row, 0),
                    definition: row.try_get::<Option<String>, _>(1).unwrap_or(None),
                })
                .filter(|view| !view.name.is_empty())
                .collect();

            let fk_rows = sqlx::query(er::mysql_foreign_keys_sql())
                .bind(&database)
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;
            let mut foreign_key_rows = Vec::new();
            for row in fk_rows {
                let from_table = cell_to_text(&row, 1);
                let to_table = cell_to_text(&row, 4);
                if !included.contains(&from_table) || !included.contains(&to_table) {
                    continue;
                }
                foreign_key_rows.push(ForeignKeyRow {
                    constraint_name: cell_to_text(&row, 0),
                    from_table,
                    from_column: cell_to_text(&row, 2),
                    from_position: row.try_get::<u64, _>(3).unwrap_or(0) as i64,
                    to_table,
                    to_column: cell_to_text(&row, 5),
                    to_position: row.try_get::<u64, _>(6).unwrap_or(0) as i64,
                });
            }
            let foreign_keys = group_foreign_keys(foreign_key_rows)
                .into_iter()
                .map(|fk| ForeignKeySchema {
                    name: fk.name,
                    from_table: fk.from_table,
                    from_columns: fk.from_columns,
                    to_table: fk.to_table,
                    to_columns: fk.to_columns,
                })
                .collect();

            let mut table_list: Vec<TableSchema> = tables.into_values().collect();
            table_list.sort_by(|a, b| a.name.cmp(&b.name));

            Ok(SchemaData {
                database,
                tables: table_list,
                foreign_keys,
                views,
                truncated,
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

    fn list_all_tables<'a>(&'a self) -> BoxFuture<'a, AppResult<Vec<DatabaseTable>>> {
        Box::pin(async move {
            let sql = all_tables_sql(Dialect::Mysql).expect("MySQL all-tables SQL");
            let rows = sqlx::query(sql)
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;

            Ok(rows
                .into_iter()
                .map(|row| {
                    let table_type = cell_to_text(&row, 2);
                    DatabaseTable {
                        database: cell_to_text(&row, 0),
                        name: cell_to_text(&row, 1),
                        kind: if table_type.to_ascii_uppercase().contains("VIEW") {
                            TableKind::View
                        } else {
                            TableKind::Table
                        },
                    }
                })
                .collect())
        })
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

fn render_mysql_default(default: Option<&str>, extra: &str) -> Option<String> {
    let value = default?.trim();
    if value.is_empty() {
        return None;
    }

    let lower = value.to_ascii_lowercase();
    let extra = extra.to_ascii_lowercase();
    let expression = extra.contains("default_generated")
        || lower == "current_timestamp"
        || lower.starts_with("current_timestamp(")
        || lower == "now()"
        || lower == "null"
        || value.starts_with('(')
        || value.starts_with("b'")
        || value.starts_with("0x")
        || value.parse::<f64>().is_ok();

    if expression || (value.starts_with('\'') && value.ends_with('\'')) {
        Some(value.to_string())
    } else {
        Some(format!("'{}'", value.replace('\'', "''")))
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
        "BIGINT" => int_value!(i64, int_json),
        "BIGINT UNSIGNED" => int_value!(u64, uint_json),
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

#[cfg(test)]
mod tests {
    use super::{apply_ssl_options, map_ssl_mode};
    use crate::core::drivers::SslMode;
    use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};

    #[test]
    fn maps_every_ssl_mode_to_the_mysql_option() {
        assert!(matches!(
            map_ssl_mode(SslMode::Disable),
            MySqlSslMode::Disabled
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::Prefer),
            MySqlSslMode::Preferred
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::Require),
            MySqlSslMode::Required
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::VerifyCa),
            MySqlSslMode::VerifyCa
        ));
        assert!(matches!(
            map_ssl_mode(SslMode::VerifyFull),
            MySqlSslMode::VerifyIdentity
        ));
    }

    #[test]
    fn leaves_the_default_mode_when_ssl_is_not_configured() {
        let options = apply_ssl_options(MySqlConnectOptions::new(), None, None);

        assert!(matches!(
            options.get_ssl_mode(),
            MySqlSslMode::Preferred
        ));
        assert!(!format!("{options:?}").contains("ssl_ca: Some"));
    }

    #[test]
    fn applies_the_requested_mode_and_ca_file() {
        let options = apply_ssl_options(
            MySqlConnectOptions::new(),
            Some(SslMode::VerifyCa),
            Some(" certs/ca.pem "),
        );

        assert!(matches!(
            options.get_ssl_mode(),
            MySqlSslMode::VerifyCa
        ));
        assert!(format!("{options:?}").contains("certs/ca.pem"));
    }

    #[test]
    fn ignores_an_empty_ca_file() {
        let options = apply_ssl_options(
            MySqlConnectOptions::new(),
            Some(SslMode::VerifyFull),
            Some("   "),
        );

        assert!(matches!(
            options.get_ssl_mode(),
            MySqlSslMode::VerifyIdentity
        ));
        assert!(!format!("{options:?}").contains("ssl_ca: Some"));
    }
}
