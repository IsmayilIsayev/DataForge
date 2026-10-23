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
}

impl TxError {
    pub fn new(statement: Option<usize>, error: AppError) -> Self {
        Self { statement, error }
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

pub trait Driver: Send + Sync {
    fn dialect(&self) -> Dialect;
    fn dialect_name(&self) -> &'static str;
    fn query<'a>(&'a self, sql: &'a str, max_rows: i64) -> BoxFuture<'a, AppResult<QueryResult>>;
    fn run_statements<'a>(
        &'a self,
        statements: &'a [String],
        max_rows: i64,
        database: Option<String>,
    ) -> BoxFuture<'a, AppResult<QueryResult>>;
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
    fn list_columns<'a>(
        &'a self,
        database: &'a str,
        table: &'a str,
    ) -> BoxFuture<'a, AppResult<Vec<ColumnInfo>>>;
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
