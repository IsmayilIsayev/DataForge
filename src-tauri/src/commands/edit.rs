use serde::{Deserialize, Serialize};
use tauri::State;

use crate::core::drivers::Dialect;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// One column reference with its value, used for primary-key WHERE clauses and
/// for INSERT payloads. `value: None` means SQL NULL.
#[derive(Deserialize, Clone)]
pub struct CellRef {
    pub column: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// One queued grid change. The frontend collects these per tab and sends them
/// together on Save; preview and execution share this representation.
#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Change {
    Update {
        pk: Vec<CellRef>,
        column: String,
        value: Option<String>,
    },
    Delete {
        pk: Vec<CellRef>,
    },
    Insert {
        values: Vec<CellRef>,
    },
}

#[derive(Serialize)]
pub struct ApplyChangesOutcome {
    pub ok: bool,
    pub rows_affected: u64,
    pub statements: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_change: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct PlannedChange {
    change_index: usize,
    sql: String,
}

fn quote_ident(dialect: Dialect, name: &str) -> String {
    match dialect {
        Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        Dialect::Mssql => format!("[{}]", name.replace(']', "]]")),
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
                Dialect::Mssql => format!("N'{escaped}'"),
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
        Dialect::Mssql if !database.trim().is_empty() => format!(
            "{}.{}.{}",
            quote_ident(dialect, database),
            quote_ident(dialect, "dbo"),
            quoted
        ),
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
            Dialect::Postgres | Dialect::Sqlite | Dialect::Mssql => {
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

fn update_sql(
    dialect: Dialect,
    database: &str,
    table: &str,
    pk: &[CellRef],
    column: &str,
    value: Option<&str>,
) -> AppResult<String> {
    Ok(format!(
        "UPDATE {} SET {} = {} WHERE {}",
        table_ref(dialect, database, table),
        quote_ident(dialect, column),
        quote_lit(dialect, value),
        where_clause(dialect, pk)?,
    ))
}

/// Build statements in execution order (updates, deletes, inserts) while
/// remembering which queued change each statement came from.
fn plan_changes(
    dialect: Dialect,
    database: &str,
    table: &str,
    changes: &[Change],
) -> AppResult<Vec<PlannedChange>> {
    let mut plan = Vec::with_capacity(changes.len());

    for (change_index, change) in changes.iter().enumerate() {
        if let Change::Update { pk, column, value } = change {
            plan.push(PlannedChange {
                change_index,
                sql: update_sql(dialect, database, table, pk, column, value.as_deref())?,
            });
        }
    }

    for (change_index, change) in changes.iter().enumerate() {
        if let Change::Delete { pk } = change {
            plan.push(PlannedChange {
                change_index,
                sql: delete_sql(dialect, database, table, std::slice::from_ref(pk))?,
            });
        }
    }

    for (change_index, change) in changes.iter().enumerate() {
        if let Change::Insert { values } = change {
            plan.push(PlannedChange {
                change_index,
                sql: insert_sql(dialect, database, table, values)?,
            });
        }
    }

    Ok(plan)
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
    let sql = update_sql(dialect, &database, &table, &pk, &column, value.as_deref())?;
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

#[tauri::command(rename_all = "snake_case")]
pub async fn preview_changes(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    changes: Vec<Change>,
) -> AppResult<Vec<String>> {
    let dialect = state.pool.get(&conn_id).await?.dialect();
    Ok(plan_changes(dialect, &database, &table, &changes)?
        .into_iter()
        .map(|change| change.sql)
        .collect())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn apply_changes(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    changes: Vec<Change>,
) -> AppResult<ApplyChangesOutcome> {
    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect();
    let plan = plan_changes(dialect, &database, &table, &changes)?;
    let statements: Vec<String> = plan.iter().map(|change| change.sql.clone()).collect();

    let db = if database.trim().is_empty() {
        None
    } else {
        Some(database)
    };

    match driver.apply_transaction(&statements, db).await {
        Ok(rows_affected) => Ok(ApplyChangesOutcome {
            ok: true,
            rows_affected,
            statements,
            failed_change: None,
            error: None,
        }),
        Err(failure) => {
            let failed_change = failure
                .statement
                .and_then(|index| plan.get(index))
                .map(|change| change.change_index);
            Ok(ApplyChangesOutcome {
                ok: false,
                rows_affected: 0,
                statements,
                failed_change,
                error: Some(failure.error.to_string()),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{delete_sql, insert_sql, plan_changes, quote_lit, Change, CellRef};
    use crate::core::drivers::Dialect;

    fn cell(column: &str, value: &str) -> CellRef {
        CellRef {
            column: column.to_string(),
            value: Some(value.to_string()),
        }
    }

    fn update_change(column: &str, value: &str) -> Change {
        Change::Update {
            pk: vec![cell("id", "1")],
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
        assert_eq!(
            insert_sql(Dialect::Mssql, "shop", "users", &[]).unwrap(),
            "INSERT INTO [shop].[dbo].[users] DEFAULT VALUES"
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
        assert_eq!(
            quote_lit(Dialect::Mssql, Some(r"\'; DROP TABLE users; --")),
            r"N'\''; DROP TABLE users; --'"
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

    #[test]
    fn plans_updates_before_deletes_before_inserts() {
        let changes = vec![
            Change::Insert {
                values: vec![cell("name", "Ada")],
            },
            Change::Delete {
                pk: vec![cell("id", "2")],
            },
            update_change("name", "Grace"),
        ];

        let plan = plan_changes(Dialect::Postgres, "", "users", &changes).unwrap();

        assert_eq!(
            plan.iter().map(|item| item.sql.as_str()).collect::<Vec<_>>(),
            vec![
                "UPDATE \"users\" SET \"name\" = E'Grace' WHERE \"id\" = E'1'",
                "DELETE FROM \"users\" WHERE \"id\" = E'2'",
                "INSERT INTO \"users\" (\"name\") VALUES (E'Ada')",
            ]
        );
        assert_eq!(
            plan.iter()
                .map(|item| item.change_index)
                .collect::<Vec<_>>(),
            vec![2, 1, 0]
        );
    }

    #[test]
    fn mixed_change_set_keeps_each_change_mapped_to_its_statement() {
        let changes = vec![
            update_change("name", "Grace"),
            Change::Delete {
                pk: vec![cell("id", "7")],
            },
            update_change("email", "grace@example.com"),
            Change::Insert {
                values: vec![cell("id", "9"), cell("name", "Linus")],
            },
        ];

        let plan = plan_changes(Dialect::Mysql, "shop", "users", &changes).unwrap();
        let statements: Vec<&str> = plan.iter().map(|item| item.sql.as_str()).collect();

        assert_eq!(
            statements,
            vec![
                "UPDATE `shop`.`users` SET `name` = 'Grace' WHERE `id` = '1'",
                "UPDATE `shop`.`users` SET `email` = 'grace@example.com' WHERE `id` = '1'",
                "DELETE FROM `shop`.`users` WHERE `id` = '7'",
                "INSERT INTO `shop`.`users` (`id`, `name`) VALUES ('9', 'Linus')",
            ]
        );
        assert_eq!(
            plan.iter()
                .map(|item| item.change_index)
                .collect::<Vec<_>>(),
            vec![0, 2, 1, 3]
        );
    }
}
