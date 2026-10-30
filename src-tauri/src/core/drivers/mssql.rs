use std::time::Instant;

use serde_json::{Number, Value};
use tiberius::time::chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use tiberius::{AuthMethod, Client, ColumnData, Config, FromSql, QueryItem, Row};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::core::drivers::{
    er, group_foreign_keys, int_json, mssql_all_tables_sql, BatchResult, BoundParam, BoxFuture,
    ColumnInfo, ConnectionInput, DatabaseTable, Dialect, Driver, ErColumn, ErSchema, ErTable,
    ForeignKeyRow, ParamValue, QueryResult, SchemaSnapshot, SchemaTable, StatementResult, TableInfo,
    TableKind, TxError, TxInput, TxRowError, TxStreamOutcome, ER_TABLE_LIMIT,
};
use crate::core::query_cancel::{mssql_cancel_sql, CancelTarget, RunCancel};
use crate::core::restore::truncate_preview;
use crate::error::{AppError, AppResult};

const DEFAULT_MAX_ROWS: i64 = 1000;
const MAX_ROWS: i64 = 100_000;
const DEFAULT_PORT: u16 = 1433;
const DEFAULT_DATABASE: &str = "master";

type MssqlClient = Client<Compat<TcpStream>>;

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


fn quote_lit(value: Option<&str>) -> String {
    match value {
        None => "NULL".to_string(),
        Some(value) => format!("N'{}'", value.replace('\'', "''")),
    }
}

fn has_word(sql: &str, word: &str) -> bool {
    sql.split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|part| part.eq_ignore_ascii_case(word))
}

fn apply_row_limit(sql: &str, limit: i64) -> String {
    let body = trim_statement(sql);
    if limit <= 0 {
        return body.to_string();
    }

    let keyword = first_keyword(body);
    if keyword != "SELECT" && keyword != "WITH" {
        return body.to_string();
    }

    let upper = body.to_ascii_uppercase();
    if has_word(&upper, "TOP") || upper.contains("OFFSET") || upper.contains("FETCH NEXT") {
        return body.to_string();
    }

    if keyword == "SELECT" {
        let after = &body["SELECT".len()..];
        let trimmed = after.trim_start();
        if trimmed
            .get(..8)
            .map(|head| head.eq_ignore_ascii_case("DISTINCT"))
            .unwrap_or(false)
        {
            return format!("SELECT DISTINCT TOP ({limit}){}", &trimmed[8..]);
        }
        return format!("SELECT TOP ({limit}){after}");
    }

    if has_word(&upper, "ORDER") {
        format!("{body}\nOFFSET 0 ROWS FETCH NEXT {limit} ROWS ONLY")
    } else {
        format!("{body}\nORDER BY (SELECT NULL)\nOFFSET 0 ROWS FETCH NEXT {limit} ROWS ONLY")
    }
}

fn db_error(error: impl std::fmt::Display) -> AppError {
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

fn datetime_value(data: &ColumnData<'static>) -> Option<String> {
    NaiveDateTime::from_sql(data)
        .ok()
        .flatten()
        .map(|value| value.format("%Y-%m-%dT%H:%M:%S%.f").to_string())
}

fn date_value(data: &ColumnData<'static>) -> Option<String> {
    NaiveDate::from_sql(data)
        .ok()
        .flatten()
        .map(|value| value.format("%Y-%m-%d").to_string())
}

fn time_value(data: &ColumnData<'static>) -> Option<String> {
    NaiveTime::from_sql(data)
        .ok()
        .flatten()
        .map(|value| value.format("%H:%M:%S%.f").to_string())
}

fn datetime_offset_value(data: &ColumnData<'static>) -> Option<String> {
    DateTime::<FixedOffset>::from_sql(data)
        .ok()
        .flatten()
        .map(|value| value.to_rfc3339())
}

fn cell_to_json(data: &ColumnData<'static>) -> Value {
    match data {
        ColumnData::U8(value) => value
            .as_ref()
            .map(|&value| int_json(value as i64))
            .unwrap_or(Value::Null),
        ColumnData::I16(value) => value
            .as_ref()
            .map(|&value| int_json(value as i64))
            .unwrap_or(Value::Null),
        ColumnData::I32(value) => value
            .as_ref()
            .map(|&value| int_json(value as i64))
            .unwrap_or(Value::Null),
        ColumnData::I64(value) => value
            .as_ref()
            .map(|&value| int_json(value))
            .unwrap_or(Value::Null),
        ColumnData::F32(value) => value
            .as_ref()
            .map(|&value| number(value as f64))
            .unwrap_or(Value::Null),
        ColumnData::F64(value) => value
            .as_ref()
            .map(|&value| number(value))
            .unwrap_or(Value::Null),
        ColumnData::Bit(value) => value
            .as_ref()
            .map(|&value| Value::Bool(value))
            .unwrap_or(Value::Null),
        ColumnData::String(value) => value
            .as_ref()
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Guid(value) => value
            .as_ref()
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Binary(value) => value
            .as_ref()
            .map(|value| Value::String(format!("0x{}", hex(value))))
            .unwrap_or(Value::Null),
        ColumnData::Numeric(value) => value
            .as_ref()
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Xml(value) => value
            .as_ref()
            .map(|value| Value::String(value.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            datetime_value(data).map(Value::String).unwrap_or(Value::Null)
        }
        ColumnData::Date(_) => date_value(data).map(Value::String).unwrap_or(Value::Null),
        ColumnData::Time(_) => time_value(data).map(Value::String).unwrap_or(Value::Null),
        ColumnData::DateTimeOffset(_) => datetime_offset_value(data)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}

fn row_to_json(row: &Row) -> Vec<Value> {
    row.cells().map(|(_, data)| cell_to_json(data)).collect()
}

fn build_result(
    columns: Vec<String>,
    fetched: Vec<Row>,
    limit: i64,
    truncated: bool,
    started: Instant,
    rows_affected: Option<u64>,
) -> QueryResult {
    let rows = fetched
        .into_iter()
        .take(limit as usize)
        .map(|row| row_to_json(&row))
        .collect::<Vec<_>>();

    QueryResult {
        columns,
        rows,
        rows_affected,
        elapsed_ms: started.elapsed().as_millis() as u64,
        truncated,
    }
}

async fn connect_client(config: &Config) -> AppResult<MssqlClient> {
    let tcp = TcpStream::connect(config.get_addr())
        .await
        .map_err(db_error)?;
    tcp.set_nodelay(true).map_err(db_error)?;
    Client::connect(config.clone(), tcp.compat_write())
        .await
        .map_err(db_error)
}

pub struct MssqlDriver {
    config: Config,
    database: String,
}

impl MssqlDriver {
    pub async fn connect(input: &ConnectionInput, password: Option<&str>) -> AppResult<Self> {
        let port = if input.port == 0 {
            DEFAULT_PORT
        } else {
            input.port
        };
        let database = input
            .database
            .clone()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_DATABASE.to_string());

        let mut config = Config::new();
        config.host(&input.host);
        config.port(port);
        config.database(&database);
        config.authentication(AuthMethod::sql_server(
            &input.username,
            password.unwrap_or_default(),
        ));
        if input.trust_cert.unwrap_or(false) {
            config.trust_cert();
        }
        // tiberius 0.13 defaults to a 30s per-round-trip limit; long queries are cancelled by the user instead.
        config.command_timeout(None);

        connect_client(&config).await?;
        Ok(Self { config, database })
    }

    async fn client_for(&self, database: &str) -> AppResult<MssqlClient> {
        let mut config = self.config.clone();
        if !database.is_empty() && database != self.database {
            config.database(database);
        }
        connect_client(&config).await
    }

    async fn tables_on(client: &mut MssqlClient, database: &str) -> AppResult<Vec<TableInfo>> {
        let sql = format!(
            "SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_CATALOG = {} AND TABLE_SCHEMA = 'dbo' ORDER BY TABLE_NAME",
            quote_lit(Some(database))
        );
        let rows = client
            .simple_query(sql)
            .await
            .map_err(db_error)?
            .into_first_result()
            .await
            .map_err(db_error)?;

        Ok(rows
            .iter()
            .map(|row| {
                let name = row
                    .try_get::<&str, _>(0)
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .to_string();
                let table_type = row
                    .try_get::<&str, _>(1)
                    .ok()
                    .flatten()
                    .unwrap_or_default();
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

    async fn columns_on(
        client: &mut MssqlClient,
        database: &str,
        table: &str,
    ) -> AppResult<Vec<ColumnInfo>> {
        let sql = format!(
            "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, \
                    CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE NULL END AS column_key \
             FROM INFORMATION_SCHEMA.COLUMNS c \
             LEFT JOIN ( \
               SELECT kcu.COLUMN_NAME \
               FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
               JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
                 ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
                AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA \
                AND tc.TABLE_NAME = kcu.TABLE_NAME \
               WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' \
                 AND tc.TABLE_SCHEMA = 'dbo' \
                 AND tc.TABLE_NAME = {} \
             ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME \
             WHERE c.TABLE_CATALOG = {} AND c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME = {} \
             ORDER BY c.ORDINAL_POSITION",
            quote_lit(Some(table)),
            quote_lit(Some(database)),
            quote_lit(Some(table))
        );
        let rows = client
            .simple_query(sql)
            .await
            .map_err(db_error)?
            .into_first_result()
            .await
            .map_err(db_error)?;

        Ok(rows
            .iter()
            .map(|row| {
                let name = row
                    .try_get::<&str, _>(0)
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .to_string();
                let data_type = row
                    .try_get::<&str, _>(1)
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .to_string();
                let nullable = row
                    .try_get::<&str, _>(2)
                    .ok()
                    .flatten()
                    .map(|value| value.eq_ignore_ascii_case("YES"))
                    .unwrap_or(true);
                let key = row
                    .try_get::<&str, _>(3)
                    .ok()
                    .flatten()
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);

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

impl Driver for MssqlDriver {
    fn dialect(&self) -> Dialect {
        Dialect::Mssql
    }

    fn dialect_name(&self) -> &'static str {
        "SQL Server (T-SQL)"
    }

    fn query<'a>(&'a self, sql: &'a str, max_rows: i64) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let mut client = self.client_for(&self.database).await?;
            execute_statement(&mut client, sql, &[], max_rows).await
        })
    }

    fn run_statements_batch<'a>(
        &'a self,
        statements: &'a [String],
        params: Vec<Vec<BoundParam>>,
        max_rows: i64,
        database: Option<String>,
    ) -> BoxFuture<'a, AppResult<BatchResult>> {
        Box::pin(async move {
            let requested = database
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| self.database.clone());
            let mut client = self.client_for(&requested).await?;
            execute_batch(&mut client, statements, &params, max_rows).await
        })
    }

    fn run_statements_cancellable_batch<'a>(
        &'a self,
        statements: &'a [String],
        params: Vec<Vec<BoundParam>>,
        max_rows: i64,
        database: Option<String>,
        run: &'a RunCancel,
    ) -> BoxFuture<'a, AppResult<BatchResult>> {
        Box::pin(async move {
            let requested = database
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| self.database.clone());
            let mut client = self.client_for(&requested).await?;

            let rows = client
                .simple_query("SELECT CAST(@@SPID AS INT) AS spid")
                .await
                .map_err(db_error)?
                .into_first_result()
                .await
                .map_err(db_error)?;
            let spid = rows
                .first()
                .and_then(|row| row.try_get::<i32, _>(0).ok().flatten())
                .ok_or_else(|| {
                    AppError::Db("SQL Server did not return @@SPID".to_string())
                })?;
            run.set_target(CancelTarget::Mssql(spid));
            if run.is_cancelled() {
                return Err(AppError::Cancelled("Query cancelled".to_string()));
            }

            execute_batch(&mut client, statements, &params, max_rows).await
        })
    }

    fn cancel_query<'a>(&'a self, target: CancelTarget) -> BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            let CancelTarget::Mssql(spid) = target else {
                return Ok(());
            };
            // KILL ends the session. The query runs on its own fresh client
            // (never a pool), so dropping the cancelled task discards it.
            let mut client = self.client_for(&self.database).await?;
            client
                .simple_query(mssql_cancel_sql(spid))
                .await
                .map_err(db_error)?
                .into_first_result()
                .await
                .map_err(db_error)?;
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
            let requested = database
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| self.database.clone());
            let mut client = self.client_for(&requested).await?;
            stream_rows(&mut client, sql, batch_size, on_batch).await
        })
    }

    fn apply_transaction<'a>(
        &'a self,
        statements: &'a [String],
        database: Option<String>,
    ) -> BoxFuture<'a, Result<u64, TxError>> {
        Box::pin(async move {
            let requested = database
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| self.database.clone());
            let mut client = self
                .client_for(&requested)
                .await
                .map_err(|error| TxError::new(None, error))?;
            run_transaction(&mut client, statements).await
        })
    }

    fn stream_transaction<'a>(
        &'a self,
        input: tokio::sync::mpsc::Receiver<TxInput>,
        database: Option<String>,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>> {
        Box::pin(async move {
            let requested = database
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| self.database.clone());
            let mut client = self
                .client_for(&requested)
                .await
                .map_err(|error| TxError::new(None, error))?;
            run_stream_transaction(&mut client, input).await
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

            let requested = database
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| self.database.clone());
            let mut client = self
                .client_for(&requested)
                .await
                .map_err(|error| TxError::new(None, error))?;
            run_stream_restore(&mut client, input).await
        })
    }

    fn get_schema<'a>(
        &'a self,
        database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<SchemaSnapshot>> {
        Box::pin(async move {
            let database = database
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&self.database)
                .to_string();
            if database.is_empty() {
                return Err(AppError::Config("sxem üçün baza seçilməyib".to_string()));
            }

            let mut client = self.client_for(&database).await?;
            let tables = Self::tables_on(&mut client, &database).await?;
            let mut snapshot = Vec::with_capacity(tables.len());
            for table in tables {
                let columns = Self::columns_on(&mut client, &database, &table.name).await?;
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

            let text = |row: &Row, index: usize| -> String {
                row.try_get::<&str, _>(index)
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .to_string()
            };

            let mut client = self.client_for(&database).await?;
            let rows = client
                .simple_query(er::mssql_tables_sql())
                .await
                .map_err(db_error)?
                .into_first_result()
                .await
                .map_err(db_error)?;
            let mut names: Vec<String> = rows.iter().map(|row| text(row, 0)).collect();
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

            let column_rows = client
                .simple_query(er::mssql_columns_sql())
                .await
                .map_err(db_error)?
                .into_first_result()
                .await
                .map_err(db_error)?;
            for row in column_rows.iter() {
                let table = text(row, 0);
                let Some(&position) = index.get(&table) else {
                    continue;
                };
                tables[position].columns.push(ErColumn {
                    name: text(row, 1),
                    data_type: text(row, 2),
                    nullable: row.try_get::<bool, _>(3).ok().flatten().unwrap_or(true),
                    pk: row.try_get::<i32, _>(4).ok().flatten().unwrap_or(0) != 0,
                });
            }

            let fk_rows = client
                .simple_query(er::mssql_foreign_keys_sql())
                .await
                .map_err(db_error)?
                .into_first_result()
                .await
                .map_err(db_error)?;
            let mut foreign_key_rows = Vec::new();
            for row in fk_rows.iter() {
                let from_table = text(row, 1);
                let to_table = text(row, 4);
                if !included.contains(&from_table) || !included.contains(&to_table) {
                    continue;
                }
                foreign_key_rows.push(ForeignKeyRow {
                    constraint_name: text(row, 0),
                    from_table,
                    from_column: text(row, 2),
                    from_position: row.try_get::<i32, _>(3).ok().flatten().unwrap_or(0) as i64,
                    to_table,
                    to_column: text(row, 5),
                    to_position: row.try_get::<i32, _>(6).ok().flatten().unwrap_or(0) as i64,
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

    fn list_databases<'a>(&'a self) -> BoxFuture<'a, AppResult<Vec<String>>> {
        Box::pin(async move {
            let mut client = self.client_for(&self.database).await?;
            let rows = client
                .simple_query(
                    "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name",
                )
                .await
                .map_err(db_error)?
                .into_first_result()
                .await
                .map_err(db_error)?;

            Ok(rows
                .iter()
                .filter_map(|row| {
                    row.try_get::<&str, _>(0)
                        .ok()
                        .flatten()
                        .map(str::to_string)
                })
                .collect())
        })
    }

    fn list_tables<'a>(&'a self, database: &'a str) -> BoxFuture<'a, AppResult<Vec<TableInfo>>> {
        Box::pin(async move {
            let database = if database.is_empty() {
                self.database.as_str()
            } else {
                database
            };
            let mut client = self.client_for(database).await?;
            Self::tables_on(&mut client, database).await
        })
    }

    fn list_all_tables<'a>(&'a self) -> BoxFuture<'a, AppResult<Vec<DatabaseTable>>> {
        Box::pin(async move {
            let databases = self.list_databases().await?;
            let sql = mssql_all_tables_sql(&databases);
            let mut client = self.client_for(&self.database).await?;
            let rows = client
                .simple_query(sql)
                .await
                .map_err(db_error)?
                .into_first_result()
                .await
                .map_err(db_error)?;

            Ok(rows
                .iter()
                .map(|row| {
                    let table_type = row
                        .try_get::<&str, _>(2)
                        .ok()
                        .flatten()
                        .unwrap_or_default();
                    DatabaseTable {
                        database: row
                            .try_get::<&str, _>(0)
                            .ok()
                            .flatten()
                            .unwrap_or_default()
                            .to_string(),
                        name: row
                            .try_get::<&str, _>(1)
                            .ok()
                            .flatten()
                            .unwrap_or_default()
                            .to_string(),
                        kind: if table_type.eq_ignore_ascii_case("VIEW") {
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
        Box::pin(async move {
            let database = if database.is_empty() {
                self.database.as_str()
            } else {
                database
            };
            let mut client = self.client_for(database).await?;
            Self::columns_on(&mut client, database, table).await
        })
    }
}

async fn run_stream_transaction(
    client: &mut MssqlClient,
    mut input: tokio::sync::mpsc::Receiver<TxInput>,
) -> Result<TxStreamOutcome, TxError> {
    client
        .execute("BEGIN TRANSACTION", &[])
        .await
        .map_err(|error| TxError::new(None, db_error(error)))?;
    let mut outcome = TxStreamOutcome::default();
    let mut savepoints: Vec<String> = Vec::new();

    while let Some(item) = input.recv().await {
        match item {
            TxInput::Savepoint(name) => {
                let sql = format!("SAVE TRANSACTION {name}");
                client
                    .execute(sql.as_str(), &[])
                    .await
                    .map_err(|error| TxError::new(None, db_error(error)))?;
                savepoints.push(name);
            }
            TxInput::ReleaseSavepoint(_name) => {
                savepoints.pop();
            }
            TxInput::Sql { sql, row } => {
                let statement = trim_statement(&sql);
                if statement.is_empty() {
                    continue;
                }
                match client.execute(statement, &[]).await {
                    Ok(result) => outcome.rows_affected += result.total(),
                    Err(error) => {
                        let message = error.to_string();
                        if let Some(name) = savepoints.last().cloned() {
                            let rollback = format!("ROLLBACK TRANSACTION {name}");
                            let _ = client.execute(rollback.as_str(), &[]).await;
                            if let Some(row) = row {
                                outcome.errors.push(TxRowError {
                                    row,
                                    error: message,
                                    statement: None,
                                });
                            }
                        } else {
                            let _ = client.execute("ROLLBACK TRANSACTION", &[]).await;
                            return Err(TxError::new(
                                row.map(|value| value as usize),
                                db_error(error),
                            )
                            .with_statement(statement));
                        }
                    }
                }
            }
            TxInput::CopyStart { sql, row } => {
                return Err(TxError::new(
                    row.map(|value| value as usize),
                    AppError::Config(
                        "COPY ... FROM stdin is only supported when restoring into PostgreSQL"
                            .to_string(),
                    ),
                )
                .with_statement(&sql));
            }
            TxInput::CopyData(_) | TxInput::CopyEnd => {}
            TxInput::Rollback => {
                let _ = client.execute("ROLLBACK TRANSACTION", &[]).await;
                outcome.cancelled = true;
                return Ok(outcome);
            }
        }
    }

    client
        .execute("COMMIT TRANSACTION", &[])
        .await
        .map_err(|error| TxError::new(None, db_error(error)))?;
    Ok(outcome)
}


async fn run_stream_restore(
    client: &mut MssqlClient,
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
                match client.execute(statement, &[]).await {
                    Ok(result) => outcome.rows_affected += result.total(),
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
            TxInput::CopyStart { sql, row } => {
                return Err(TxError::new(
                    row.map(|value| value as usize),
                    AppError::Config(
                        "COPY ... FROM stdin is only supported when restoring into PostgreSQL"
                            .to_string(),
                    ),
                )
                .with_statement(&sql));
            }
            TxInput::CopyData(_) | TxInput::CopyEnd => {}
            TxInput::Rollback => {
                outcome.cancelled = true;
                return Ok(outcome);
            }
        }
    }

    Ok(outcome)
}

async fn run_transaction(
    client: &mut MssqlClient,
    statements: &[String],
) -> Result<u64, TxError> {
    client
        .execute("BEGIN TRANSACTION", &[])
        .await
        .map_err(|error| TxError::new(None, db_error(error)))?;

    let mut affected = 0u64;
    for (index, statement) in statements.iter().enumerate() {
        let statement = trim_statement(statement);
        if statement.is_empty() {
            continue;
        }
        match client.execute(statement, &[]).await {
            Ok(result) => affected += result.total(),
            Err(error) => {
                let _ = client.execute("ROLLBACK TRANSACTION", &[]).await;
                return Err(TxError::new(Some(index), db_error(error)));
            }
        }
    }

    client
        .execute("COMMIT TRANSACTION", &[])
        .await
        .map_err(|error| TxError::new(None, db_error(error)))?;
    Ok(affected)
}

// ColumnData is not ToSql; owned std values are.
fn bind_values(params: &[BoundParam]) -> Vec<Box<dyn tiberius::ToSql>> {
    params
        .iter()
        .map(|param| -> Box<dyn tiberius::ToSql> {
            match &param.value {
                ParamValue::Text(value) => Box::new(value.clone()),
                ParamValue::Number(value) => {
                    if let Ok(integer) = value.parse::<i64>() {
                        Box::new(integer)
                    } else if let Ok(float) = value.parse::<f64>() {
                        Box::new(float)
                    } else {
                        Box::new(value.clone())
                    }
                }
                ParamValue::Boolean(value) => Box::new(*value),
                ParamValue::Null => Box::new(None::<String>),
            }
        })
        .collect()
}

async fn execute_batch(
    client: &mut MssqlClient,
    statements: &[String],
    params: &[Vec<BoundParam>],
    max_rows: i64,
) -> AppResult<BatchResult> {
    if statements.is_empty() {
        return Err(AppError::Config("SQL boşdur".to_string()));
    }

    let mut results = Vec::new();
    for (index, statement) in statements.iter().enumerate() {
        let body = trim_statement(statement);
        if body.is_empty() {
            continue;
        }

        let statement_params = params.get(index).map(Vec::as_slice).unwrap_or(&[]);
        match execute_statement(client, body, statement_params, max_rows).await {
            Ok(result) => results.push(StatementResult::new(statement, result)),
            Err(error) => {
                return Ok(BatchResult::failure(results, index, statement, error));
            }
        }
    }

    Ok(BatchResult::success(results))
}

async fn execute_statement(
    client: &mut MssqlClient,
    sql: &str,
    params: &[BoundParam],
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
        "SELECT" | "WITH" | "EXEC" | "EXECUTE" | "VALUES" | "TABLE"
    );

    let bindings = bind_values(params);
    let refs: Vec<&dyn tiberius::ToSql> = bindings
        .iter()
        .map(|value| value.as_ref())
        .collect();

    if !row_returning {
        let result = client.execute(body, &refs).await.map_err(db_error)?;
        return Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: Some(result.total()),
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated: false,
        });
    }

    let limited = apply_row_limit(body, limit);
    let mut stream = client
        .query(&limited, &refs)
        .await
        .map_err(db_error)?;
    let columns = stream
        .columns()
        .await
        .map_err(db_error)?
        .map(|columns| {
            columns
                .iter()
                .map(|column| column.name().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut fetched: Vec<Row> = Vec::new();
    while let Some(item) = stream_next(&mut stream).await? {
        if let QueryItem::Row(row) = item {
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
    client: &mut MssqlClient,
    sql: &str,
    batch_size: usize,
    on_batch: &mut (dyn FnMut(Vec<Vec<Value>>) -> AppResult<bool> + Send),
) -> AppResult<bool> {
    let body = trim_statement(sql);
    let mut stream = client.simple_query(body).await.map_err(db_error)?;
    let batch_size = batch_size.max(1);
    let mut batch: Vec<Vec<Value>> = Vec::with_capacity(batch_size);

    while let Some(item) = stream_next(&mut stream).await? {
        if let QueryItem::Row(row) = item {
            batch.push(row_to_json(&row));
            if batch.len() >= batch_size {
                if !on_batch(std::mem::take(&mut batch))? {
                    return Ok(false);
                }
                batch = Vec::with_capacity(batch_size);
            }
        }
    }

    if !batch.is_empty() && !on_batch(batch)? {
        return Ok(false);
    }
    Ok(true)
}

async fn stream_next(
    stream: &mut tiberius::QueryStream<'_>,
) -> AppResult<Option<QueryItem>> {
    use futures::StreamExt;

    match stream.next().await {
        Some(Ok(item)) => Ok(Some(item)),
        Some(Err(error)) => Err(db_error(error)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{apply_row_limit, cell_to_json, hex, quote_lit};
    use serde_json::Value;
    use std::borrow::Cow;
    use tiberius::numeric::Numeric;
    use tiberius::ColumnData;
    use uuid::Uuid;

    #[test]
    fn literals_are_n_prefixed_and_single_quotes_are_doubled() {
        assert_eq!(quote_lit(None), "NULL");
        assert_eq!(quote_lit(Some("O'Brien")), "N'O''Brien'");
        assert_eq!(quote_lit(Some(r"a\b")), r"N'a\b'");
    }

    #[test]
    fn selects_get_a_top_limit() {
        assert_eq!(
            apply_row_limit("SELECT * FROM users", 100),
            "SELECT TOP (100) * FROM users"
        );
        assert_eq!(
            apply_row_limit("select distinct name from users", 5),
            "SELECT DISTINCT TOP (5) name from users"
        );
    }

    #[test]
    fn ctes_get_offset_fetch_paging() {
        assert_eq!(
            apply_row_limit("WITH x AS (SELECT 1 AS n) SELECT * FROM x", 10),
            "WITH x AS (SELECT 1 AS n) SELECT * FROM x\nORDER BY (SELECT NULL)\nOFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY"
        );
        assert_eq!(
            apply_row_limit("WITH x AS (SELECT 1 AS n) SELECT * FROM x ORDER BY n", 10),
            "WITH x AS (SELECT 1 AS n) SELECT * FROM x ORDER BY n\nOFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY"
        );
    }

    #[test]
    fn explicit_paging_and_non_selects_are_left_alone() {
        assert_eq!(
            apply_row_limit("SELECT TOP (5) * FROM users", 100),
            "SELECT TOP (5) * FROM users"
        );
        assert_eq!(
            apply_row_limit("SELECT * FROM users OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY", 100),
            "SELECT * FROM users OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY"
        );
        assert_eq!(
            apply_row_limit("UPDATE users SET name = N'x'", 100),
            "UPDATE users SET name = N'x'"
        );
    }

    #[test]
    fn maps_common_mssql_values() {
        assert_eq!(cell_to_json(&ColumnData::Bit(Some(true))), Value::Bool(true));
        assert_eq!(
            cell_to_json(&ColumnData::I64(Some(9_007_199_254_740_992))),
            Value::String("9007199254740992".to_string())
        );
        assert_eq!(
            cell_to_json(&ColumnData::String(Some(Cow::Borrowed("hello")))),
            Value::String("hello".to_string())
        );
        assert_eq!(
            cell_to_json(&ColumnData::Numeric(Some(Numeric::new_with_scale(12345, 2)))),
            Value::String("123.45".to_string())
        );
        assert_eq!(
            cell_to_json(&ColumnData::Binary(Some(Cow::Owned(vec![0xde_u8, 0xad])))),
            Value::String("0xdead".to_string())
        );
        assert_eq!(
            cell_to_json(&ColumnData::Guid(Some(Uuid::nil()))),
            Value::String("00000000-0000-0000-0000-000000000000".to_string())
        );
        assert_eq!(cell_to_json(&ColumnData::I32(None)), Value::Null);
        assert_eq!(hex(&[0xde, 0xad]), "dead");
    }
}
