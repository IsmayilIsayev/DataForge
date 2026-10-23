use std::time::Instant;

use serde_json::{Number, Value};
use tiberius::time::chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use tiberius::{AuthMethod, Client, ColumnData, Config, FromSql, QueryItem, Row};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::core::drivers::{
    int_json, BoxFuture, ColumnInfo, ConnectionInput, Dialect, Driver, QueryResult,
    SchemaSnapshot, SchemaTable, TableInfo, TableKind,
};
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

#[allow(dead_code)]
fn quote_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
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
            execute_statement(&mut client, sql, max_rows).await
        })
    }

    fn run_statements<'a>(
        &'a self,
        statements: &'a [String],
        max_rows: i64,
        database: Option<String>,
    ) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let requested = database
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| self.database.clone());
            let mut client = self.client_for(&requested).await?;
            execute_batch(&mut client, statements, max_rows).await
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

async fn execute_batch(
    client: &mut MssqlClient,
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

        client.execute(statement, &[]).await.map_err(db_error)?;
    }

    execute_statement(client, last, max_rows).await
}

async fn execute_statement(
    client: &mut MssqlClient,
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
        "SELECT" | "WITH" | "EXEC" | "EXECUTE" | "VALUES" | "TABLE"
    );

    if !row_returning {
        let result = client.execute(body, &[]).await.map_err(db_error)?;
        return Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: Some(result.total()),
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated: false,
        });
    }

    let limited = apply_row_limit(body, limit);
    let mut stream = client.simple_query(limited).await.map_err(db_error)?;
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
    use super::{apply_row_limit, cell_to_json, hex, quote_ident, quote_lit};
    use serde_json::Value;
    use std::borrow::Cow;
    use tiberius::numeric::Numeric;
    use tiberius::ColumnData;
    use uuid::Uuid;

    #[test]
    fn brackets_are_quoted_and_doubled() {
        assert_eq!(quote_ident("users"), "[users]");
        assert_eq!(quote_ident("we]ird"), "[we]]ird]");
    }

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
