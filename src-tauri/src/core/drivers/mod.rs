pub mod mysql;
pub mod postgres;
pub mod sqlite;

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Mysql,
    Postgres,
    Sqlite,
    Mssql,
    Mongodb,
}

impl Dialect {
    pub fn as_str(self) -> &'static str {
        match self {
            Dialect::Mysql => "mysql",
            Dialect::Postgres => "postgres",
            Dialect::Sqlite => "sqlite",
            Dialect::Mssql => "mssql",
            Dialect::Mongodb => "mongodb",
        }
    }
}

impl fmt::Display for Dialect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
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
    fn get_schema<'a>(
        &'a self,
        database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<SchemaSnapshot>>;
    fn list_databases<'a>(&'a self) -> BoxFuture<'a, AppResult<Vec<String>>>;
    fn list_tables<'a>(&'a self, database: &'a str) -> BoxFuture<'a, AppResult<Vec<TableInfo>>>;
    fn list_columns<'a>(
        &'a self,
        database: &'a str,
        table: &'a str,
    ) -> BoxFuture<'a, AppResult<Vec<ColumnInfo>>>;
}

pub async fn connect(
    input: &ConnectionInput,
    password: Option<&str>,
) -> AppResult<Arc<dyn Driver>> {
    match input.dialect {
        Dialect::Mysql => Ok(Arc::new(
            mysql::MySqlDriver::connect(input, password).await?,
        )),
        Dialect::Postgres => Ok(Arc::new(
            postgres::PostgresDriver::connect(input, password).await?,
        )),
        Dialect::Sqlite => Ok(Arc::new(
            sqlite::SqliteDriver::connect(input, password).await?,
        )),
        other => Err(AppError::Config(format!(
            "{} dialekti MVP-də dəstəklənmir",
            other
        ))),
    }
}
