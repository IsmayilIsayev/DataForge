use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{Number, Value};

use crate::core::drivers::{
    all_tables_sql, int_json, uint_json, BoxFuture, ColumnInfo, ConnectionInput, DatabaseTable,
    Dialect, Driver, ErColumn, ErSchema, ErTable, QueryResult, SchemaSnapshot, SchemaTable,
    SslMode, TableInfo, TableKind, TxError, TxInput, TxRowError, TxStreamOutcome, ER_TABLE_LIMIT,
};
use crate::core::query_cancel::{clickhouse_cancel_sql, CancelTarget, RunCancel};
use crate::core::restore::truncate_preview;
use crate::error::{AppError, AppResult};

const DEFAULT_MAX_ROWS: i64 = 1000;
const MAX_ROWS: i64 = 100_000;
const DEFAULT_PORT: u16 = 8123;
const HTTPS_PORT: u16 = 8443;
const RESPONSE_FORMAT: &str = "JSONCompactEachRowWithNamesAndTypes";

pub struct ClickHouseDriver {
    client: reqwest::Client,
    base: String,
    username: String,
    password: String,
    database: String,
}

impl ClickHouseDriver {
    pub async fn connect(input: &ConnectionInput, password: Option<&str>) -> AppResult<Self> {
        let secure = is_secure(input);
        let port = if input.port == 0 {
            if secure {
                HTTPS_PORT
            } else {
                DEFAULT_PORT
            }
        } else {
            input.port
        };
        let base = format!("{}://{}:{}", scheme(secure), host_without_scheme(&input.host), port);
        let client = build_client(input)?;
        let database = input
            .database
            .clone()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "default".to_string());

        let driver = Self {
            client,
            base,
            username: input.username.clone(),
            password: password.unwrap_or_default().to_string(),
            database,
        };

        // Fail fast on bad credentials or an unreachable/non-HTTP endpoint.
        driver
            .execute_statement("SELECT 1", 1, None, None)
            .await?;
        Ok(driver)
    }

    fn database<'a>(&'a self, requested: Option<&'a str>) -> &'a str {
        requested
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&self.database)
    }

    async fn execute_statement(
        &self,
        sql: &str,
        max_rows: i64,
        database: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> AppResult<QueryResult> {
        self.execute_statement_with_id(sql, max_rows, database, timeout_ms, None)
            .await
    }

    async fn execute_statement_with_id(
        &self,
        sql: &str,
        max_rows: i64,
        database: Option<&str>,
        timeout_ms: Option<u64>,
        query_id: Option<&str>,
    ) -> AppResult<QueryResult> {
        let started = Instant::now();
        let body = trim_statement(sql);
        if body.is_empty() {
            return Err(AppError::Config("SQL boşdur".to_string()));
        }

        let limit = if max_rows <= 0 {
            DEFAULT_MAX_ROWS
        } else {
            max_rows.clamp(1, MAX_ROWS)
        };
        let row_returning = matches!(
            first_keyword(body).as_str(),
            "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "EXISTS"
        );

        if !row_returning {
            let (_, summary) = self
                .http_query(body, self.database(database), None, timeout_ms, query_id)
                .await?;
            return Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                rows_affected: summary_rows(summary.as_deref()),
                elapsed_ms: started.elapsed().as_millis() as u64,
                truncated: false,
            });
        }

        let fetched_limit = limit.saturating_add(1);
        let query = if matches!(first_keyword(body).as_str(), "SELECT" | "WITH") {
            append_limit(body, fetched_limit)
        } else {
            body.to_string()
        };
        let (text, _) = self
            .http_query(
                &query,
                self.database(database),
                Some(fetched_limit),
                timeout_ms,
                query_id,
            )
            .await?;
        let (columns, _, mut rows) = parse_response(&text)?;
        let truncated = rows.len() > limit as usize;
        rows.truncate(limit as usize);

        Ok(QueryResult {
            columns,
            rows,
            rows_affected: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated,
        })
    }

    async fn http_query(
        &self,
        sql: &str,
        database: &str,
        max_result_rows: Option<i64>,
        timeout_ms: Option<u64>,
        query_id: Option<&str>,
    ) -> AppResult<(String, Option<String>)> {
        let request = build_request_with_query_id(
            &self.base,
            database,
            max_result_rows,
            timeout_ms,
            &self.username,
            &self.password,
            query_id,
        )?;

        let response = self
            .client
            .post(request.url.as_str())
            .header("X-ClickHouse-User", &request.user)
            .header("X-ClickHouse-Key", &request.key)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(sql.to_string())
            .send()
            .await
            .map_err(|error| AppError::Db(format!("ClickHouse HTTP: {error}")))?;

        let status = response.status();
        let summary = response
            .headers()
            .get("x-clickhouse-summary")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let text = response
            .text()
            .await
            .map_err(|error| AppError::Db(format!("ClickHouse HTTP body: {error}")))?;

        if !status.is_success() {
            let message = text.trim();
            return Err(AppError::Db(format!(
                "ClickHouse {}: {}",
                status.as_u16(),
                if message.is_empty() {
                    status.canonical_reason().unwrap_or("request failed")
                } else {
                    message
                }
            )));
        }

        Ok((text, summary))
    }

    async fn stream_rows(
        &self,
        sql: &str,
        database: Option<&str>,
        batch_size: usize,
        on_batch: &mut (dyn FnMut(Vec<Vec<Value>>) -> AppResult<bool> + Send),
    ) -> AppResult<bool> {
        let body = trim_statement(sql);
        let request = build_request(
            &self.base,
            self.database(database),
            None,
            None,
            &self.username,
            &self.password,
        )?;

        let response = self
            .client
            .post(request.url.as_str())
            .header("X-ClickHouse-User", &request.user)
            .header("X-ClickHouse-Key", &request.key)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(body.to_string())
            .send()
            .await
            .map_err(|error| AppError::Db(format!("ClickHouse HTTP: {error}")))?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let message = text.trim();
            return Err(AppError::Db(format!(
                "ClickHouse {}: {}",
                status.as_u16(),
                if message.is_empty() {
                    status.canonical_reason().unwrap_or("request failed")
                } else {
                    message
                }
            )));
        }

        let batch_size = batch_size.max(1);
        let mut batch: Vec<Vec<Value>> = Vec::with_capacity(batch_size);
        let mut pending: Vec<u8> = Vec::new();
        let mut header = 0u8;
        let mut types: Vec<String> = Vec::new();
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|error| AppError::Db(format!("ClickHouse HTTP body: {error}")))?;
            pending.extend_from_slice(&chunk);

            let mut start = 0usize;
            while let Some(offset) = pending[start..].iter().position(|&byte| byte == b'\n') {
                let end = start + offset;
                let line = &pending[start..end];
                start = end + 1;
                let text = std::str::from_utf8(line)
                    .map_err(|error| AppError::Db(format!("ClickHouse response: {error}")))?
                    .trim_end_matches('\r');
                if let Some(row) = parse_stream_line(text, &mut header, &mut types)? {
                    batch.push(row);
                    if batch.len() >= batch_size {
                        if !on_batch(std::mem::take(&mut batch))? {
                            return Ok(false);
                        }
                        batch = Vec::with_capacity(batch_size);
                    }
                }
            }
            if start > 0 {
                pending.drain(..start);
            }
        }

        if !pending.is_empty() {
            let text = std::str::from_utf8(&pending)
                .map_err(|error| AppError::Db(format!("ClickHouse response: {error}")))?
                .trim_end_matches('\r');
            if let Some(row) = parse_stream_line(text, &mut header, &mut types)? {
                batch.push(row);
            }
        }

        if !batch.is_empty() && !on_batch(batch)? {
            return Ok(false);
        }
        Ok(true)
    }

    async fn tables_on(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        let sql = format!(
            "SELECT name, engine FROM system.tables WHERE database = {} ORDER BY name",
            sql_string(database)
        );
        let result = self
            .execute_statement(&sql, MAX_ROWS, Some(database), None)
            .await?;

        Ok(result
            .rows
            .iter()
            .map(|row| {
                let engine = text_at(row, 1);
                TableInfo {
                    name: text_at(row, 0),
                    kind: if engine.to_ascii_lowercase().contains("view") {
                        TableKind::View
                    } else {
                        TableKind::Table
                    },
                }
            })
            .filter(|table| !table.name.is_empty())
            .collect())
    }

    async fn columns_on(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let sql = format!(
            "SELECT name, type, is_in_primary_key, default_kind \
             FROM system.columns WHERE database = {} AND table = {} ORDER BY position",
            sql_string(database),
            sql_string(table)
        );
        let result = self
            .execute_statement(&sql, MAX_ROWS, Some(database), None)
            .await?;

        Ok(result
            .rows
            .iter()
            .map(|row| {
                let data_type = text_at(row, 1);
                let primary = bool_at(row, 2);
                let _default_kind = text_at(row, 3);
                ColumnInfo {
                    name: text_at(row, 0),
                    nullable: data_type.contains("Nullable("),
                    data_type,
                    key: if primary { Some("PRI".to_string()) } else { None },
                }
            })
            .filter(|column| !column.name.is_empty())
            .collect())
    }
}


async fn run_stream_restore(
    driver: &ClickHouseDriver,
    mut input: tokio::sync::mpsc::Receiver<TxInput>,
    database: Option<String>,
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
                match driver
                    .execute_statement(&sql, 0, database.as_deref(), None)
                    .await
                {
                    Ok(result) => {
                        outcome.rows_affected += result.rows_affected.unwrap_or(0)
                    }
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
                                error,
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

impl Driver for ClickHouseDriver {
    fn dialect(&self) -> Dialect {
        Dialect::Clickhouse
    }

    fn dialect_name(&self) -> &'static str {
        "ClickHouse SQL"
    }

    fn query<'a>(&'a self, sql: &'a str, max_rows: i64) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move { self.execute_statement(sql, max_rows, None, None).await })
    }

    fn run_statements<'a>(
        &'a self,
        statements: &'a [String],
        max_rows: i64,
        database: Option<String>,
    ) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let (last, earlier) = statements
                .split_last()
                .ok_or_else(|| AppError::Config("SQL boşdur".to_string()))?;

            for statement in earlier {
                if trim_statement(statement).is_empty() {
                    continue;
                }
                self.execute_statement(statement, max_rows, database.as_deref(), None)
                    .await?;
            }

            self.execute_statement(last, max_rows, database.as_deref(), None)
                .await
        })
    }

    fn run_statements_cancellable<'a>(
        &'a self,
        statements: &'a [String],
        max_rows: i64,
        database: Option<String>,
        run: &'a RunCancel,
    ) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let query_id = run.run_id().to_string();
            run.set_target(CancelTarget::Clickhouse(query_id.clone()));
            let (last, earlier) = statements
                .split_last()
                .ok_or_else(|| AppError::Config("SQL boşdur".to_string()))?;

            for statement in earlier {
                if trim_statement(statement).is_empty() {
                    continue;
                }
                self.execute_statement_with_id(
                    statement,
                    max_rows,
                    database.as_deref(),
                    None,
                    Some(&query_id),
                )
                .await?;
            }

            self.execute_statement_with_id(
                last,
                max_rows,
                database.as_deref(),
                None,
                Some(&query_id),
            )
            .await
        })
    }

    fn cancel_query<'a>(&'a self, target: CancelTarget) -> BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            let CancelTarget::Clickhouse(query_id) = target else {
                return Ok(());
            };
            let Some(sql) = clickhouse_cancel_sql(&query_id) else {
                return Ok(());
            };
            self.http_query(&sql, &self.database, None, None, None)
                .await?;
            Ok(())
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
            self.stream_rows(sql, database.as_deref(), batch_size, on_batch)
                .await
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
            self.execute_statement(sql, max_rows, database.as_deref(), timeout_ms)
                .await
        })
    }

    fn apply_transaction<'a>(
        &'a self,
        statements: &'a [String],
        database: Option<String>,
    ) -> BoxFuture<'a, Result<u64, TxError>> {
        Box::pin(async move {
            // ClickHouse has no multi-statement transactions; run statements in
            // order and stop at the first error.
            let mut affected = 0u64;
            for (index, statement) in statements.iter().enumerate() {
                if trim_statement(statement).is_empty() {
                    continue;
                }
                match self
                    .execute_statement(statement, 0, database.as_deref(), None)
                    .await
                {
                    Ok(result) => affected += result.rows_affected.unwrap_or(0),
                    Err(error) => return Err(TxError::new(Some(index), error)),
                }
            }
            Ok(affected)
        })
    }

    fn stream_transaction<'a>(
        &'a self,
        input: tokio::sync::mpsc::Receiver<TxInput>,
        database: Option<String>,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>> {
        Box::pin(async move { run_stream_restore(self, input, database).await })
    }

    fn stream_restore<'a>(
        &'a self,
        input: tokio::sync::mpsc::Receiver<TxInput>,
        database: Option<String>,
        _transactional: bool,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>> {
        Box::pin(async move { run_stream_restore(self, input, database).await })
    }

    fn get_schema<'a>(
        &'a self,
        database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<SchemaSnapshot>> {
        Box::pin(async move {
            let database = self.database(database).to_string();
            let tables = self.tables_on(&database).await?;
            let mut snapshot = Vec::with_capacity(tables.len());

            for table in tables {
                let columns = self.columns_on(&database, &table.name).await?;
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
            let database = self.database(database).to_string();
            let mut tables = self.tables_on(&database).await?;
            let truncated = tables.len() > ER_TABLE_LIMIT;
            tables.truncate(ER_TABLE_LIMIT);

            let mut er_tables = Vec::with_capacity(tables.len());
            for table in tables {
                let columns = self.columns_on(&database, &table.name).await?;
                er_tables.push(ErTable {
                    name: table.name,
                    columns: columns
                        .into_iter()
                        .map(|column| ErColumn {
                            name: column.name,
                            data_type: column.data_type,
                            nullable: column.nullable,
                            pk: column.key.as_deref() == Some("PRI"),
                        })
                        .collect(),
                });
            }

            Ok(ErSchema {
                database,
                tables: er_tables,
                foreign_keys: Vec::new(),
                truncated,
            })
        })
    }

    fn list_databases<'a>(&'a self) -> BoxFuture<'a, AppResult<Vec<String>>> {
        Box::pin(async move {
            let result = self
                .execute_statement(
                    "SELECT name FROM system.databases ORDER BY name",
                    MAX_ROWS,
                    None,
                    None,
                )
                .await?;
            Ok(result
                .rows
                .iter()
                .map(|row| text_at(row, 0))
                .filter(|name| !name.is_empty())
                .collect())
        })
    }

    fn list_tables<'a>(&'a self, database: &'a str) -> BoxFuture<'a, AppResult<Vec<TableInfo>>> {
        Box::pin(async move {
            let database = self.database(Some(database));
            self.tables_on(database).await
        })
    }

    fn list_all_tables<'a>(&'a self) -> BoxFuture<'a, AppResult<Vec<DatabaseTable>>> {
        Box::pin(async move {
            let sql = all_tables_sql(Dialect::Clickhouse).expect("ClickHouse all-tables SQL");
            let result = self
                .execute_statement(sql, MAX_ROWS, None, None)
                .await?;

            Ok(result
                .rows
                .iter()
                .map(|row| {
                    let engine = text_at(row, 2);
                    DatabaseTable {
                        database: text_at(row, 0),
                        name: text_at(row, 1),
                        kind: if engine.to_ascii_lowercase().contains("view") {
                            TableKind::View
                        } else {
                            TableKind::Table
                        },
                    }
                })
                .filter(|table| !table.name.is_empty())
                .collect())
        })
    }

    fn list_columns<'a>(
        &'a self,
        database: &'a str,
        table: &'a str,
    ) -> BoxFuture<'a, AppResult<Vec<ColumnInfo>>> {
        Box::pin(async move {
            let database = self.database(Some(database));
            self.columns_on(database, table).await
        })
    }
}

struct HttpRequest {
    url: String,
    user: String,
    key: String,
}

fn is_secure(input: &ConnectionInput) -> bool {
    !matches!(input.ssl_mode, None | Some(SslMode::Disable))
}

fn scheme(secure: bool) -> &'static str {
    if secure {
        "https"
    } else {
        "http"
    }
}

fn host_without_scheme(host: &str) -> String {
    let value = host
        .trim()
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or_else(|| host.trim());
    value.trim_end_matches('/').to_string()
}

fn build_client(input: &ConnectionInput) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(10));

    if input.trust_cert.unwrap_or(false) {
        builder = builder.danger_accept_invalid_certs(true);
    }

    if let Some(path) = input
        .ssl_ca_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let pem = std::fs::read(path)
            .map_err(|error| AppError::Config(format!("CA certificate: {error}")))?;
        let certificate = reqwest::Certificate::from_pem(&pem)
            .map_err(|error| AppError::Config(format!("CA certificate: {error}")))?;
        builder = builder.add_root_certificate(certificate);
    }

    builder
        .build()
        .map_err(|error| AppError::Db(format!("ClickHouse HTTP client: {error}")))
}

fn build_request(
    base: &str,
    database: &str,
    max_result_rows: Option<i64>,
    timeout_ms: Option<u64>,
    username: &str,
    password: &str,
) -> AppResult<HttpRequest> {
    build_request_with_query_id(
        base,
        database,
        max_result_rows,
        timeout_ms,
        username,
        password,
        None,
    )
}

fn build_request_with_query_id(
    base: &str,
    database: &str,
    max_result_rows: Option<i64>,
    timeout_ms: Option<u64>,
    username: &str,
    password: &str,
    query_id: Option<&str>,
) -> AppResult<HttpRequest> {
    let mut url = reqwest::Url::parse(&format!("{}/", base.trim_end_matches('/')))
        .map_err(|error| AppError::Config(format!("ClickHouse URL: {error}")))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("database", database);
        query.append_pair("default_format", RESPONSE_FORMAT);
        if let Some(query_id) = query_id {
            query.append_pair("query_id", query_id);
        }
        if let Some(limit) = max_result_rows {
            query.append_pair("max_result_rows", &limit.to_string());
            query.append_pair("result_overflow_mode", "break");
        }
        if let Some(timeout_ms) = timeout_ms {
            let seconds = timeout_ms.div_ceil(1000).max(1);
            query.append_pair("max_execution_time", &seconds.to_string());
        }
    }

    Ok(HttpRequest {
        url: url.to_string(),
        user: username.to_string(),
        key: password.to_string(),
    })
}

fn parse_stream_line(
    text: &str,
    header: &mut u8,
    types: &mut Vec<String>,
) -> AppResult<Option<Vec<Value>>> {
    if text.trim().is_empty() {
        return Ok(None);
    }

    match *header {
        0 => {
            *header = 1;
            Ok(None)
        }
        1 => {
            *types = serde_json::from_str(text)
                .map_err(|error| AppError::Db(format!("ClickHouse column types: {error}")))?;
            *header = 2;
            Ok(None)
        }
        _ => {
            let values: Vec<Value> = serde_json::from_str(text)
                .map_err(|error| AppError::Db(format!("ClickHouse row: {error}")))?;
            let row = values
                .into_iter()
                .enumerate()
                .map(|(index, value)| {
                    map_value(
                        types.get(index).map(String::as_str).unwrap_or("String"),
                        &value,
                    )
                })
                .collect();
            Ok(Some(row))
        }
    }
}

fn parse_response(body: &str) -> AppResult<(Vec<String>, Vec<String>, Vec<Vec<Value>>)> {
    let mut lines = body.lines().filter(|line| !line.trim().is_empty());
    let names = lines
        .next()
        .ok_or_else(|| AppError::Db("ClickHouse returned an empty response".to_string()))?;
    let types = lines
        .next()
        .ok_or_else(|| AppError::Db("ClickHouse response is missing column types".to_string()))?;
    let names: Vec<String> = serde_json::from_str(names)
        .map_err(|error| AppError::Db(format!("ClickHouse column names: {error}")))?;
    let types: Vec<String> = serde_json::from_str(types)
        .map_err(|error| AppError::Db(format!("ClickHouse column types: {error}")))?;

    let mut rows = Vec::new();
    for line in lines {
        let values: Vec<Value> = serde_json::from_str(line)
            .map_err(|error| AppError::Db(format!("ClickHouse row: {error}")))?;
        let row = values
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                map_value(
                    types.get(index).map(String::as_str).unwrap_or("String"),
                    &value,
                )
            })
            .collect();
        rows.push(row);
    }

    Ok((names, types, rows))
}

fn map_value(type_name: &str, value: &Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }

    let base = unwrap_type(type_name);
    let lower = base.to_ascii_lowercase();

    if lower.starts_with("nullable(") || lower.starts_with("lowcardinality(") {
        let inner = &base[base.find('(').unwrap_or(0) + 1..base.len().saturating_sub(1)];
        return map_value(inner, value);
    }

    if lower.starts_with("array(") {
        let inner = &base[6..base.len().saturating_sub(1)];
        if let Value::Array(items) = value {
            return Value::Array(items.iter().map(|item| map_value(inner, item)).collect());
        }
        return value.clone();
    }

    if lower.starts_with("tuple(") || lower.starts_with("map(") {
        return value.clone();
    }

    if lower.starts_with("uint") {
        if let Some(number) = as_u64(value) {
            return uint_json(number);
        }
        return raw_string(value);
    }

    if ["int8", "int16", "int32", "int64", "int128", "int256"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        if let Some(number) = as_i64(value) {
            return int_json(number);
        }
        return raw_string(value);
    }

    if lower.starts_with("float") {
        return as_f64(value)
            .and_then(Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| raw_string(value));
    }

    if lower.starts_with("decimal") {
        return raw_string(value);
    }

    if lower.starts_with("date") {
        return iso_datetime(value);
    }

    if lower.starts_with("datetime") || lower.starts_with("datetime64") {
        return iso_datetime(value);
    }

    if lower == "bool" || lower == "boolean" {
        if let Some(value) = as_bool(value) {
            return Value::Bool(value);
        }
        return raw_string(value);
    }

    if lower == "nothing" {
        return Value::Null;
    }

    if lower.starts_with("string")
        || lower.starts_with("fixedstring")
        || lower.starts_with("enum")
        || lower.starts_with("uuid")
        || lower.starts_with("ipv")
    {
        return raw_string(value);
    }

    value.clone()
}

fn unwrap_type(type_name: &str) -> String {
    let trimmed = type_name.trim();
    for wrapper in ["Nullable", "LowCardinality"] {
        if let Some(rest) = trimmed.strip_prefix(wrapper) {
            if let Some(inner) = rest.strip_prefix('(').and_then(|rest| rest.strip_suffix(')')) {
                return unwrap_type(inner);
            }
        }
    }
    trimmed.to_string()
}

fn raw_string(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(text.clone()),
        Value::Number(number) => Value::String(number.to_string()),
        Value::Bool(value) => Value::String(value.to_string()),
        Value::Null => Value::Null,
        other => Value::String(other.to_string()),
    }
}

fn iso_datetime(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(text.replacen(' ', "T", 1)),
        Value::Number(number) => Value::String(number.to_string()),
        other => raw_string(other),
    }
}

fn as_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn as_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn as_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(number) => number.as_i64().map(|value| value != 0),
        Value::String(text) => {
            let text = text.trim();
            if text.eq_ignore_ascii_case("true") {
                Some(true)
            } else if text.eq_ignore_ascii_case("false") {
                Some(false)
            } else {
                text.parse::<i64>().ok().map(|value| value != 0)
            }
        }
        _ => None,
    }
}

fn text_at(row: &[Value], index: usize) -> String {
    match row.get(index) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn bool_at(row: &[Value], index: usize) -> bool {
    row.get(index).and_then(as_bool).unwrap_or(false)
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

fn append_limit(sql: &str, limit: i64) -> String {
    if has_top_level_limit(sql) {
        sql.to_string()
    } else {
        format!("{sql}\nLIMIT {limit}")
    }
}

fn has_top_level_limit(sql: &str) -> bool {
    let chars: Vec<char> = sql.chars().collect();
    let len = chars.len();
    let mut index = 0;
    let mut depth = 0i32;
    let mut quote: Option<char> = None;

    while index < len {
        let current = chars[index];

        if let Some(active) = quote {
            if current == '\\' && index + 1 < len {
                index += 2;
                continue;
            }
            if current == active {
                if index + 1 < len && chars[index + 1] == active {
                    index += 2;
                    continue;
                }
                quote = None;
            }
            index += 1;
            continue;
        }

        match current {
            '\'' | '"' | '`' => {
                quote = Some(current);
                index += 1;
            }
            '-' if index + 1 < len && chars[index + 1] == '-' => {
                index += 2;
                while index < len && chars[index] != '\n' {
                    index += 1;
                }
            }
            '#' => {
                while index < len && chars[index] != '\n' {
                    index += 1;
                }
            }
            '/' if index + 1 < len && chars[index + 1] == '*' => {
                index += 2;
                while index + 1 < len && !(chars[index] == '*' && chars[index + 1] == '/') {
                    index += 1;
                }
                index = (index + 2).min(len);
            }
            '(' => {
                depth += 1;
                index += 1;
            }
            ')' => {
                depth = (depth - 1).max(0);
                index += 1;
            }
            character if character.is_ascii_alphabetic() => {
                let start = index;
                while index < len && (chars[index].is_ascii_alphanumeric() || chars[index] == '_') {
                    index += 1;
                }
                if depth == 0 {
                    let word: String = chars[start..index].iter().collect();
                    if word.eq_ignore_ascii_case("limit") {
                        return true;
                    }
                }
            }
            _ => index += 1,
        }
    }

    false
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn summary_rows(summary: Option<&str>) -> Option<u64> {
    let summary: Value = serde_json::from_str(summary?).ok()?;
    ["written_rows", "result_rows"]
        .iter()
        .find_map(|key| summary.get(*key).and_then(as_u64))
}

#[cfg(test)]
mod tests {
    use super::{
        append_limit, build_request, map_value, parse_response, sql_string,
    };
    use serde_json::{json, Value};

    #[test]
    fn parses_names_types_and_rows() {
        let body = r#"["id","label","small","tags"]
["UInt64","Nullable(String)","Int32","Array(String)"]
["9007199254740993","hello",-7,["a","b"]]
[1,null,0,[]]
"#;
        let (names, types, rows) = parse_response(body).expect("valid response");

        assert_eq!(
            names,
            vec![
                "id".to_string(),
                "label".to_string(),
                "small".to_string(),
                "tags".to_string()
            ]
        );
        assert_eq!(types[0], "UInt64");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][0], Value::String("9007199254740993".to_string()));
        assert_eq!(rows[0][1], Value::String("hello".to_string()));
        assert_eq!(rows[0][2], Value::from(-7));
        assert_eq!(rows[0][3], json!(["a", "b"]));
        assert_eq!(rows[1][0], Value::from(1));
        assert_eq!(rows[1][1], Value::Null);
    }

    #[test]
    fn maps_clickhouse_types_to_json() {
        assert_eq!(
            map_value("Nullable(Int32)", &json!(12)),
            Value::from(12)
        );
        assert_eq!(
            map_value("LowCardinality(Nullable(String))", &json!("x")),
            Value::String("x".to_string())
        );
        assert_eq!(
            map_value("UInt64", &json!("9007199254740993")),
            Value::String("9007199254740993".to_string())
        );
        assert_eq!(
            map_value("UInt8", &json!(42)),
            Value::from(42)
        );
        assert_eq!(
            map_value("Decimal(18, 4)", &json!("12.5000")),
            Value::String("12.5000".to_string())
        );
        assert_eq!(
            map_value("Date", &json!("2024-01-02")),
            Value::String("2024-01-02".to_string())
        );
        assert_eq!(
            map_value("DateTime", &json!("2024-01-02 03:04:05")),
            Value::String("2024-01-02T03:04:05".to_string())
        );
        assert_eq!(
            map_value("Array(String)", &json!(["a"])),
            json!(["a"])
        );
    }

    #[test]
    fn appends_a_limit_only_when_the_select_has_none() {
        assert_eq!(
            append_limit("SELECT * FROM events", 101),
            "SELECT * FROM events\nLIMIT 101"
        );
        assert_eq!(
            append_limit("SELECT * FROM events LIMIT 5", 101),
            "SELECT * FROM events LIMIT 5"
        );
        assert_eq!(
            append_limit("SELECT * FROM (SELECT 1 LIMIT 5)", 101),
            "SELECT * FROM (SELECT 1 LIMIT 5)\nLIMIT 101"
        );
        assert_eq!(
            append_limit("SELECT 'LIMIT 5' AS label", 101),
            "SELECT 'LIMIT 5' AS label\nLIMIT 101"
        );
    }

    #[test]
    fn request_url_never_contains_credentials() {
        let request = build_request(
            "https://clickhouse.example:8443",
            "shop",
            Some(25),
            Some(1500),
            "analyst",
            "s3cret-password",
        )
        .expect("valid request");

        assert!(!request.url.contains("s3cret-password"));
        assert!(!request.url.contains("analyst"));
        assert!(request.url.contains("database=shop"));
        assert!(request.url.contains("default_format=JSONCompactEachRowWithNamesAndTypes"));
        assert!(request.url.contains("max_result_rows=25"));
        assert!(request.url.contains("result_overflow_mode=break"));
        assert!(request.url.contains("max_execution_time=2"));
        assert_eq!(request.user, "analyst");
        assert_eq!(request.key, "s3cret-password");
    }

    #[test]
    fn escapes_clickhouse_string_literals() {
        assert_eq!(sql_string("O'Brien"), "'O''Brien'");
        assert_eq!(sql_string(r"C:\tmp"), r"'C:\\tmp'");
        assert_eq!(sql_string(r"a\'b"), r"'a\\''b'");
    }
}
