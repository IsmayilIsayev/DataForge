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
            // PostgreSQL uses E'...' so backslashes stay escaped even when the
            // server runs with standard_conforming_strings=off.
            let escaped = match dialect {
                Dialect::Mysql | Dialect::Postgres => {
                    v.replace('\\', "\\\\").replace('\'', "''")
                }
                _ => v.replace('\'', "''"),
            };
            match dialect {
                Dialect::Postgres => format!("E'{escaped}'"),
                _ => format!("'{escaped}'"),
            }
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

fn insert_sql(
    dialect: Dialect,
    database: &str,
    table: &str,
    values: &[CellRef],
) -> AppResult<String> {
    let target = table_ref(dialect, database, table);
    if values.is_empty() {
        // Every column is on DEFAULT: let the database generate the row. MySQL
        // spells this as an empty column/value list, Postgres/SQLite use the
        // standard DEFAULT VALUES form.
        return match dialect {
            Dialect::Mysql => Ok(format!("INSERT INTO {target} () VALUES ()")),
            Dialect::Postgres | Dialect::Sqlite => {
                Ok(format!("INSERT INTO {target} DEFAULT VALUES"))
            }
            _ => Err(AppError::Config(
                "this dialect does not support insert-with-defaults".to_string(),
            )),
        };
    }

    let columns: Vec<String> = values
        .iter()
        .map(|cell| quote_ident(dialect, &cell.column))
        .collect();
    let literals: Vec<String> = values
        .iter()
        .map(|cell| quote_lit(dialect, cell.value.as_deref()))
        .collect();
    Ok(format!(
        "INSERT INTO {target} ({}) VALUES ({})",
        columns.join(", "),
        literals.join(", "),
    ))
}

fn delete_sql(
    dialect: Dialect,
    database: &str,
    table: &str,
    rows: &[Vec<CellRef>],
) -> AppResult<String> {
    let mut predicates: Vec<String> = Vec::with_capacity(rows.len());
    for pk in rows {
        let predicate = where_clause(dialect, pk)?;
        if rows.len() > 1 {
            predicates.push(format!("({predicate})"));
        } else {
            predicates.push(predicate);
        }
    }
    Ok(format!(
        "DELETE FROM {} WHERE {}",
        table_ref(dialect, database, table),
        predicates.join(" OR "),
    ))
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
    if rows.is_empty() {
        return Ok(0);
    }
    let dialect = state.pool.get(&conn_id).await?.dialect();
    // One statement with an OR of PK predicates keeps a multi-row delete
    // all-or-nothing: if one row is protected, the database rolls back the
    // whole statement instead of leaving earlier rows deleted.
    let sql = delete_sql(dialect, &database, &table, &rows)?;
    run_write(&state, &conn_id, &database, &sql).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn insert_row(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    values: Vec<CellRef>,
) -> AppResult<u64> {
    let dialect = state.pool.get(&conn_id).await?.dialect();
    let sql = insert_sql(dialect, &database, &table, &values)?;
    run_write(&state, &conn_id, &database, &sql).await
}

#[cfg(test)]
mod tests {
    use super::{delete_sql, insert_sql, quote_lit, CellRef};
    use crate::core::drivers::Dialect;

    fn cell(column: &str, value: &str) -> CellRef {
        CellRef {
            column: column.to_string(),
            value: Some(value.to_string()),
        }
    }

    #[test]
    fn insert_with_no_explicit_columns_uses_default_values() {
        assert_eq!(
            insert_sql(Dialect::Postgres, "", "users", &[]).unwrap(),
            "INSERT INTO \"users\" DEFAULT VALUES"
        );
        assert_eq!(
            insert_sql(Dialect::Sqlite, "", "users", &[]).unwrap(),
            "INSERT INTO \"users\" DEFAULT VALUES"
        );
        assert_eq!(
            insert_sql(Dialect::Mysql, "shop", "users", &[]).unwrap(),
            "INSERT INTO `shop`.`users` () VALUES ()"
        );
    }

    #[test]
    fn insert_with_explicit_columns_still_builds_a_normal_values_list() {
        assert_eq!(
            insert_sql(
                Dialect::Postgres,
                "",
                "users",
                &[cell("name", "Alice"), cell("age", "30")]
            )
            .unwrap(),
            "INSERT INTO \"users\" (\"name\", \"age\") VALUES (E'Alice', E'30')"
        );
    }

    #[test]
    fn postgres_literals_stay_closed_with_standard_conforming_strings_off() {
        assert_eq!(
            quote_lit(Dialect::Postgres, Some(r"\'; DROP TABLE users; --")),
            r"E'\\''; DROP TABLE users; --'"
        );
        assert_eq!(
            quote_lit(Dialect::Mysql, Some(r"\'; DROP TABLE users; --")),
            r"'\\''; DROP TABLE users; --'"
        );
        assert_eq!(
            quote_lit(Dialect::Sqlite, Some(r"\'; DROP TABLE users; --")),
            r"'\''; DROP TABLE users; --'"
        );
    }

    #[test]
    fn multi_row_delete_is_a_single_atomic_statement() {
        let sql = delete_sql(
            Dialect::Postgres,
            "",
            "users",
            &[vec![cell("id", "1")], vec![cell("id", "2")]],
        )
        .unwrap();
        assert_eq!(
            sql,
            "DELETE FROM \"users\" WHERE (\"id\" = E'1') OR (\"id\" = E'2')"
        );

        let single =
            delete_sql(Dialect::Sqlite, "", "users", &[vec![cell("id", "1")]]).unwrap();
        assert_eq!(single, "DELETE FROM \"users\" WHERE \"id\" = '1'");
    }
}
