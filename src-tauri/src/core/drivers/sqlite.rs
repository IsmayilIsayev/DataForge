use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{Number, Value};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteConnection, SqlitePool, SqlitePoolOptions, SqliteRow,
};
use sqlx::{Column, Connection, Executor, Row, Statement, TypeInfo, ValueRef};

use crate::core::drivers::{
    er, group_foreign_keys, int_json, BoxFuture, ColumnInfo, ConnectionInput, Dialect, Driver,
    ErColumn, ErSchema, ErTable, ForeignKeyRow, QueryResult, SchemaSnapshot, SchemaTable, TableInfo,
    TableKind, TxError, TxInput, TxRowError, TxStreamOutcome, ER_TABLE_LIMIT,
};
use crate::core::schema_diff::{
    ColumnSchema, ForeignKeySchema, IndexSchema, SchemaData, TableSchema, ViewSchema,
    DIFF_TABLE_LIMIT,
};
use crate::error::{AppError, AppResult};

const DEFAULT_MAX_ROWS: i64 = 1000;
const MAX_ROWS: i64 = 100_000;

fn trim_statement(sql: &str) -> &str {
    sql.trim().trim_end_matches(';').trim_end()
}

/// A read-only SQLite connection must never create the database file either.
fn read_only_flags(read_only: Option<bool>) -> (bool, bool) {
    let read_only = read_only.unwrap_or(false);
    (read_only, !read_only)
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

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn split_sql_list(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut depth = 0;

    for character in value.chars() {
        if let Some(open) = quote {
            current.push(character);
            if character == open {
                quote = None;
            }
            continue;
        }
        match character {
            '"' | '\'' | '`' => {
                quote = Some(character);
                current.push(character);
            }
            '[' => {
                quote = Some(']');
                current.push(character);
            }
            '(' => {
                depth += 1;
                current.push(character);
            }
            ')' => {
                depth -= 1;
                current.push(character);
            }
            ',' if depth == 0 => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(character),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }
    parts
}

fn first_sql_token(value: &str) -> String {
    let value = value.trim();
    let Some(first) = value.chars().next() else {
        return String::new();
    };
    let closing = match first {
        '"' => Some('"'),
        '`' => Some('`'),
        '[' => Some(']'),
        '\'' => Some('\''),
        _ => None,
    };
    if let Some(closing) = closing {
        let mut result = String::new();
        let mut chars = value.chars();
        chars.next();
        for character in chars {
            if character == closing {
                break;
            }
            result.push(character);
        }
        return result;
    }
    value
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

fn parse_sqlite_index(name: &str, _table: &str, sql: &str) -> Option<IndexSchema> {
    let upper = sql.trim_start().to_ascii_uppercase();
    let unique = upper.starts_with("CREATE UNIQUE INDEX");
    let open = sql.find('(')?;
    let close = sql.rfind(')')?;
    if close <= open {
        return None;
    }
    let columns: Vec<String> = split_sql_list(&sql[open + 1..close])
        .into_iter()
        .map(|part| first_sql_token(&part))
        .filter(|column| !column.is_empty())
        .collect();
    if columns.is_empty() {
        return None;
    }
    Some(IndexSchema {
        name: name.to_string(),
        columns,
        unique,
    })
}

fn sqlite_view_definition(sql: &str) -> Option<String> {
    let upper = sql.to_ascii_uppercase();
    let index = upper.find(" AS ")?;
    Some(
        sql[index + 4..]
            .trim()
            .trim_end_matches(';')
            .trim()
            .to_string(),
    )
}

fn row_columns(row: &SqliteRow) -> Vec<String> {
    row.columns()
        .iter()
        .map(|column| column.name().to_string())
        .collect()
}

fn build_result(
    columns: Vec<String>,
    fetched: Vec<SqliteRow>,
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

pub struct SqliteDriver {
    pool: SqlitePool,
}

impl SqliteDriver {
    pub async fn connect(input: &ConnectionInput, _password: Option<&str>) -> AppResult<Self> {
        let path = input.database.clone().unwrap_or_default();
        if path.trim().is_empty() {
            return Err(AppError::Config(
                "SQLite database file is required".to_string(),
            ));
        }

        let (read_only, create_if_missing) = read_only_flags(input.read_only);
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .read_only(read_only)
            .create_if_missing(create_if_missing);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await
            .map_err(db_error)?;

        Ok(Self { pool })
    }

    async fn tables(&self, database: &str) -> AppResult<Vec<TableInfo>> {
        let schema = quote_identifier(if database.is_empty() {
            "main"
        } else {
            database
        });
        let sql = format!(
            "SELECT name, type FROM {schema}.sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name"
        );

        let rows = sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let name = row.try_get::<String, _>(0).unwrap_or_default();
                let kind = row.try_get::<String, _>(1).unwrap_or_default();
                TableInfo {
                    name,
                    kind: if kind.eq_ignore_ascii_case("view") {
                        TableKind::View
                    } else {
                        TableKind::Table
                    },
                }
            })
            .collect())
    }

    async fn columns(&self, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
        let schema = quote_identifier(if database.is_empty() {
            "main"
        } else {
            database
        });
        let sql = format!("PRAGMA {schema}.table_info({})", quote_identifier(table));

        let rows = sqlx::query(&sql)
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let name = row.try_get::<String, _>(1).unwrap_or_default();
                let data_type = row.try_get::<String, _>(2).unwrap_or_default();
                let notnull = row.try_get::<i64, _>(3).unwrap_or(0);
                let primary = row.try_get::<i64, _>(5).unwrap_or(0);

                ColumnInfo {
                    name,
                    data_type,
                    nullable: notnull == 0 && primary == 0,
                    key: if primary > 0 {
                        Some("PRI".to_string())
                    } else {
                        None
                    },
                }
            })
            .collect())
    }
}

impl Driver for SqliteDriver {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    fn dialect_name(&self) -> &'static str {
        Dialect::Sqlite.as_str()
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
        _database: Option<String>,
    ) -> BoxFuture<'a, AppResult<QueryResult>> {
        Box::pin(async move {
            let mut conn = self.pool.acquire().await.map_err(db_error)?;
            execute_batch(&mut conn, statements, max_rows).await
        })
    }

    fn apply_transaction<'a>(
        &'a self,
        statements: &'a [String],
        _database: Option<String>,
    ) -> BoxFuture<'a, Result<u64, TxError>> {
        Box::pin(async move {
            let mut conn = self
                .pool
                .acquire()
                .await
                .map_err(|error| TxError::new(None, db_error(error)))?;
            run_transaction(&mut conn, statements).await
        })
    }

    fn stream_transaction<'a>(
        &'a self,
        input: tokio::sync::mpsc::Receiver<TxInput>,
        _database: Option<String>,
    ) -> BoxFuture<'a, Result<TxStreamOutcome, TxError>> {
        Box::pin(async move {
            let mut conn = self
                .pool
                .acquire()
                .await
                .map_err(|error| TxError::new(None, db_error(error)))?;
            run_stream_transaction(&mut conn, input).await
        })
    }

    fn get_schema<'a>(
        &'a self,
        database: Option<&'a str>,
    ) -> BoxFuture<'a, AppResult<SchemaSnapshot>> {
        Box::pin(async move {
            let database = database
                .filter(|value| !value.is_empty())
                .unwrap_or("main")
                .to_string();

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
                .filter(|value| !value.is_empty())
                .unwrap_or("main")
                .to_string();

            let all_tables = self.tables(&database).await?;
            let mut names: Vec<String> = all_tables
                .into_iter()
                .filter(|table| matches!(table.kind, TableKind::Table))
                .map(|table| table.name)
                .collect();
            names.sort();
            names.dedup();

            let truncated = names.len() > ER_TABLE_LIMIT;
            names.truncate(ER_TABLE_LIMIT);
            let included: std::collections::HashSet<String> =
                names.iter().cloned().collect();
            let mut tables: Vec<ErTable> = names
                .iter()
                .cloned()
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
            // SQLite primary keys are positional (needed when a foreign key
            // omits the referenced column and implicitly targets the PK).
            let mut pk_columns: std::collections::HashMap<String, Vec<(i64, String)>> =
                std::collections::HashMap::new();

            if database == "main" {
                let column_rows = sqlx::query(er::sqlite_columns_sql())
                    .fetch_all(&self.pool)
                    .await
                    .map_err(db_error)?;
                for row in column_rows {
                    let table = row.try_get::<String, _>(0).unwrap_or_default();
                    let Some(&position) = index.get(&table) else {
                        continue;
                    };
                    let name = row.try_get::<String, _>(1).unwrap_or_default();
                    let not_null = row.try_get::<i64, _>(3).unwrap_or(0);
                    let pk = row.try_get::<i64, _>(4).unwrap_or(0);
                    tables[position].columns.push(ErColumn {
                        name: name.clone(),
                        data_type: row.try_get::<String, _>(2).unwrap_or_default(),
                        nullable: not_null == 0 && pk == 0,
                        pk: pk > 0,
                    });
                    if pk > 0 {
                        pk_columns
                            .entry(table)
                            .or_default()
                            .push((pk, name.clone()));
                    }
                }
            } else {
                for table in &names {
                    let columns = self.columns(&database, table).await?;
                    if let Some(&position) = index.get(table) {
                        tables[position].columns = columns
                            .into_iter()
                            .map(|column| ErColumn {
                                pk: column.key.as_deref() == Some("PRI"),
                                name: column.name,
                                data_type: column.data_type,
                                nullable: column.nullable,
                            })
                            .collect();
                    }
                }
            }

            for pk in pk_columns.values_mut() {
                pk.sort_by_key(|(position, _)| *position);
            }

            let mut foreign_key_rows = Vec::new();
            for table in &names {
                let sql = er::sqlite_foreign_keys_sql(&database, table);
                let rows = sqlx::query(&sql)
                    .fetch_all(&self.pool)
                    .await
                    .map_err(db_error)?;
                for row in rows {
                    let id = row.try_get::<i64, _>(0).unwrap_or(0);
                    let seq = row.try_get::<i64, _>(1).unwrap_or(0);
                    let to_table = row.try_get::<String, _>(2).unwrap_or_default();
                    if !included.contains(&to_table) {
                        continue;
                    }
                    let from_column = row.try_get::<String, _>(3).unwrap_or_default();
                    let mut to_column = row
                        .try_get::<Option<String>, _>(4)
                        .unwrap_or(None)
                        .unwrap_or_default();
                    if to_column.is_empty() {
                        to_column = pk_columns
                            .get(&to_table)
                            .and_then(|columns| columns.get(seq as usize))
                            .map(|(_, name)| name.clone())
                            .unwrap_or_default();
                    }
                    foreign_key_rows.push(ForeignKeyRow {
                        constraint_name: format!("fk_{table}_{id}"),
                        from_table: table.clone(),
                        from_column,
                        from_position: seq,
                        to_table,
                        to_column,
                        to_position: seq,
                    });
                }
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
                .filter(|value| !value.is_empty())
                .unwrap_or("main")
                .to_string();
            let schema = quote_identifier(&database);

            let objects_sql = format!(
                "SELECT name, type, sql FROM {schema}.sqlite_master \
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY name"
            );
            let object_rows = sqlx::query(&objects_sql)
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;
            let mut table_names = Vec::new();
            let mut create_sql: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            let mut views = Vec::new();
            for row in object_rows {
                let name = row.try_get::<String, _>(0).unwrap_or_default();
                let kind = row.try_get::<String, _>(1).unwrap_or_default();
                let sql = row.try_get::<Option<String>, _>(2).unwrap_or(None);
                if kind.eq_ignore_ascii_case("view") {
                    if views.len() < DIFF_TABLE_LIMIT {
                        views.push(ViewSchema {
                            name,
                            definition: sql.as_deref().and_then(sqlite_view_definition),
                        });
                    }
                } else if !name.is_empty() {
                    table_names.push(name.clone());
                    if let Some(sql) = sql {
                        create_sql.insert(name, sql);
                    }
                }
            }
            table_names.sort();
            table_names.dedup();

            let truncated = table_names.len() > DIFF_TABLE_LIMIT;
            table_names.truncate(DIFF_TABLE_LIMIT);
            let included: std::collections::HashSet<String> =
                table_names.iter().cloned().collect();
            let mut tables: std::collections::HashMap<String, TableSchema> = table_names
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

            if database == "main" {
                let columns_sql = format!(
                    "SELECT m.name, p.name, p.type, p.\"notnull\", p.pk, p.dflt_value \
                     FROM {schema}.sqlite_master m \
                     JOIN pragma_table_info(m.name) p \
                     WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' \
                     ORDER BY m.name, p.cid"
                );
                let rows = sqlx::query(&columns_sql)
                    .fetch_all(&self.pool)
                    .await
                    .map_err(db_error)?;
                for row in rows {
                    let table = row.try_get::<String, _>(0).unwrap_or_default();
                    let Some(schema) = tables.get_mut(&table) else {
                        continue;
                    };
                    let not_null = row.try_get::<i64, _>(3).unwrap_or(0);
                    let pk = row.try_get::<i64, _>(4).unwrap_or(0);
                    schema.columns.push(ColumnSchema {
                        name: row.try_get::<String, _>(1).unwrap_or_default(),
                        data_type: row.try_get::<String, _>(2).unwrap_or_default(),
                        nullable: not_null == 0 && pk == 0,
                        primary_key: pk > 0,
                        default: row.try_get::<Option<String>, _>(5).unwrap_or(None),
                        auto_increment: false,
                    });
                }
            } else {
                for table in &table_names {
                    let sql = format!(
                        "PRAGMA {schema}.table_info({})",
                        quote_identifier(table)
                    );
                    let rows = sqlx::query(&sql)
                        .fetch_all(&self.pool)
                        .await
                        .map_err(db_error)?;
                    let Some(schema) = tables.get_mut(table) else {
                        continue;
                    };
                    for row in rows {
                        let not_null = row.try_get::<i64, _>(3).unwrap_or(0);
                        let pk = row.try_get::<i64, _>(5).unwrap_or(0);
                        schema.columns.push(ColumnSchema {
                            name: row.try_get::<String, _>(1).unwrap_or_default(),
                            data_type: row.try_get::<String, _>(2).unwrap_or_default(),
                            nullable: not_null == 0 && pk == 0,
                            primary_key: pk > 0,
                            default: row.try_get::<Option<String>, _>(4).unwrap_or(None),
                            auto_increment: false,
                        });
                    }
                }
            }

            for (table, sql) in &create_sql {
                if !sql.to_ascii_uppercase().contains("AUTOINCREMENT") {
                    continue;
                }
                if let Some(schema) = tables.get_mut(table) {
                    for column in &mut schema.columns {
                        if column.primary_key {
                            column.auto_increment = true;
                        }
                    }
                }
            }

            let indexes_sql = format!(
                "SELECT name, tbl_name, sql FROM {schema}.sqlite_master \
                 WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
                 ORDER BY tbl_name, name"
            );
            let index_rows = sqlx::query(&indexes_sql)
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;
            for row in index_rows {
                let name = row.try_get::<String, _>(0).unwrap_or_default();
                let table = row.try_get::<String, _>(1).unwrap_or_default();
                if !included.contains(&table) {
                    continue;
                }
                let Some(sql) = row.try_get::<Option<String>, _>(2).unwrap_or(None) else {
                    continue;
                };
                if let Some(index) = parse_sqlite_index(&name, &table, &sql) {
                    if let Some(schema) = tables.get_mut(&table) {
                        schema.indexes.push(index);
                    }
                }
            }

            let mut pk_columns: std::collections::HashMap<String, Vec<(i64, String)>> =
                std::collections::HashMap::new();
            for table in &table_names {
                if let Some(schema) = tables.get(table) {
                    for (position, column) in schema.columns.iter().enumerate() {
                        if column.primary_key {
                            pk_columns
                                .entry(table.clone())
                                .or_default()
                                .push((position as i64 + 1, column.name.clone()));
                        }
                    }
                }
            }

            let mut foreign_key_rows = Vec::new();
            for table in &table_names {
                let sql = er::sqlite_foreign_keys_sql(&database, table);
                let rows = sqlx::query(&sql)
                    .fetch_all(&self.pool)
                    .await
                    .map_err(db_error)?;
                for row in rows {
                    let id = row.try_get::<i64, _>(0).unwrap_or(0);
                    let seq = row.try_get::<i64, _>(1).unwrap_or(0);
                    let to_table = row.try_get::<String, _>(2).unwrap_or_default();
                    if !included.contains(&to_table) {
                        continue;
                    }
                    let from_column = row.try_get::<String, _>(3).unwrap_or_default();
                    let mut to_column = row
                        .try_get::<Option<String>, _>(4)
                        .unwrap_or(None)
                        .unwrap_or_default();
                    if to_column.is_empty() {
                        to_column = pk_columns
                            .get(&to_table)
                            .and_then(|columns| columns.get(seq as usize))
                            .map(|(_, name)| name.clone())
                            .unwrap_or_default();
                    }
                    foreign_key_rows.push(ForeignKeyRow {
                        constraint_name: format!("fk_{table}_{id}"),
                        from_table: table.clone(),
                        from_column,
                        from_position: seq,
                        to_table,
                        to_column,
                        to_position: seq,
                    });
                }
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
            let rows = sqlx::query("PRAGMA database_list")
                .fetch_all(&self.pool)
                .await
                .map_err(db_error)?;

            let mut names = Vec::new();
            for row in rows {
                if let Ok(name) = row.try_get::<String, _>(1) {
                    if !name.is_empty() && name != "temp" {
                        names.push(name);
                    }
                }
            }

            if names.is_empty() {
                names.push("main".to_string());
            }

            Ok(names)
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

async fn run_transaction(
    conn: &mut SqliteConnection,
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
    conn: &mut SqliteConnection,
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
    conn: &mut SqliteConnection,
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
    conn: &mut SqliteConnection,
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
        "SELECT" | "WITH" | "PRAGMA" | "EXPLAIN" | "VALUES" | "TABLE"
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
    let mut fetched: Vec<SqliteRow> = Vec::new();
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

fn cell_to_json(row: &SqliteRow, index: usize) -> Value {
    let Some(column) = row.columns().get(index) else {
        return Value::Null;
    };

    let raw = match row.try_get_raw(index) {
        Ok(raw) => raw,
        Err(_) => return Value::Null,
    };

    if raw.is_null() {
        return Value::Null;
    }

    let declared_type = column.type_info().name().to_ascii_uppercase();
    let value_type = raw.type_info().name().to_ascii_uppercase();

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

    if declared_type.contains("BOOL") && value_type == "INTEGER" {
        int_value!(i64, |v: i64| Value::Bool(v != 0));
    }

    match value_type.as_str() {
        "INTEGER" => int_value!(i64, int_json),
        "REAL" => int_value!(f64, number),
        "TEXT" => string_value!(),
        "BLOB" => {
            if let Ok(value) = row.try_get_unchecked::<Option<Vec<u8>>, _>(index) {
                match value {
                    Some(bytes) => return bytes_value(&bytes),
                    None => return Value::Null,
                }
            }
        }
        _ => {}
    }

    int_value!(i64, Value::from);
    int_value!(f64, number);
    string_value!();

    if let Ok(value) = row.try_get_unchecked::<Option<Vec<u8>>, _>(index) {
        match value {
            Some(bytes) => return bytes_value(&bytes),
            None => return Value::Null,
        }
    }

    Value::Null
}

#[cfg(test)]
mod tests {
    use super::read_only_flags;

    #[test]
    fn read_only_disables_file_creation() {
        assert_eq!(read_only_flags(None), (false, true));
        assert_eq!(read_only_flags(Some(false)), (false, true));
        assert_eq!(read_only_flags(Some(true)), (true, false));
    }
}
