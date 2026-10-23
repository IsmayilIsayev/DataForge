use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::commands::edit::{quote_ident, quote_lit, table_ref};
use crate::commands::export::insert_batch_sql;
use crate::core::drivers::{
    ColumnInfo, ConnectionEnvironment, Dialect, Driver, QueryResult, TxInput,
};
use crate::core::test_data::{
    GenerationColumn, Generator, GeneratorKind, Locale, RowGenerator, TestDataColumn, FkTarget,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const PREVIEW_ROWS: u64 = 10;
const GENERATE_BATCH: usize = 500;
const MAX_ROWS: u64 = 100_000;
const FK_LIMIT: i64 = 10_000;
const PROD_BLOCK: &str = "Test data generation is disabled on production connections";

#[derive(Debug, Clone, Deserialize)]
pub struct TestColumnConfig {
    pub name: String,
    pub generator: Generator,
    #[serde(default)]
    pub null_percent: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestDataPreview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GenerateSummary {
    pub inserted: u64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
struct GenerateProgress {
    id: String,
    done: bool,
    cancelled: bool,
    generated: u64,
    total: u64,
}

#[derive(Default)]
struct ColumnExtra {
    auto_increment: bool,
    default: Option<String>,
}

struct GenerateContext {
    database: String,
    table: String,
    dialect: Dialect,
    total: u64,
    seed: u64,
    locale: Locale,
    columns: Vec<GenerationColumn>,
}

pub fn generation_block_reason(
    read_only: bool,
    environment: Option<ConnectionEnvironment>,
) -> Option<&'static str> {
    if read_only {
        Some("Test data generation is disabled on read-only connections")
    } else if environment == Some(ConnectionEnvironment::Prod) {
        Some(PROD_BLOCK)
    } else {
        None
    }
}

fn text_at(row: &[Value], index: usize) -> Option<String> {
    match row.get(index) {
        Some(Value::Null) | None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(value) => Some(value.to_string()),
    }
}

fn int_at(row: &[Value], index: usize) -> i64 {
    match row.get(index) {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(text)) => text.parse::<i64>().unwrap_or(0),
        Some(Value::Bool(flag)) => {
            if *flag {
                1
            } else {
                0
            }
        }
        _ => 0,
    }
}

fn bool_at(row: &[Value], index: usize) -> bool {
    match row.get(index) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0) != 0,
        Some(Value::String(text)) => text == "1" || text.eq_ignore_ascii_case("true") || text.eq_ignore_ascii_case("yes"),
        _ => false,
    }
}

async fn read_query(
    driver: &dyn Driver,
    database: &str,
    sql: String,
    max_rows: i64,
) -> AppResult<QueryResult> {
    let statements = vec![sql];
    driver
        .run_statements(&statements, max_rows, Some(database.to_string()))
        .await
}

fn sqlite_schema(database: &str) -> String {
    let schema = if database.trim().is_empty() {
        "main"
    } else {
        database.trim()
    };
    quote_ident(Dialect::Sqlite, schema)
}

async fn unique_columns(
    driver: &dyn Driver,
    dialect: Dialect,
    database: &str,
    table: &str,
) -> AppResult<HashSet<String>> {
    let mut result = HashSet::new();
    let quoted_table = quote_lit(dialect, Some(table));

    match dialect {
        Dialect::Mysql => {
            let sql = format!(
                "SELECT DISTINCT COLUMN_NAME FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND NON_UNIQUE = 0",
                quote_lit(dialect, Some(database)),
                quoted_table
            );
            for row in read_query(driver, database, sql, 1000).await?.rows {
                if let Some(name) = text_at(&row, 0) {
                    result.insert(name);
                }
            }
        }
        Dialect::Postgres => {
            let sql = format!(
                "SELECT a.attname FROM pg_catalog.pg_index i \
                 JOIN pg_catalog.pg_class t ON t.oid = i.indrelid \
                 JOIN pg_catalog.pg_attribute a \
                   ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey) \
                 WHERE i.indisunique AND t.relname = {} \
                   AND t.relnamespace = ( \
                     SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = current_schema() \
                   )",
                quoted_table
            );
            for row in read_query(driver, database, sql, 1000).await?.rows {
                if let Some(name) = text_at(&row, 0) {
                    result.insert(name);
                }
            }
        }
        Dialect::Sqlite => {
            let schema = sqlite_schema(database);
            let sql = format!(
                "PRAGMA {}.index_list({})",
                schema,
                quote_ident(dialect, table)
            );
            for row in read_query(driver, database, sql, 1000).await?.rows {
                if !bool_at(&row, 2) {
                    continue;
                }
                let Some(index_name) = text_at(&row, 1) else {
                    continue;
                };
                let info_sql = format!(
                    "PRAGMA {}.index_info({})",
                    schema,
                    quote_ident(dialect, &index_name)
                );
                for info in read_query(driver, database, info_sql, 1000).await?.rows {
                    if let Some(name) = text_at(&info, 2) {
                        result.insert(name);
                    }
                }
            }
        }
        Dialect::Mssql => {
            let sql = format!(
                "SELECT c.name FROM sys.indexes i \
                 JOIN sys.index_columns ic \
                   ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
                 JOIN sys.columns c \
                   ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                 WHERE i.is_unique = 1 AND i.object_id = OBJECT_ID({})",
                quoted_table
            );
            for row in read_query(driver, database, sql, 1000).await?.rows {
                if let Some(name) = text_at(&row, 0) {
                    result.insert(name);
                }
            }
        }
        Dialect::Mongodb => {}
    }

    Ok(result)
}

async fn column_extras(
    driver: &dyn Driver,
    dialect: Dialect,
    database: &str,
    table: &str,
) -> AppResult<HashMap<String, ColumnExtra>> {
    let mut extras = HashMap::new();
    let quoted_table = quote_lit(dialect, Some(table));

    match dialect {
        Dialect::Mysql => {
            let sql = format!(
                "SELECT COLUMN_NAME, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
                quote_lit(dialect, Some(database)),
                quoted_table
            );
            for row in read_query(driver, database, sql, 1000).await?.rows {
                let Some(name) = text_at(&row, 0) else {
                    continue;
                };
                let extra = text_at(&row, 2).unwrap_or_default().to_ascii_lowercase();
                extras.insert(
                    name,
                    ColumnExtra {
                        auto_increment: extra.contains("auto_increment"),
                        default: text_at(&row, 1),
                    },
                );
            }
        }
        Dialect::Postgres => {
            let sql = format!(
                "SELECT column_name, column_default, is_identity \
                 FROM information_schema.columns \
                 WHERE table_schema = current_schema() AND table_name = {}",
                quoted_table
            );
            for row in read_query(driver, database, sql, 1000).await?.rows {
                let Some(name) = text_at(&row, 0) else {
                    continue;
                };
                let default = text_at(&row, 1);
                let identity = text_at(&row, 2)
                    .map(|value| value.eq_ignore_ascii_case("YES"))
                    .unwrap_or(false);
                let serial = default
                    .as_deref()
                    .map(|value| value.to_ascii_lowercase().contains("nextval("))
                    .unwrap_or(false);
                extras.insert(
                    name,
                    ColumnExtra {
                        auto_increment: identity || serial,
                        default,
                    },
                );
            }
        }
        Dialect::Sqlite => {
            let sql = format!(
                "PRAGMA {}.table_info({})",
                sqlite_schema(database),
                quote_ident(dialect, table)
            );
            let rows = read_query(driver, database, sql, 1000).await?.rows;
            let primary_count = rows.iter().filter(|row| int_at(row, 5) > 0).count();
            for row in rows {
                let Some(name) = text_at(&row, 1) else {
                    continue;
                };
                let data_type = text_at(&row, 2).unwrap_or_default().to_ascii_lowercase();
                let primary = int_at(&row, 5) > 0;
                extras.insert(
                    name,
                    ColumnExtra {
                        auto_increment: primary
                            && primary_count == 1
                            && data_type.contains("int"),
                        default: text_at(&row, 4),
                    },
                );
            }
        }
        Dialect::Mssql => {
            let sql = format!(
                "SELECT c.name, dc.definition, c.is_identity FROM sys.columns c \
                 LEFT JOIN sys.default_constraints dc \
                   ON dc.object_id = c.default_object_id \
                 WHERE c.object_id = OBJECT_ID({})",
                quoted_table
            );
            for row in read_query(driver, database, sql, 1000).await?.rows {
                let Some(name) = text_at(&row, 0) else {
                    continue;
                };
                extras.insert(
                    name,
                    ColumnExtra {
                        auto_increment: bool_at(&row, 2),
                        default: text_at(&row, 1),
                    },
                );
            }
        }
        Dialect::Mongodb => {}
    }

    Ok(extras)
}

async fn load_metadata(
    driver: &dyn Driver,
    database: &str,
    table: &str,
) -> AppResult<Vec<TestDataColumn>> {
    let base = driver.list_columns(database, table).await?;
    if base.is_empty() {
        return Err(AppError::Config(format!("table '{table}' has no columns")));
    }

    let dialect = driver.dialect();
    let unique = unique_columns(driver, dialect, database, table)
        .await
        .unwrap_or_default();
    let extras = column_extras(driver, dialect, database, table)
        .await
        .unwrap_or_default();

    let mut er_primary = HashSet::new();
    let mut foreign_keys: HashMap<String, FkTarget> = HashMap::new();
    if let Ok(schema) = driver.get_er_schema(Some(database)).await {
        if let Some(er_table) = schema
            .tables
            .iter()
            .find(|candidate| candidate.name.eq_ignore_ascii_case(table))
        {
            for column in &er_table.columns {
                if column.pk {
                    er_primary.insert(column.name.clone());
                }
            }
        }

        for foreign_key in &schema.foreign_keys {
            if !foreign_key.from_table.eq_ignore_ascii_case(table)
                || foreign_key.from_columns.len() != 1
                || foreign_key.to_columns.len() != 1
            {
                continue;
            }
            foreign_keys.insert(
                foreign_key.from_columns[0].clone(),
                FkTarget {
                    table: foreign_key.to_table.clone(),
                    column: foreign_key.to_columns[0].clone(),
                },
            );
        }
    }

    let mut result = Vec::with_capacity(base.len());
    for ColumnInfo {
        name,
        data_type,
        nullable,
        key,
    } in base
    {
        let extra = extras.get(&name);
        let primary_key = key.as_deref() == Some("PRI") || er_primary.contains(&name);
        let is_unique = unique.contains(&name) || primary_key;
        let auto_increment = extra.map(|item| item.auto_increment).unwrap_or(false);
        let default = extra.and_then(|item| item.default.clone());
        let foreign_key = foreign_keys.get(&name).cloned();
        let suggested = crate::core::test_data::suggest_generator(
            &name,
            &data_type,
            auto_increment,
            is_unique,
            foreign_key.as_ref(),
        );
        let suggested = if is_unique {
            crate::core::test_data::ensure_unique_generator(suggested, &data_type)
        } else {
            suggested
        };

        result.push(TestDataColumn {
            name,
            data_type,
            nullable,
            primary_key,
            auto_increment,
            unique: is_unique,
            default,
            foreign_key,
            suggested,
        });
    }

    Ok(result)
}

fn fk_select_sql(
    dialect: Dialect,
    database: &str,
    table: &str,
    column: &str,
) -> String {
    let target = table_ref(dialect, database, table);
    let column = quote_ident(dialect, column);
    match dialect {
        Dialect::Mssql => format!(
            "SELECT TOP {FK_LIMIT} {column} FROM {target} WHERE {column} IS NOT NULL ORDER BY {column}"
        ),
        _ => format!(
            "SELECT {column} FROM {target} WHERE {column} IS NOT NULL ORDER BY {column} LIMIT {FK_LIMIT}"
        ),
    }
}

async fn load_foreign_keys(
    driver: &dyn Driver,
    dialect: Dialect,
    database: &str,
    metadata: &[TestDataColumn],
    configs: &[TestColumnConfig],
) -> AppResult<HashMap<String, Vec<Value>>> {
    let by_name: HashMap<&str, &TestDataColumn> = metadata
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let mut values = HashMap::new();
    let mut cache: HashMap<(String, String), Vec<Value>> = HashMap::new();

    for config in configs {
        if config.generator.kind != GeneratorKind::ForeignKey {
            continue;
        }

        let target = match (&config.generator.table, &config.generator.column) {
            (Some(table), Some(column)) => Some(FkTarget {
                table: table.clone(),
                column: column.clone(),
            }),
            _ => by_name
                .get(config.name.as_str())
                .and_then(|column| column.foreign_key.clone()),
        };
        let Some(target) = target else {
            return Err(AppError::Config(format!(
                "column '{}' has no foreign key target",
                config.name
            )));
        };

        let cache_key = (target.table.clone(), target.column.clone());
        let ids = if let Some(cached) = cache.get(&cache_key) {
            cached.clone()
        } else {
            let sql = fk_select_sql(dialect, database, &target.table, &target.column);
            let result = read_query(driver, database, sql, FK_LIMIT).await?;
            let mut seen = HashSet::new();
            let mut ids = Vec::new();
            for row in result.rows {
                let Some(value) = row.into_iter().next() else {
                    continue;
                };
                if value.is_null() {
                    continue;
                }
                if seen.insert(value.to_string()) {
                    ids.push(value);
                }
            }
            cache.insert(cache_key, ids.clone());
            ids
        };
        values.insert(config.name.clone(), ids);
    }

    Ok(values)
}

fn build_columns(
    metadata: &[TestDataColumn],
    configs: &[TestColumnConfig],
    foreign_keys: &HashMap<String, Vec<Value>>,
) -> AppResult<Vec<GenerationColumn>> {
    let by_name: HashMap<&str, &TestDataColumn> = metadata
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect();
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for config in configs {
        if !seen.insert(config.name.clone()) {
            return Err(AppError::Config(format!(
                "column '{}' is configured more than once",
                config.name
            )));
        }

        let Some(column) = by_name.get(config.name.as_str()) else {
            return Err(AppError::Config(format!(
                "unknown column: {}",
                config.name
            )));
        };

        if config.generator.kind == GeneratorKind::Skip {
            continue;
        }
        if config.generator.kind == GeneratorKind::Null && !column.nullable {
            return Err(AppError::Config(format!(
                "column '{}' is NOT NULL and cannot use the NULL generator",
                column.name
            )));
        }

        let fk_values = foreign_keys
            .get(&config.name)
            .cloned()
            .unwrap_or_default();
        if config.generator.kind == GeneratorKind::ForeignKey && fk_values.is_empty() {
            if !column.nullable {
                return Err(AppError::Config(format!(
                    "column '{}' has no referenced rows to pick from",
                    column.name
                )));
            }
            if column.unique {
                return Err(AppError::Config(format!(
                    "column '{}' has no referenced rows for a unique generator",
                    column.name
                )));
            }
        }

        result.push(GenerationColumn {
            name: column.name.clone(),
            data_type: column.data_type.clone(),
            nullable: column.nullable,
            unique: column.unique || column.primary_key,
            generator: config.generator.clone(),
            null_percent: config.null_percent.clamp(0.0, 100.0),
            fk_values,
        });
    }

    if result.is_empty() {
        return Err(AppError::Config(
            "select at least one column to generate".to_string(),
        ));
    }

    Ok(result)
}

fn emit_progress(
    app: &tauri::AppHandle,
    id: &str,
    generated: u64,
    total: u64,
    done: bool,
    cancelled: bool,
) {
    let _ = app.emit(
        "test_data:progress",
        GenerateProgress {
            id: id.to_string(),
            done,
            cancelled,
            generated,
            total,
        },
    );
}

fn is_cancelled(app: &tauri::AppHandle, id: &str) -> bool {
    app.state::<AppState>()
        .cancelled
        .blocking_read()
        .contains(id)
}

fn send(tx: &mpsc::Sender<TxInput>, item: TxInput) -> bool {
    tx.blocking_send(item).is_ok()
}

fn stream_generate(
    app: tauri::AppHandle,
    id: String,
    context: GenerateContext,
    tx: mpsc::Sender<TxInput>,
) -> AppResult<()> {
    let mut generator = RowGenerator::new(context.seed, context.columns, context.locale);
    let columns = generator.column_names();
    let mut generated = 0u64;

    for size in batch_sizes(context.total, GENERATE_BATCH) {
        let mut batch: Vec<Vec<Value>> = Vec::with_capacity(size);
        for _ in 0..size {
            if generated % 128 == 0 && is_cancelled(&app, &id) {
                let _ = send(&tx, TxInput::Rollback);
                return Ok(());
            }

            let row = match generator.row(generated) {
                Ok(row) => row,
                Err(error) => {
                    let _ = send(&tx, TxInput::Rollback);
                    return Err(error);
                }
            };
            batch.push(row);
            generated += 1;
        }

        let sql = insert_batch_sql(
            context.dialect,
            context.database.as_str(),
            context.table.as_str(),
            columns.as_slice(),
            batch.as_slice(),
        );
        if !send(
            &tx,
            TxInput::Sql {
                sql,
                row: None,
            },
        ) {
            return Ok(());
        }
        emit_progress(&app, &id, generated, context.total, false, false);
    }

    Ok(())
}

pub(crate) fn batch_sizes(total: u64, batch: usize) -> Vec<usize> {
    if batch == 0 {
        return Vec::new();
    }
    let mut sizes = Vec::new();
    let mut remaining = total;
    while remaining > 0 {
        let size = remaining.min(batch as u64) as usize;
        sizes.push(size);
        remaining -= size as u64;
    }
    sizes
}

#[tauri::command(rename_all = "snake_case")]
pub async fn test_data_columns(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> AppResult<Vec<TestDataColumn>> {
    let driver = state.pool.get(&conn_id).await?;
    load_metadata(driver.as_ref(), &database, &table).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn preview_test_data(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    rows: Option<u64>,
    seed: Option<u64>,
    locale: Option<Locale>,
    columns: Vec<TestColumnConfig>,
) -> AppResult<TestDataPreview> {
    let driver = state.pool.get(&conn_id).await?;
    let metadata = load_metadata(driver.as_ref(), &database, &table).await?;
    let dialect = driver.dialect();
    let foreign_keys = load_foreign_keys(
        driver.as_ref(),
        dialect,
        &database,
        &metadata,
        &columns,
    )
    .await?;
    let columns = build_columns(&metadata, &columns, &foreign_keys)?;

    let total = rows.unwrap_or(100).clamp(1, MAX_ROWS).min(PREVIEW_ROWS);
    let mut generator = RowGenerator::new(seed.unwrap_or(0), columns, locale.unwrap_or_default());
    let names = generator.column_names();
    let mut generated = Vec::with_capacity(total as usize);
    for index in 0..total {
        generated.push(generator.row(index)?);
    }

    Ok(TestDataPreview {
        columns: names,
        rows: generated,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn generate_rows(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    rows: Option<u64>,
    seed: Option<u64>,
    locale: Option<Locale>,
    columns: Vec<TestColumnConfig>,
    generate_id: Option<String>,
) -> AppResult<GenerateSummary> {
    let meta = state
        .connections
        .read()
        .await
        .find(&conn_id)
        .ok_or(AppError::NoConnection)?;
    if let Some(reason) = generation_block_reason(
        meta.read_only.unwrap_or(false),
        meta.environment,
    ) {
        return Err(AppError::Config(reason.to_string()));
    }

    let driver = state.pool.get(&conn_id).await?;
    let metadata = load_metadata(driver.as_ref(), &database, &table).await?;
    let dialect = driver.dialect();
    let foreign_keys = load_foreign_keys(
        driver.as_ref(),
        dialect,
        &database,
        &metadata,
        &columns,
    )
    .await?;
    let columns = build_columns(&metadata, &columns, &foreign_keys)?;

    let total = rows.unwrap_or(100).clamp(1, MAX_ROWS);
    let seed = seed.unwrap_or(0);
    let id = generate_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    state.cancelled.write().await.remove(&id);

    let context = GenerateContext {
        database: database.clone(),
        table,
        dialect,
        total,
        seed,
        locale: locale.unwrap_or_default(),
        columns,
    };

    let (tx, rx) = mpsc::channel(8);
    let task_app = app.clone();
    let task_id = id.clone();
    let producer = tokio::task::spawn_blocking(move || {
        stream_generate(task_app, task_id, context, tx)
    });

    let outcome = driver
        .stream_transaction(rx, Some(database))
        .await
        .map_err(|failure| failure.error)?;
    let produced = producer
        .await
        .map_err(|error| AppError::Internal(format!("test data: {error}")))?;
    state.cancelled.write().await.remove(&id);

    if let Err(error) = produced {
        emit_progress(&app, &id, 0, total, true, true);
        return Err(error);
    }

    if outcome.cancelled {
        emit_progress(&app, &id, 0, total, true, true);
        return Ok(GenerateSummary {
            inserted: 0,
            cancelled: true,
        });
    }

    emit_progress(&app, &id, total, total, true, false);
    Ok(GenerateSummary {
        inserted: outcome.rows_affected,
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::{batch_sizes, generation_block_reason, GENERATE_BATCH};
    use crate::core::drivers::ConnectionEnvironment;

    #[test]
    fn production_and_read_only_connections_are_refused() {
        assert_eq!(
            generation_block_reason(false, Some(ConnectionEnvironment::Prod)),
            Some("Test data generation is disabled on production connections")
        );
        assert_eq!(
            generation_block_reason(true, Some(ConnectionEnvironment::Dev)),
            Some("Test data generation is disabled on read-only connections")
        );
        assert!(generation_block_reason(false, Some(ConnectionEnvironment::Dev)).is_none());
    }

    #[test]
    fn rows_are_split_into_500_row_batches() {
        assert_eq!(batch_sizes(1000, GENERATE_BATCH), vec![500, 500]);
        assert_eq!(batch_sizes(1001, GENERATE_BATCH), vec![500, 500, 1]);
        assert_eq!(batch_sizes(0, GENERATE_BATCH), Vec::<usize>::new());
        assert_eq!(batch_sizes(499, GENERATE_BATCH), vec![499]);
    }
}
