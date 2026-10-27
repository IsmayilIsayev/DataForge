pub mod clickhouse;
pub mod er;
pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod sqlite;

pub use er::{
    group_foreign_keys, ErColumn, ErForeignKey, ErSchema, ErTable, ForeignKeyRow, ER_TABLE_LIMIT,
};

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::core::query_cancel::{CancelTarget, RunCancel};
use crate::core::schema_diff::SchemaData;
use crate::core::ssh::{self, SshConfig, SshTunnel};
use crate::error::{AppError, AppResult};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Largest integer JavaScript can represent exactly (2^53 - 1). Larger SQL
/// integers are serialized as strings so the frontend cannot silently round
/// primary keys and update/delete the wrong row.
pub(crate) const MAX_SAFE_JSON_INT: i64 = 9_007_199_254_740_991;

pub(crate) fn int_json(value: i64) -> serde_json::Value {
    if (-MAX_SAFE_JSON_INT..=MAX_SAFE_JSON_INT).contains(&value) {
        serde_json::Value::from(value)
    } else {
        serde_json::Value::String(value.to_string())
    }
}

pub(crate) fn uint_json(value: u64) -> serde_json::Value {
    if value <= MAX_SAFE_JSON_INT as u64 {
        serde_json::Value::from(value)
    } else {
        serde_json::Value::String(value.to_string())
    }
}

/// A failed batch transaction. `statement` is the zero-based index of the
/// statement that failed, when the failure happened while executing one.
#[derive(Debug)]
pub struct TxError {
    pub statement: Option<usize>,
    pub error: AppError,
    /// First 200 characters of the failing statement, when available.
    pub statement_sql: Option<String>,
}

impl TxError {
    pub fn new(statement: Option<usize>, error: AppError) -> Self {
        Self {
            statement,
            error,
            statement_sql: None,
        }
    }

    pub fn with_statement(mut self, sql: &str) -> Self {
        self.statement_sql = Some(crate::core::restore::truncate_preview(sql, 200));
        self
    }
}

/// Input for a long-running transaction. The caller streams batches over a
/// bounded channel so neither side has to hold the whole import in memory.
#[derive(Debug)]
pub enum TxInput {
    Sql { sql: String, row: Option<u64> },
    Savepoint(String),
    ReleaseSavepoint(String),
    Rollback,
}

#[derive(Debug, Clone, Serialize)]
pub struct TxRowError {
    pub row: u64,
    pub error: String,
    /// First 200 characters of the statement that failed, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statement: Option<String>,
}

#[derive(Debug, Default)]
pub struct TxStreamOutcome {
    pub rows_affected: u64,
    pub errors: Vec<TxRowError>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Mysql,
    Postgres,
    Sqlite,
    Mssql,
    Mongodb,
    Clickhouse,
}

impl Dialect {
    pub fn as_str(self) -> &'static str {
        match self {
            Dialect::Mysql => "mysql",
            Dialect::Postgres => "postgres",
            Dialect::Sqlite => "sqlite",
            Dialect::Mssql => "mssql",
            Dialect::Mongodb => "mongodb",
            Dialect::Clickhouse => "clickhouse",
        }
    }
}

impl fmt::Display for Dialect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionEnvironment {
    Dev,
    Test,
    Prod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

impl SslMode {
    /// Parse the value of an `sslmode` / `ssl-mode` URL parameter. Both the
    /// PostgreSQL spellings (`verify-ca`) and the MySQL spellings
    /// (`verify_identity`) are accepted.
    pub fn from_url_value(value: &str) -> Option<Self> {
        let normalized = value.trim().to_ascii_lowercase().replace('_', "-");

        match normalized.as_str() {
            "disable" | "disabled" => Some(Self::Disable),
            "allow" | "prefer" | "preferred" => Some(Self::Prefer),
            "require" | "required" => Some(Self::Require),
            "verify-ca" => Some(Self::VerifyCa),
            "verify-full" | "verify-identity" => Some(Self::VerifyFull),
            _ => None,
        }
    }

    /// Read `sslmode` / `ssl-mode` from a connection URL.
    pub fn from_url(url: &str) -> Option<Self> {
        let query = url.split_once('?')?.1.split('#').next().unwrap_or("");

        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            if key.trim().eq_ignore_ascii_case("sslmode")
                || key.trim().eq_ignore_ascii_case("ssl-mode")
            {
                Self::from_url_value(value)
            } else {
                None
            }
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionMeta {
    pub id: String,
    pub name: String,
    pub dialect: Dialect,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<ConnectionEnvironment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flavor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_cert: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_mode: Option<SslMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_ca_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshConfig>,
}

impl ConnectionMeta {
    pub fn from_input(id: String, input: &ConnectionInput) -> Self {
        Self {
            id,
            name: input.name.clone(),
            dialect: input.dialect,
            host: input.host.clone(),
            port: input.port,
            username: input.username.clone(),
            database: input.database.clone(),
            read_only: input.read_only,
            environment: input.environment,
            flavor: input.flavor.clone(),
            trust_cert: input.trust_cert,
            ssl_mode: input.ssl_mode,
            ssl_ca_path: input.ssl_ca_path.clone(),
            ssh: input.ssh.clone(),
        }
    }

    pub fn to_input(&self) -> ConnectionInput {
        ConnectionInput {
            name: self.name.clone(),
            dialect: self.dialect,
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            database: self.database.clone(),
            password: None,
            save_password: true,
            read_only: self.read_only,
            environment: self.environment,
            flavor: self.flavor.clone(),
            trust_cert: self.trust_cert,
            ssl_mode: self.ssl_mode,
            ssl_ca_path: self.ssl_ca_path.clone(),
            ssh: self.ssh.clone(),
            ssh_secret: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInput {
    pub name: String,
    pub dialect: Dialect,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default = "default_true")]
    pub save_password: bool,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub environment: Option<ConnectionEnvironment>,
    #[serde(default)]
    pub flavor: Option<String>,
    #[serde(default)]
    pub trust_cert: Option<bool>,
    #[serde(default)]
    pub ssl_mode: Option<SslMode>,
    #[serde(default)]
    pub ssl_ca_path: Option<String>,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// Transient SSH password or key passphrase. Never persisted in
    /// connections.json; the commands layer moves it to the OS keychain.
    #[serde(default)]
    pub ssh_secret: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
    pub truncated: bool,
}

impl QueryResult {
    pub(crate) fn empty() -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: None,
            elapsed_ms: 0,
            truncated: false,
        }
    }
}

/// How many result sets keep their rows in one run. Later statements still run
/// and report their status, but their result data is dropped.
pub const MAX_RESULT_SETS: usize = 20;
pub const RESULT_LIMIT_NOTE: &str = "result not shown (limit 20)";

/// One statement of a multi-statement run, in execution order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatementResult {
    /// First 200 characters of the statement.
    pub statement: String,
    #[serde(flatten)]
    pub result: QueryResult,
    /// Set when the statement ran but its result was not kept (result-set cap).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl StatementResult {
    pub fn new(statement: &str, result: QueryResult) -> Self {
        Self {
            statement: crate::core::restore::truncate_preview(statement.trim(), 200),
            result,
            note: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchError {
    /// Zero-based index of the statement that failed.
    pub statement: usize,
    /// First 200 characters of the failing statement.
    pub sql: String,
    pub message: String,
}

/// All result sets from one run. The last result is also flattened onto the
/// top level so existing callers keep the old single-result shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchResult {
    #[serde(flatten)]
    pub last: QueryResult,
    pub results: Vec<StatementResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<BatchError>,
}

impl BatchResult {
    pub fn success(results: Vec<StatementResult>) -> Self {
        let last = results
            .last()
            .map(|entry| entry.result.clone())
            .unwrap_or_else(QueryResult::empty);
        let mut results = results;
        for (index, entry) in results.iter_mut().enumerate() {
            if index >= MAX_RESULT_SETS {
                entry.note = Some(RESULT_LIMIT_NOTE.to_string());
                entry.result.columns.clear();
                entry.result.rows.clear();
                entry.result.truncated = false;
            }
        }
        Self {
            last,
            results,
            error: None,
        }
    }

    pub fn failure(
        results: Vec<StatementResult>,
        statement: usize,
        sql: &str,
        error: AppError,
    ) -> Self {
        let mut batch = Self::success(results);
        batch.error = Some(BatchError {
            statement,
            sql: crate::core::restore::truncate_preview(sql.trim(), 200),
            message: error.to_string(),
        });
        batch
    }

    /// Old single-result shape for callers that only need the last statement.
    pub fn into_result(self) -> AppResult<QueryResult> {
        match self.error {
            Some(error) => Err(AppError::Db(error.message)),
            None => Ok(self.last),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub kind: TableKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseTable {
    pub database: String,
    pub name: String,
    pub kind: TableKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaTable {
    pub name: String,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaSnapshot {
    pub database: String,
    pub tables: Vec<SchemaTable>,
}

/// One `:name` value supplied by the frontend for a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunParam {
    pub name: String,
    #[serde(rename = "type", default)]
    pub param_type: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// A value ready to bind, after the SQL was rewritten to a native placeholder.
#[derive(Debug, Clone, PartialEq)]
pub enum ParamValue {
    Text(String),
    Number(String),
    Boolean(bool),
    Null,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BoundParam {
    pub name: String,
    pub value: ParamValue,
}

impl ParamValue {
    /// Text form used by drivers that pass values as strings (ClickHouse HTTP).
    pub fn as_text(&self) -> String {
        match self {
            ParamValue::Text(value) | ParamValue::Number(value) => value.clone(),
            ParamValue::Boolean(value) => value.to_string(),
            ParamValue::Null => String::new(),
        }
    }
}

pub trait Driver: Send + Sync {
    fn dialect(&self) -> Dialect;
    fn dialect_name(&self) -> &'static str;
    fn query<'a>(&'a self, sql: &'a str, max_rows: i64) -> BoxFuture<'a, AppResult<QueryResult>>;
    /// Run every statement and return all result sets in order. Implemented by
    /// each driver through its shared `execute_batch` helper.
    fn run_statements_batch<'a>(
        &'a self,
        statements: &'a [String],
        params: Vec<Vec<BoundParam>>,
        max_rows: i64,
        database: Option<String>,
    ) -> BoxFuture<'a, AppResult<BatchResult>>;
    /// Single-result view of `run_statements_batch` (last result or error).
    fn run_statements<'a>(
        &'a self,
        statements: &'a [String],
        max_rows: i64,
        database: Option<String>,
    ) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let params = vec![Vec::new(); statements.len()];
            self.run_statements_batch(statements, params, max_rows, database)
                .await?
                .into_result()
        })
    }
    /// Like `run_statements_batch`, but records how the server-side statement
    /// can be cancelled. The default ignores cancellation for drivers that do
    /// not support it.
    fn run_statements_cancellable_batch<'a>(
        &'a self,
        statements: &'a [String],
        params: Vec<Vec<BoundParam>>,
        max_rows: i64,
        database: Option<String>,
        run: &'a RunCancel,
    ) -> BoxFuture<'a, AppResult<BatchResult>> {
        let _ = run;
        self.run_statements_batch(statements, params, max_rows, database)
    }
    /// Single-result view of `run_statements_cancellable_batch`.
    fn run_statements_cancellable<'a>(
        &'a self,
        statements: &'a [String],
        max_rows: i64,
        database: Option<String>,
        run: &'a RunCancel,
    ) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let params = vec![Vec::new(); statements.len()];
            self.run_statements_cancellable_batch(statements, params, max_rows, database, run)
                .await?
                .into_result()
        })
    }
    /// Ask the database server to stop the query described by `target`.
    fn cancel_query<'a>(&'a self, _target: CancelTarget) -> BoxFuture<'a, AppResult<()>> {
        Box::pin(async move { Ok(()) })
    }
    /// Run one read query and consume every row as a stream, calling `on_batch`
    /// with at most `batch_size` rows at a time. Returns `Ok(false)` when the
    /// callback cancels the read. No OFFSET is used, so this reads a table in a
    /// single pass.
    fn stream_table<'a>(
        &'a self,
        sql: &'a str,
        database: Option<String>,
        batch_size: usize,
        on_batch: &'a mut (dyn FnMut(Vec<Vec<serde_json::Value>>) -> AppResult<bool> + Send),
    ) -> BoxFuture<'a, AppResult<bool>>;
    /// Run one read query with an optional per-statement time limit. Dialects
    /// without a server-side timeout ignore the limit. Postgres applies it with
    /// SET LOCAL inside a transaction so it only affects this query.
    fn query_with_timeout<'a>(
        &'a self,
        sql: &'a str,
        max_rows: i64,
        database: Option<String>,
        _timeout_ms: Option<u64>,
    ) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let statements = [sql.to_string()];
            self.run_statements(&statements, max_rows, database).await
        })
    }
    /// Run every statement inside one transaction on a single connection.
    /// Rolls back and returns the failing statement index on any error.
    fn apply_transaction<'a>(
        &'a self,
        statements: &'a [String],
        database: Option<String>,
    ) -> BoxFuture<'a, Result<u64, TxError>>;
    /// Run a transaction while consuming statements from a channel. Savepoint
    /// messages let the caller opt into per-row error recovery (skip bad rows).
    fn stream_transaction<'a>(
        &'a self,
        input: tokio::sync::mpsc::Receiver<TxInput>,
        database: Option<String>,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>>;
    /// Run restore statements on one connection. `transactional` wraps the
    /// PostgreSQL/SQLite path in a single transaction; MySQL, SQL Server and
    /// ClickHouse run statement by statement without one. Savepoint messages
    /// opt into continue-on-error (the dialect ignores them when untransactional).
    fn stream_restore<'a>(
        &'a self,
        input: tokio::sync::mpsc::Receiver<TxInput>,
        database: Option<String>,
        transactional: bool,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>>;
    fn get_schema<'a>(
        &'a self,
        database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<SchemaSnapshot>>;
    fn get_er_schema<'a>(
        &'a self,
        database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<ErSchema>>;
    fn get_diff_schema<'a>(
        &'a self,
        _database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<SchemaData>> {
        Box::pin(async move {
            Err(AppError::Config(format!(
                "Schema compare is not supported for {}",
                self.dialect_name()
            )))
        })
    }
    fn list_databases<'a>(&'a self) -> BoxFuture<'a, AppResult<Vec<String>>>;
    fn list_tables<'a>(&'a self, database: &'a str) -> BoxFuture<'a, AppResult<Vec<TableInfo>>>;
    fn list_all_tables<'a>(&'a self) -> BoxFuture<'a, AppResult<Vec<DatabaseTable>>> {
        Box::pin(async move {
            let mut tables = Vec::new();
            for database in self.list_databases().await? {
                for table in self.list_tables(&database).await? {
                    tables.push(DatabaseTable {
                        database: database.clone(),
                        name: table.name,
                        kind: table.kind,
                    });
                }
            }
            Ok(tables)
        })
    }
    fn list_columns<'a>(
        &'a self,
        database: &'a str,
        table: &'a str,
    ) -> BoxFuture<'a, AppResult<Vec<ColumnInfo>>>;
}

pub(crate) fn all_tables_sql(dialect: Dialect) -> Option<&'static str> {
    match dialect {
        Dialect::Mysql => Some(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') \
             ORDER BY TABLE_SCHEMA, TABLE_NAME",
        ),
        Dialect::Postgres => Some(
            "SELECT table_catalog, table_name, table_type FROM information_schema.tables \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_catalog, table_name",
        ),
        Dialect::Clickhouse => Some(
            "SELECT database, name, engine FROM system.tables \
             WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') \
             ORDER BY database, name",
        ),
        _ => None,
    }
}

fn quote_mssql_identifier(value: &str) -> String {
    format!("[{}]", value.replace(']', "]]"))
}

fn quote_mssql_literal(value: &str) -> String {
    format!("N'{}'", value.replace('\'', "''"))
}

pub(crate) fn mssql_all_tables_sql(databases: &[String]) -> String {
    if databases.is_empty() {
        return "SELECT DB_NAME() AS database_name, TABLE_NAME, TABLE_TYPE \
                FROM INFORMATION_SCHEMA.TABLES \
                WHERE TABLE_SCHEMA = 'dbo' ORDER BY TABLE_NAME"
            .to_string();
    }

    databases
        .iter()
        .map(|database| {
            format!(
                "SELECT {} AS database_name, TABLE_NAME, TABLE_TYPE \
                 FROM {}.INFORMATION_SCHEMA.TABLES \
                 WHERE TABLE_SCHEMA = 'dbo'",
                quote_mssql_literal(database),
                quote_mssql_identifier(database)
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ")
}

pub struct ConnectedDriver {
    pub driver: Arc<dyn Driver>,
    /// Kept alive for as long as the driver/pool entry lives.
    pub tunnel: Option<SshTunnel>,
}

fn default_port(dialect: Dialect) -> u16 {
    match dialect {
        Dialect::Mysql => 3306,
        Dialect::Postgres => 5432,
        Dialect::Mssql => 1433,
        Dialect::Clickhouse => 8123,
        Dialect::Sqlite | Dialect::Mongodb => 0,
    }
}

pub async fn connect(
    input: &ConnectionInput,
    password: Option<&str>,
) -> AppResult<ConnectedDriver> {
    let mut endpoint = input.clone();
    let tunnel = match &input.ssh {
        Some(ssh_config) if input.dialect != Dialect::Sqlite => {
            let target_port = if input.port == 0 {
                default_port(input.dialect)
            } else {
                input.port
            };
            let tunnel = ssh::open_tunnel(
                ssh_config,
                &input.host,
                target_port,
                input.ssh_secret.as_deref(),
            )
            .await?;
            endpoint.host = "127.0.0.1".to_string();
            endpoint.port = tunnel.local_port();
            Some(tunnel)
        }
        _ => None,
    };

    let driver: Arc<dyn Driver> = match endpoint.dialect {
        Dialect::Mysql => Arc::new(mysql::MySqlDriver::connect(&endpoint, password).await?),
        Dialect::Postgres => {
            Arc::new(postgres::PostgresDriver::connect(&endpoint, password).await?)
        }
        Dialect::Sqlite => Arc::new(sqlite::SqliteDriver::connect(&endpoint, password).await?),
        Dialect::Mssql => Arc::new(mssql::MssqlDriver::connect(&endpoint, password).await?),
        Dialect::Clickhouse => {
            Arc::new(clickhouse::ClickHouseDriver::connect(&endpoint, password).await?)
        }
        other => {
            return Err(AppError::Config(format!(
                "{} dialekti MVP-də dəstəklənmir",
                other
            )))
        }
    };

    Ok(ConnectedDriver { driver, tunnel })
}

#[cfg(test)]
mod tests {
    use super::{int_json, uint_json, SslMode, MAX_SAFE_JSON_INT};
    use serde_json::Value;

    #[test]
    fn keeps_small_integers_as_json_numbers() {
        assert_eq!(int_json(0), Value::from(0));
        assert_eq!(int_json(MAX_SAFE_JSON_INT), Value::from(MAX_SAFE_JSON_INT));
        assert_eq!(
            int_json(-MAX_SAFE_JSON_INT),
            Value::from(-MAX_SAFE_JSON_INT)
        );
    }

    #[test]
    fn serializes_large_integers_as_exact_strings() {
        assert_eq!(
            int_json(MAX_SAFE_JSON_INT + 1),
            Value::String((MAX_SAFE_JSON_INT + 1).to_string())
        );
        assert_eq!(
            int_json(-MAX_SAFE_JSON_INT - 1),
            Value::String((-MAX_SAFE_JSON_INT - 1).to_string())
        );
        assert_eq!(
            uint_json(MAX_SAFE_JSON_INT as u64 + 1),
            Value::String((MAX_SAFE_JSON_INT as u64 + 1).to_string())
        );
    }

    #[test]
    fn old_connections_without_ssh_still_deserialize() {
        let input: super::ConnectionInput = serde_json::from_str(
            r#"{
                "name": "shop",
                "dialect": "postgres",
                "host": "db.example",
                "port": 5432,
                "username": "app"
            }"#,
        )
        .expect("valid connection input");

        assert!(input.ssh.is_none());
        assert!(input.ssh_secret.is_none());

        let meta: super::ConnectionMeta = serde_json::from_str(
            r#"{
                "id": "id",
                "name": "shop",
                "dialect": "postgres",
                "host": "db.example",
                "port": 5432,
                "username": "app"
            }"#,
        )
        .expect("valid connection meta");

        assert!(meta.ssh.is_none());
    }

    #[test]
    fn parses_ssl_mode_values_from_urls() {
        assert_eq!(SslMode::from_url_value("disable"), Some(SslMode::Disable));
        assert_eq!(SslMode::from_url_value("prefer"), Some(SslMode::Prefer));
        assert_eq!(SslMode::from_url_value("REQUIRED"), Some(SslMode::Require));
        assert_eq!(
            SslMode::from_url_value("verify_ca"),
            Some(SslMode::VerifyCa)
        );
        assert_eq!(
            SslMode::from_url_value("verify-full"),
            Some(SslMode::VerifyFull)
        );
        assert_eq!(
            SslMode::from_url_value("verify_identity"),
            Some(SslMode::VerifyFull)
        );
        assert_eq!(SslMode::from_url_value("allow"), Some(SslMode::Prefer));
        assert_eq!(SslMode::from_url_value("bogus"), None);
    }

    #[test]
    fn reads_ssl_mode_from_connection_urls() {
        assert_eq!(
            SslMode::from_url("postgresql://app@db/shop?sslmode=verify-full"),
            Some(SslMode::VerifyFull)
        );
        assert_eq!(
            SslMode::from_url("mysql://app@db/shop?ssl-mode=REQUIRED"),
            Some(SslMode::Require)
        );
        assert_eq!(
            SslMode::from_url(
                "postgresql://app@db/shop?application_name=DataForge&sslmode=verify-ca#ignored"
            ),
            Some(SslMode::VerifyCa)
        );
        assert_eq!(
            SslMode::from_url("postgresql://app@db/shop?other=1"),
            None
        );
        assert_eq!(SslMode::from_url("postgresql://app@db/shop"), None);
    }

    #[test]
    fn old_connections_without_ssl_fields_still_deserialize() {
        let input: super::ConnectionInput = serde_json::from_str(
            r#"{
                "name": "shop",
                "dialect": "mysql",
                "host": "db.example",
                "port": 3306,
                "username": "app"
            }"#,
        )
        .expect("valid connection input");

        assert!(input.ssl_mode.is_none());
        assert!(input.ssl_ca_path.is_none());

        let meta: super::ConnectionMeta = serde_json::from_str(
            r#"{
                "id": "id",
                "name": "shop",
                "dialect": "mysql",
                "host": "db.example",
                "port": 3306,
                "username": "app"
            }"#,
        )
        .expect("valid connection meta");

        assert!(meta.ssl_mode.is_none());
        assert!(meta.ssl_ca_path.is_none());
    }

    #[test]
    fn ssh_config_defaults_to_port_22_in_a_connection() {
        let input: super::ConnectionInput = serde_json::from_str(
            r#"{
                "name": "shop",
                "dialect": "mysql",
                "host": "db.example",
                "port": 3306,
                "username": "app",
                "ssh": {
                    "host": "bastion.example",
                    "username": "deploy",
                    "auth": "key",
                    "key_path": "~/.ssh/id_ed25519"
                }
            }"#,
        )
        .expect("valid connection input");

        let ssh = input.ssh.expect("ssh config");
        assert_eq!(ssh.port, 22);
        assert_eq!(ssh.auth, crate::core::ssh::SshAuth::Key);
    }
}

#[cfg(test)]
mod all_tables_tests {
    use super::{all_tables_sql, mssql_all_tables_sql, Dialect};

    #[test]
    fn mysql_lists_every_schema_in_one_query() {
        let sql = all_tables_sql(Dialect::Mysql).expect("mysql all tables SQL");
        assert!(sql.contains("information_schema.TABLES"));
        assert!(sql.contains("TABLE_SCHEMA"));
        assert!(sql.contains("TABLE_NAME"));
        assert!(sql.contains("TABLE_TYPE"));
    }

    #[test]
    fn postgres_reads_catalog_and_table_names() {
        let sql = all_tables_sql(Dialect::Postgres).expect("postgres all tables SQL");
        assert!(sql.contains("information_schema.tables"));
        assert!(sql.contains("table_catalog"));
        assert!(sql.contains("table_name"));
        assert!(sql.contains("table_type"));
    }

    #[test]
    fn clickhouse_reads_system_tables() {
        let sql = all_tables_sql(Dialect::Clickhouse).expect("clickhouse all tables SQL");
        assert!(sql.contains("system.tables"));
        assert!(sql.contains("database"));
        assert!(sql.contains("name"));
        assert!(sql.contains("engine"));
    }

    #[test]
    fn sqlite_has_no_cross_database_catalog_query() {
        assert!(all_tables_sql(Dialect::Sqlite).is_none());
    }

    #[test]
    fn mssql_unions_each_database_with_quoted_names() {
        let databases = vec!["shop".to_string(), "it's".to_string()];
        let sql = mssql_all_tables_sql(&databases);
        assert!(sql.contains("[shop].INFORMATION_SCHEMA.TABLES"));
        assert!(sql.contains("[it's].INFORMATION_SCHEMA.TABLES"));
        assert!(sql.contains("N'shop' AS database_name"));
        assert!(sql.contains("N'it''s' AS database_name"));
        assert!(sql.contains("UNION ALL"));
    }

    #[test]
    fn mssql_empty_database_list_uses_the_current_database() {
        let sql = mssql_all_tables_sql(&[]);
        assert!(sql.contains("DB_NAME()"));
        assert!(!sql.contains("UNION ALL"));
    }
}

#[cfg(test)]
mod batch_tests {
    use super::{
        BatchResult, QueryResult, StatementResult, MAX_RESULT_SETS, RESULT_LIMIT_NOTE,
    };
    use crate::error::AppError;
    use serde_json::Value;

    fn statement_result(sql: &str, rows: usize) -> StatementResult {
        let mut result = QueryResult::empty();
        result.columns = vec!["n".to_string()];
        result.rows = (0..rows)
            .map(|index| vec![Value::from(index as i64)])
            .collect();
        StatementResult::new(sql, result)
    }

    #[test]
    fn caps_full_result_sets_at_twenty_but_keeps_later_status() {
        let entries = (0..MAX_RESULT_SETS + 2)
            .map(|index| statement_result(&format!("SELECT {index}"), 1))
            .collect();
        let batch = BatchResult::success(entries);

        assert_eq!(batch.results.len(), MAX_RESULT_SETS + 2);
        assert_eq!(batch.results[MAX_RESULT_SETS - 1].result.rows.len(), 1);
        assert!(batch.results[MAX_RESULT_SETS - 1].note.is_none());
        assert_eq!(batch.results[MAX_RESULT_SETS].result.rows.len(), 0);
        assert_eq!(
            batch.results[MAX_RESULT_SETS].note.as_deref(),
            Some(RESULT_LIMIT_NOTE)
        );
        assert_eq!(
            batch.results[MAX_RESULT_SETS + 1].note.as_deref(),
            Some(RESULT_LIMIT_NOTE)
        );
        // The legacy top-level result is still the real last result set.
        assert_eq!(batch.last.rows.len(), 1);
        assert_eq!(
            batch.results[MAX_RESULT_SETS + 1].statement,
            format!("SELECT {}", MAX_RESULT_SETS + 1)
        );
    }

    #[test]
    fn error_keeps_results_before_the_failing_statement() {
        let batch = BatchResult::failure(
            vec![statement_result("SELECT 1", 1), statement_result("SELECT 2", 2)],
            2,
            "SELECT broken",
            AppError::Db("boom".to_string()),
        );

        assert_eq!(batch.results.len(), 2);
        assert_eq!(batch.results[0].result.rows.len(), 1);
        assert_eq!(batch.results[1].result.rows.len(), 2);
        assert_eq!(batch.last.rows.len(), 2);

        let error = batch.error.expect("error is recorded");
        assert_eq!(error.statement, 2);
        assert_eq!(error.sql, "SELECT broken");
        assert!(error.message.contains("boom"));
    }
}
