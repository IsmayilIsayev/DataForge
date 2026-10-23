use std::collections::HashMap;

use futures::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, State};

use crate::core::drivers::{ColumnInfo, Dialect, Driver, QueryResult, SchemaTable};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MAX_TABLES: usize = 100;
const ROWS_PER_TABLE: i64 = 3;
const MAX_HITS: usize = 200;
/// How many per-table data queries run at once. Kept at/under the smallest
/// driver pool (Postgres uses 5) so a remote DB such as Neon is never starved,
/// while still overlapping round-trips for a big speed-up over serial scanning.
const CONCURRENCY: usize = 4;
const STATEMENT_TIMEOUT_MS: u64 = 5_000;
const ESTIMATE_ROWS: i64 = 100_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SearchMode {
    Contains,
    StartsWith,
    Exact,
}

impl SearchMode {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "starts_with" | "starts with" | "startswith" => Self::StartsWith,
            "exact" => Self::Exact,
            _ => Self::Contains,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct SearchHit {
    /// "table" | "column" | "data"
    pub kind: String,
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Clone, Serialize)]
struct FindProgress {
    id: String,
    done: u64,
    total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    table: Option<String>,
    hits: Vec<SearchHit>,
    skipped: bool,
}

#[derive(Serialize)]
pub struct FindSummary {
    pub hits: Vec<SearchHit>,
    pub skipped: Vec<String>,
    pub cancelled: bool,
    pub done: u64,
    pub total: u64,
}

#[derive(Clone, Debug)]
struct SearchJob {
    table: String,
    sql: String,
}

fn quote_ident(dialect: Dialect, name: &str) -> String {
    match dialect {
        Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        Dialect::Mssql => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn table_ref(dialect: Dialect, database: &str, table: &str) -> String {
    match dialect {
        Dialect::Mysql => format!(
            "{}.{}",
            quote_ident(dialect, database),
            quote_ident(dialect, table)
        ),
        Dialect::Mssql => format!(
            "{}.{}.{}",
            quote_ident(dialect, database),
            quote_ident(dialect, "dbo"),
            quote_ident(dialect, table)
        ),
        _ => quote_ident(dialect, table),
    }
}

fn type_name(data_type: &str) -> String {
    data_type.trim().to_ascii_lowercase()
}

fn has_type_token(data_type: &str, names: &[&str]) -> bool {
    data_type
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|token| names.contains(&token))
}

fn is_binary_type(data_type: &str) -> bool {
    data_type.contains("binary")
        || data_type.contains("blob")
        || data_type == "bytea"
        || data_type == "image"
}

fn is_json_type(data_type: &str) -> bool {
    data_type == "json" || data_type == "jsonb" || data_type.starts_with("json")
}

fn is_uuid_type(dialect: Dialect, data_type: &str) -> bool {
    match dialect {
        Dialect::Postgres => data_type == "uuid",
        Dialect::Mssql => data_type == "uniqueidentifier",
        Dialect::Mysql | Dialect::Sqlite | Dialect::Mongodb => data_type.contains("uuid"),
    }
}

fn is_user_defined_type(data_type: &str) -> bool {
    data_type == "user-defined" || data_type == "user_defined"
}

fn is_text_type(dialect: Dialect, data_type: &str) -> bool {
    match dialect {
        Dialect::Mysql => {
            data_type.contains("char")
                || data_type.contains("text")
                || data_type.starts_with("enum")
                || data_type.starts_with("set")
        }
        Dialect::Postgres => {
            data_type.contains("char")
                || data_type == "text"
                || data_type == "citext"
                || data_type == "name"
        }
        Dialect::Mssql => {
            data_type.contains("char")
                || data_type.contains("text")
                || data_type == "xml"
                || data_type == "string"
        }
        Dialect::Sqlite | Dialect::Mongodb => {
            data_type.contains("char")
                || data_type.contains("text")
                || data_type.contains("clob")
                || data_type.contains("string")
        }
    }
}

fn is_numeric_type(data_type: &str) -> bool {
    has_type_token(
        data_type,
        &[
            "tinyint",
            "smallint",
            "mediumint",
            "int",
            "integer",
            "bigint",
            "decimal",
            "numeric",
            "float",
            "double",
            "real",
            "money",
            "smallmoney",
            "number",
            "serial",
            "bigserial",
            "smallserial",
        ],
    )
}

fn numeric_literal(term: &str) -> Option<&str> {
    let term = term.trim();
    if term.is_empty() {
        return None;
    }
    let integer = term.parse::<i64>().is_ok();
    let float = term
        .parse::<f64>()
        .map(|value| value.is_finite())
        .unwrap_or(false);
    (integer || float).then_some(term)
}

fn has_alphanumeric(term: &str) -> bool {
    term.chars().any(char::is_alphanumeric)
}

fn looks_like_uuid(term: &str) -> bool {
    let mut has_hex = false;
    for character in term.trim().chars() {
        if character.is_ascii_hexdigit() {
            has_hex = true;
        } else if character != '-' {
            return false;
        }
    }
    has_hex
}

fn searchable_columns<'a>(
    dialect: Dialect,
    columns: &'a [ColumnInfo],
    term: &str,
    mode: SearchMode,
) -> Vec<&'a ColumnInfo> {
    columns
        .iter()
        .filter(|column| {
            let data_type = type_name(&column.data_type);
            if data_type.is_empty() || is_binary_type(&data_type) {
                return false;
            }
            if is_json_type(&data_type) {
                return dialect != Dialect::Mysql && has_alphanumeric(term);
            }
            if is_uuid_type(dialect, &data_type) {
                return looks_like_uuid(term);
            }
            if dialect == Dialect::Postgres && is_user_defined_type(&data_type) {
                return true;
            }
            if is_text_type(dialect, &data_type) {
                return true;
            }
            mode == SearchMode::Exact
                && is_numeric_type(&data_type)
                && numeric_literal(term).is_some()
        })
        .collect()
}

fn postgres_needs_cast(data_type: &str) -> bool {
    is_uuid_type(Dialect::Postgres, data_type)
        || is_json_type(data_type)
        || is_user_defined_type(data_type)
}

fn column_expression(dialect: Dialect, column: &ColumnInfo) -> String {
    let data_type = type_name(&column.data_type);
    let quoted = quote_ident(dialect, &column.name);
    match dialect {
        Dialect::Postgres if postgres_needs_cast(&data_type) => format!("{quoted}::text"),
        Dialect::Mssql if is_uuid_type(Dialect::Mssql, &data_type) => {
            format!("CAST({quoted} AS nvarchar(36))")
        }
        _ => quoted,
    }
}

fn select_expression(dialect: Dialect, column: &ColumnInfo) -> String {
    let expression = column_expression(dialect, column);
    let quoted = quote_ident(dialect, &column.name);
    if expression == quoted {
        quoted
    } else {
        format!("{expression} AS {quoted}")
    }
}

fn string_literal(dialect: Dialect, term: &str) -> String {
    let escaped = match dialect {
        Dialect::Mysql | Dialect::Postgres => {
            term.replace('\\', "\\\\").replace('\'', "''")
        }
        _ => term.replace('\'', "''"),
    };
    match dialect {
        Dialect::Postgres => format!("E'{escaped}'"),
        Dialect::Mssql => format!("N'{escaped}'"),
        _ => format!("'{escaped}'"),
    }
}

fn like_literal(dialect: Dialect, term: &str, mode: SearchMode) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
        .replace('\'', "''");
    let body = match mode {
        SearchMode::StartsWith => format!("{escaped}%"),
        _ => format!("%{escaped}%"),
    };
    if dialect == Dialect::Mssql {
        format!("N'{body}'")
    } else {
        format!("'{body}'")
    }
}

fn like_escape_clause(dialect: Dialect) -> &'static str {
    // SQLite and SQL Server only honour backslash as the LIKE escape character
    // when an explicit ESCAPE clause is present. MySQL/Postgres use it by default.
    if dialect == Dialect::Sqlite || dialect == Dialect::Mssql {
        " ESCAPE '\\'"
    } else {
        ""
    }
}

fn build_predicate(
    dialect: Dialect,
    column: &ColumnInfo,
    term: &str,
    mode: SearchMode,
    case_insensitive: bool,
) -> String {
    let data_type = type_name(&column.data_type);
    let quoted = quote_ident(dialect, &column.name);

    if mode == SearchMode::Exact && is_numeric_type(&data_type) {
        if let Some(number) = numeric_literal(term) {
            return format!("{quoted} = {number}");
        }
    }

    let expression = column_expression(dialect, column);
    if mode == SearchMode::Exact {
        return format!("{expression} = {}", string_literal(dialect, term));
    }

    let operator = if case_insensitive && dialect == Dialect::Postgres {
        "ILIKE"
    } else {
        "LIKE"
    };
    format!(
        "{expression} {operator} {}{}",
        like_literal(dialect, term, mode),
        like_escape_clause(dialect)
    )
}

fn build_table_sql(
    dialect: Dialect,
    database: &str,
    table: &SchemaTable,
    term: &str,
    mode: SearchMode,
    case_insensitive: bool,
    with_timeout: bool,
) -> Option<String> {
    let columns = searchable_columns(dialect, &table.columns, term, mode);
    if columns.is_empty() {
        return None;
    }

    let predicates: Vec<String> = columns
        .iter()
        .map(|column| build_predicate(dialect, column, term, mode, case_insensitive))
        .collect();
    let select_columns: Vec<String> = columns
        .iter()
        .map(|column| select_expression(dialect, column))
        .collect();
    let hint = if with_timeout && dialect == Dialect::Mysql {
        format!("/*+ MAX_EXECUTION_TIME({STATEMENT_TIMEOUT_MS}) */ ")
    } else {
        String::new()
    };

    Some(format!(
        "SELECT {hint}{} FROM {} WHERE {}",
        select_columns.join(", "),
        table_ref(dialect, database, &table.name),
        predicates.join(" OR "),
    ))
}

fn order_jobs(jobs: &mut [SearchJob], estimates: &HashMap<String, i64>) {
    jobs.sort_by_key(|job| {
        estimates
            .get(&job.table)
            .copied()
            .unwrap_or(i64::MAX)
            .max(0)
    });
}

fn estimate_sql(dialect: Dialect, database: &str) -> Option<String> {
    match dialect {
        Dialect::Postgres => Some(
            "SELECT c.relname, GREATEST(c.reltuples, 0)::bigint \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'p', 'm') \
               AND (n.nspname = current_schema() OR n.nspname = 'public')"
                .to_string(),
        ),
        Dialect::Mysql => Some(format!(
            "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = {}",
            string_literal(dialect, database)
        )),
        Dialect::Mssql => Some(
            "SELECT t.name, SUM(p.rows) \
             FROM sys.partitions p \
             JOIN sys.tables t ON t.object_id = p.object_id \
             WHERE p.index_id IN (0, 1) AND SCHEMA_NAME(t.schema_id) = 'dbo' \
             GROUP BY t.name"
                .to_string(),
        ),
        Dialect::Sqlite | Dialect::Mongodb => None,
    }
}

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}

async fn fetch_estimates(
    driver: &dyn Driver,
    dialect: Dialect,
    database: &str,
) -> HashMap<String, i64> {
    let Some(sql) = estimate_sql(dialect, database) else {
        return HashMap::new();
    };
    let Ok(result) = driver
        .run_statements(&[sql], ESTIMATE_ROWS, Some(database.to_string()))
        .await
    else {
        return HashMap::new();
    };

    result
        .rows
        .iter()
        .filter_map(|row| {
            let name = row.first()?.as_str()?.to_string();
            let estimate = row.get(1).and_then(json_i64)?;
            Some((name, estimate))
        })
        .collect()
}

async fn is_cancelled(state: &AppState, id: &str) -> bool {
    state.cancelled.read().await.contains(id)
}

async fn clear_cancelled(state: &AppState, id: &str) {
    state.cancelled.write().await.remove(id);
}

fn is_timeout_error(error: &AppError) -> bool {
    let AppError::Db(message) = error else {
        return false;
    };
    let message = message.to_ascii_lowercase();
    message.contains("statement timeout")
        || message.contains("max_execution_time")
        || message.contains("maximum statement execution time")
        || message.contains("query execution was interrupted")
}

fn cell_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn hits_from_result(table: &str, result: &QueryResult, lower: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    for row in &result.rows {
        let mut best: Option<(usize, String)> = None;
        let mut fallback: Option<(usize, String)> = None;
        for (index, cell) in row.iter().enumerate() {
            if let Some(text) = cell_text(cell) {
                if fallback.is_none() && !text.is_empty() {
                    fallback = Some((index, text.clone()));
                }
                if text.to_lowercase().contains(lower) {
                    best = Some((index, text));
                    break;
                }
            }
        }
        if let Some((index, text)) = best.or(fallback) {
            let mut snippet = text;
            if snippet.chars().count() > 120 {
                snippet = snippet.chars().take(120).collect::<String>() + "…";
            }
            hits.push(SearchHit {
                kind: "data".into(),
                table: table.to_string(),
                column: result.columns.get(index).cloned(),
                value: Some(snippet),
            });
        }
    }
    hits
}

#[tauri::command(rename_all = "snake_case")]
pub async fn find_in_database(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    term: String,
    case_insensitive: bool,
    include_data: bool,
    only_table: Option<String>,
    mode: Option<String>,
    find_id: Option<String>,
    no_timeout: Option<bool>,
) -> AppResult<FindSummary> {
    let needle = term.trim().to_string();
    let id = find_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if needle.is_empty() {
        return Ok(FindSummary {
            hits: Vec::new(),
            skipped: Vec::new(),
            cancelled: false,
            done: 0,
            total: 0,
        });
    }

    let mode = SearchMode::parse(mode.as_deref().unwrap_or("contains"));
    let no_timeout = no_timeout.unwrap_or(false);
    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect();
    let schema = driver.get_schema(Some(&database)).await?;

    // Unicode-aware lowercasing so non-ASCII letters (ə, ı, ş, ç, ğ, ö, ü, …)
    // match regardless of case — ASCII-only folding silently dropped them.
    let lower = needle.to_lowercase();

    let tables: Vec<_> = match &only_table {
        Some(name) => schema.tables.iter().filter(|t| &t.name == name).collect(),
        None => schema.tables.iter().collect(),
    };

    let mut hits: Vec<SearchHit> = Vec::new();
    for table in &tables {
        if table.name.to_lowercase().contains(&lower) {
            hits.push(SearchHit {
                kind: "table".into(),
                table: table.name.clone(),
                column: None,
                value: None,
            });
        }
        for column in &table.columns {
            if column.name.to_lowercase().contains(&lower) {
                hits.push(SearchHit {
                    kind: "column".into(),
                    table: table.name.clone(),
                    column: Some(column.name.clone()),
                    value: None,
                });
            }
        }
    }

    if !include_data {
        return Ok(FindSummary {
            hits,
            skipped: Vec::new(),
            cancelled: false,
            done: 0,
            total: 0,
        });
    }

    let estimates = fetch_estimates(driver.as_ref(), dialect, &database).await;
    let mut jobs: Vec<SearchJob> = tables
        .iter()
        .take(MAX_TABLES)
        .filter_map(|table| {
            build_table_sql(
                dialect,
                &database,
                table,
                &needle,
                mode,
                case_insensitive,
                !no_timeout,
            )
            .map(|sql| SearchJob {
                table: table.name.clone(),
                sql,
            })
        })
        .collect();
    order_jobs(&mut jobs, &estimates);
    let total = jobs.len() as u64;

    let structure_hits = hits.clone();
    let _ = app.emit(
        "find:progress",
        FindProgress {
            id: id.clone(),
            done: 0,
            total,
            table: None,
            hits: structure_hits,
            skipped: false,
        },
    );

    let mut done = 0u64;
    let mut data_hits = 0usize;
    let mut skipped = Vec::new();
    let mut cancelled = false;
    let mut first_error: Option<AppError> = None;

    let mut results = stream::iter(jobs.into_iter().map(|job| {
        let driver = driver.clone();
        let database = database.clone();
        async move {
            let outcome = if dialect == Dialect::Postgres {
                driver
                    .query_with_timeout(
                        &job.sql,
                        ROWS_PER_TABLE,
                        Some(database),
                        (!no_timeout).then_some(STATEMENT_TIMEOUT_MS),
                    )
                    .await
            } else {
                driver
                    .run_statements(&[job.sql.clone()], ROWS_PER_TABLE, Some(database))
                    .await
            };
            (job, outcome)
        }
    }))
    .buffer_unordered(CONCURRENCY);

    while let Some((job, outcome)) = results.next().await {
        if is_cancelled(&state, &id).await {
            cancelled = true;
            break;
        }
        done += 1;

        let mut table_hits = Vec::new();
        let mut was_skipped = false;
        match outcome {
            Ok(result) => table_hits = hits_from_result(&job.table, &result, &lower),
            Err(error) if is_timeout_error(&error) => {
                skipped.push(job.table.clone());
                was_skipped = true;
            }
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }

        let room = MAX_HITS.saturating_sub(data_hits);
        let table_hits: Vec<SearchHit> = table_hits.into_iter().take(room).collect();
        data_hits += table_hits.len();
        hits.extend(table_hits.iter().cloned());
        let _ = app.emit(
            "find:progress",
            FindProgress {
                id: id.clone(),
                done,
                total,
                table: Some(job.table),
                hits: table_hits,
                skipped: was_skipped,
            },
        );

        if data_hits >= MAX_HITS {
            break;
        }
    }

    clear_cancelled(&state, &id).await;

    if hits.is_empty() && !cancelled {
        if let Some(error) = first_error {
            return Err(error);
        }
    }

    Ok(FindSummary {
        hits,
        skipped,
        cancelled,
        done,
        total,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn table_row_estimate(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> AppResult<Option<i64>> {
    let driver = state.pool.get(&conn_id).await?;
    let estimates = fetch_estimates(driver.as_ref(), driver.dialect(), &database).await;
    Ok(estimates.get(&table).copied())
}

#[cfg(test)]
mod tests {
    use super::{
        build_table_sql, like_escape_clause, like_literal, order_jobs, searchable_columns,
        SearchJob, SearchMode,
    };
    use crate::core::drivers::{ColumnInfo, Dialect, SchemaTable};
    use std::collections::HashMap;

    fn column(name: &str, data_type: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: true,
            key: None,
        }
    }

    fn table(name: &str, columns: Vec<ColumnInfo>) -> SchemaTable {
        SchemaTable {
            name: name.to_string(),
            columns,
        }
    }

    fn names(dialect: Dialect, columns: &[ColumnInfo], term: &str, mode: SearchMode) -> Vec<String> {
        searchable_columns(dialect, columns, term, mode)
            .into_iter()
            .map(|column| column.name.clone())
            .collect()
    }

    #[test]
    fn filters_columns_per_dialect_and_type() {
        let postgres = vec![
            column("id", "integer"),
            column("name", "text"),
            column("code", "character varying"),
            column("tag", "character"),
            column("ci", "citext"),
            column("nm", "name"),
            column("uid", "uuid"),
            column("doc", "jsonb"),
            column("blob", "bytea"),
            column("status", "USER-DEFINED"),
            column("amount", "numeric"),
        ];
        assert_eq!(
            names(Dialect::Postgres, &postgres, "hello", SearchMode::Contains).join(","),
            "name,code,tag,ci,nm,doc,status"
        );
        assert_eq!(
            names(Dialect::Postgres, &postgres, "deadbeef", SearchMode::Contains).join(","),
            "name,code,tag,ci,nm,uid,doc,status"
        );
        assert_eq!(
            names(Dialect::Postgres, &postgres, "123", SearchMode::Exact).join(","),
            "id,name,code,tag,ci,nm,uid,doc,status,amount"
        );

        let mysql = vec![
            column("id", "int"),
            column("name", "varchar(255)"),
            column("body", "text"),
            column("payload", "json"),
            column("blob_data", "blob"),
            column("bin", "binary(16)"),
            column("state", "enum('a','b')"),
            column("tags", "set('x')"),
            column("uid", "uuid"),
        ];
        assert_eq!(
            names(Dialect::Mysql, &mysql, "hello", SearchMode::Contains).join(","),
            "name,body,state,tags"
        );
        assert_eq!(
            names(Dialect::Mysql, &mysql, "42", SearchMode::Exact).join(","),
            "id,name,body,state,tags,uid"
        );

        let sqlite = vec![
            column("name", "TEXT"),
            column("body", "VARCHAR(20)"),
            column("data", "BLOB"),
            column("n", "INTEGER"),
            column("raw", ""),
        ];
        assert_eq!(
            names(Dialect::Sqlite, &sqlite, "hello", SearchMode::Contains).join(","),
            "name,body"
        );
        assert_eq!(
            names(Dialect::Sqlite, &sqlite, "42", SearchMode::Exact).join(","),
            "name,body,n"
        );
    }

    #[test]
    fn orders_jobs_by_row_estimate() {
        let mut jobs = vec![
            SearchJob {
                table: "big".into(),
                sql: String::new(),
            },
            SearchJob {
                table: "small".into(),
                sql: String::new(),
            },
            SearchJob {
                table: "unknown".into(),
                sql: String::new(),
            },
            SearchJob {
                table: "medium".into(),
                sql: String::new(),
            },
        ];
        let estimates = HashMap::from([
            ("big".to_string(), 1_000_000),
            ("small".to_string(), 10),
            ("medium".to_string(), 5_000),
        ]);

        order_jobs(&mut jobs, &estimates);
        let order: Vec<&str> = jobs.iter().map(|job| job.table.as_str()).collect();
        assert_eq!(order, ["small", "medium", "big", "unknown"]);
    }

    #[test]
    fn builds_sql_for_each_preserving_escaping() {
        let users = table("users", vec![column("name", "text")]);

        let contains = build_table_sql(
            Dialect::Postgres,
            "shop",
            &users,
            "100%",
            SearchMode::Contains,
            false,
            false,
        )
        .expect("contains sql");
        assert!(contains.contains("\"name\" LIKE '%100\\%%'"));
        assert!(!contains.contains("::text"));

        let starts = build_table_sql(
            Dialect::Postgres,
            "shop",
            &users,
            "100%",
            SearchMode::StartsWith,
            false,
            false,
        )
        .expect("starts sql");
        assert!(starts.contains("\"name\" LIKE '100\\%%'"));

        let exact = build_table_sql(
            Dialect::Postgres,
            "shop",
            &users,
            "100%",
            SearchMode::Exact,
            false,
            false,
        )
        .expect("exact sql");
        assert!(exact.contains("\"name\" = E'100%'"));

        let quoted = build_table_sql(
            Dialect::Mysql,
            "shop",
            &users,
            "O'Brien",
            SearchMode::Contains,
            false,
            false,
        )
        .expect("quoted sql");
        assert!(quoted.contains("LIKE '%O''Brien%'"));
    }

    #[test]
    fn postgres_casts_only_special_types() {
        let items = table(
            "items",
            vec![
                column("name", "text"),
                column("uid", "uuid"),
                column("doc", "jsonb"),
                column("status", "USER-DEFINED"),
            ],
        );
        let sql = build_table_sql(
            Dialect::Postgres,
            "shop",
            &items,
            "deadbeef",
            SearchMode::Contains,
            false,
            false,
        )
        .expect("postgres sql");
        assert!(sql.contains("\"name\" LIKE"));
        assert!(!sql.contains("\"name\"::text"));
        assert!(sql.contains("\"uid\"::text LIKE"));
        assert!(sql.contains("\"doc\"::text LIKE"));
        assert!(sql.contains("\"status\"::text LIKE"));
    }

    #[test]
    fn exact_mode_matches_numeric_columns() {
        let amounts = table(
            "orders",
            vec![column("id", "bigint"), column("name", "text")],
        );
        let sql = build_table_sql(
            Dialect::Postgres,
            "shop",
            &amounts,
            "42",
            SearchMode::Exact,
            false,
            false,
        )
        .expect("exact sql");
        assert!(sql.contains("\"id\" = 42"));
        assert!(sql.contains("\"name\" = E'42'"));
    }

    #[test]
    fn mysql_hint_stays_after_select() {
        let users = table("users", vec![column("name", "varchar(255)")]);
        let with_timeout = build_table_sql(
            Dialect::Mysql,
            "shop",
            &users,
            "x",
            SearchMode::Contains,
            false,
            true,
        )
        .expect("mysql sql");
        assert!(with_timeout.starts_with("SELECT /*+ MAX_EXECUTION_TIME(5000) */ "));
        assert_eq!(with_timeout.matches("MAX_EXECUTION_TIME").count(), 1);

        let without_timeout = build_table_sql(
            Dialect::Mysql,
            "shop",
            &users,
            "x",
            SearchMode::Contains,
            false,
            false,
        )
        .expect("mysql sql");
        assert!(!without_timeout.contains("MAX_EXECUTION_TIME"));
    }

    #[test]
    fn escapes_backslashes_and_wildcards() {
        assert_eq!(
            like_literal(Dialect::Mysql, "100%", SearchMode::Contains),
            "'%100\\%%'"
        );
        assert_eq!(
            like_literal(Dialect::Mysql, "a_b", SearchMode::Contains),
            "'%a\\_b%'"
        );
        assert_eq!(
            like_literal(Dialect::Mysql, "a\\b", SearchMode::Contains),
            "'%a\\\\b%'"
        );
        assert_eq!(
            like_literal(Dialect::Mssql, "O'Brien", SearchMode::Contains),
            "N'%O''Brien%'"
        );
        assert_eq!(
            like_literal(Dialect::Postgres, "100%", SearchMode::StartsWith),
            "'100\\%%'"
        );
    }

    #[test]
    fn sqlite_and_mssql_need_an_explicit_escape_clause() {
        assert_eq!(like_escape_clause(Dialect::Sqlite), " ESCAPE '\\'");
        assert_eq!(like_escape_clause(Dialect::Mssql), " ESCAPE '\\'");
        assert_eq!(like_escape_clause(Dialect::Mysql), "");
        assert_eq!(like_escape_clause(Dialect::Postgres), "");
    }
}
