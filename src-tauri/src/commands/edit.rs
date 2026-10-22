use serde::Deserialize;
use tauri::State;

use crate::core::drivers::Dialect;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// One column reference with its value, used for primary-key WHERE clauses and
/// for INSERT payloads. `value: None` means SQL NULL.
#[derive(Deserialize)]
pub struct CellRef {
    pub column: String,
    #[serde(default)]
    pub value: Option<String>,
}

fn quote_ident(dialect: Dialect, name: &str) -> String {
    match dialect {
        Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// Escape a value into a safe SQL literal. Strings are single-quoted with quotes
/// doubled (injection-safe); None becomes NULL. Unknown-type string literals are
/// coerced to the column type by MySQL / PostgreSQL / SQLite alike.
fn quote_lit(dialect: Dialect, value: Option<&str>) -> String {
    match value {
        None => "NULL".to_string(),
        Some(v) => {
            // MySQL treats backslash as an escape char inside string literals, so it
            // must be doubled too; PostgreSQL / SQLite only need quote doubling.
            let escaped = match dialect {
                Dialect::Mysql => v.replace('\\', "\\\\").replace('\'', "''"),
                _ => v.replace('\'', "''"),
            };
            format!("'{escaped}'")
        }
    }
}

fn table_ref(dialect: Dialect, database: &str, table: &str) -> String {
    let quoted = quote_ident(dialect, table);
    match dialect {
        Dialect::Mysql if !database.trim().is_empty() => {
            format!("{}.{}", quote_ident(dialect, database), quoted)
        }
        _ => quoted,
    }
}

fn where_clause(dialect: Dialect, pk: &[CellRef]) -> AppResult<String> {
    if pk.is_empty() {
        return Err(AppError::Config(
            "this table has no primary key — editing is not possible".to_string(),
        ));
    }
    let parts: Vec<String> = pk
        .iter()
        .map(|cell| match &cell.value {
            None => format!("{} IS NULL", quote_ident(dialect, &cell.column)),
            Some(v) => format!(
                "{} = {}",
                quote_ident(dialect, &cell.column),
                quote_lit(dialect, Some(v))
            ),
        })
        .collect();
    Ok(parts.join(" AND "))
}

async fn run_write(
    state: &AppState,
    conn_id: &str,
    database: &str,
    sql: &str,
) -> AppResult<u64> {
    let driver = state.pool.get(conn_id).await?;
    // Run against the table's own database (matters for PostgreSQL, where a
    // connection is bound to one database); MySQL qualifies the table anyway.
    let db = if database.trim().is_empty() {
        None
    } else {
        Some(database.to_string())
    };
    let statements = [sql.to_string()];
    let result = driver.run_statements(&statements, 0, db).await?;
    Ok(result.rows_affected.unwrap_or(0))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn update_cell(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    pk: Vec<CellRef>,
    column: String,
    value: Option<String>,
) -> AppResult<u64> {
    let dialect = state.pool.get(&conn_id).await?.dialect();
    let sql = format!(
        "UPDATE {} SET {} = {} WHERE {}",
        table_ref(dialect, &database, &table),
        quote_ident(dialect, &column),
        quote_lit(dialect, value.as_deref()),
        where_clause(dialect, &pk)?,
    );
    run_write(&state, &conn_id, &database, &sql).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn delete_rows(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    rows: Vec<Vec<CellRef>>,
) -> AppResult<u64> {
    let dialect = state.pool.get(&conn_id).await?.dialect();
    let mut total = 0u64;
    for pk in &rows {
        let sql = format!(
            "DELETE FROM {} WHERE {}",
            table_ref(dialect, &database, &table),
            where_clause(dialect, pk)?,
        );
        total += run_write(&state, &conn_id, &database, &sql).await?;
    }
    Ok(total)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn insert_row(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    values: Vec<CellRef>,
) -> AppResult<u64> {
    if values.is_empty() {
        return Err(AppError::Config("no values provided for the new row".to_string()));
    }
    let dialect = state.pool.get(&conn_id).await?.dialect();
    let columns: Vec<String> = values
        .iter()
        .map(|cell| quote_ident(dialect, &cell.column))
        .collect();
    let literals: Vec<String> = values
        .iter()
        .map(|cell| quote_lit(dialect, cell.value.as_deref()))
        .collect();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        table_ref(dialect, &database, &table),
        columns.join(", "),
        literals.join(", "),
    );
    run_write(&state, &conn_id, &database, &sql).await
}
