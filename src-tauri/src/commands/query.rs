use tauri::State;

pub(crate) use crate::core::restore::split_statements;
use crate::core::drivers::{
    ColumnInfo, DatabaseTable, ErSchema, QueryResult, TableInfo,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command(rename_all = "snake_case")]
pub async fn run_query(
    state: State<'_, AppState>,
    conn_id: String,
    sql: String,
    max_rows: Option<i64>,
    database: Option<String>,
    order_by: Option<String>,
) -> AppResult<QueryResult> {
    let sql = trim_sql(&sql);
    if sql.is_empty() {
        return Err(AppError::Config("SQL boşdur".to_string()));
    }

    let driver = state.pool.get(&conn_id).await?;
    let mut statements = split_statements(sql, driver.dialect());
    if statements.is_empty() {
        return Err(AppError::Config("SQL boşdur".to_string()));
    }
    if let Some(order_by) = order_by
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(last) = statements.last_mut() {
            *last = with_order_by(last, order_by);
        }
    }

    let limit = max_rows.unwrap_or(1000).clamp(1, 100_000);
    driver.run_statements(&statements, limit, database).await
}

fn trim_sql(sql: &str) -> &str {
    sql.trim().trim_end_matches(';').trim_end()
}

fn with_order_by(sql: &str, order_by: &str) -> String {
    let body = sql.trim().trim_end_matches(';').trim_end();
    // ASCII-only uppercasing keeps byte offsets identical to `body` (to_uppercase can change lengths, e.g. ß → SS).
    let upper = body.to_ascii_uppercase();
    let limit_at = upper.rfind("\nLIMIT ");
    match limit_at {
        Some(index) => format!(
            "{}\nORDER BY {}{}",
            &body[..index],
            order_by,
            &body[index..]
        ),
        None => format!("{body}\nORDER BY {order_by}"),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_databases(state: State<'_, AppState>, conn_id: String) -> AppResult<Vec<String>> {
    let driver = state.pool.get(&conn_id).await?;
    driver.list_databases().await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_tables(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> AppResult<Vec<TableInfo>> {
    let driver = state.pool.get(&conn_id).await?;
    driver.list_tables(&database).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_all_tables(
    state: State<'_, AppState>,
    conn_id: String,
) -> AppResult<Vec<DatabaseTable>> {
    let driver = state.pool.get(&conn_id).await?;
    driver.list_all_tables().await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_columns(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    let driver = state.pool.get(&conn_id).await?;
    driver.list_columns(&database, &table).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn get_er_schema(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> AppResult<ErSchema> {
    let driver = state.pool.get(&conn_id).await?;
    driver.get_er_schema(Some(&database)).await
}

#[cfg(test)]
mod dollar_tests {
    use super::split_statements;
    use crate::core::drivers::Dialect;

    #[test]
    fn postgres_dollar_quoted_function_body_stays_one_statement() {
        let sql = "CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  IF length(NEW.name) < 2 THEN RAISE EXCEPTION 'short'; END IF;\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;\nSELECT 1;";
        let parts = split_statements(sql, Dialect::Postgres);
        assert_eq!(parts.len(), 2, "{parts:?}");
        assert!(parts[0].ends_with("$$ LANGUAGE plpgsql"));
        assert_eq!(parts[1], "SELECT 1");
    }

    #[test]
    fn postgres_tagged_dollar_quotes_and_parameters() {
        let sql = "DO $body$ BEGIN PERFORM 1; END $body$; SELECT $1::int; SELECT 'a$$b';";
        let parts = split_statements(sql, Dialect::Postgres);
        assert_eq!(parts.len(), 3, "{parts:?}");
        assert_eq!(parts[0], "DO $body$ BEGIN PERFORM 1; END $body$");
        assert_eq!(parts[1], "SELECT $1::int");
    }

    #[test]
    fn postgres_double_dash_comment_without_space_hides_semicolon() {
        let parts = split_statements("SELECT 1 --x;y\n;SELECT 2", Dialect::Postgres);
        assert_eq!(parts, vec!["SELECT 1 --x;y".to_string(), "SELECT 2".to_string()]);
    }

    #[test]
    fn hash_is_not_a_comment_outside_mysql() {
        let parts = split_statements("SELECT 5 # 3; SELECT 2", Dialect::Postgres);
        assert_eq!(parts.len(), 2, "{parts:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::{split_statements, trim_sql};
    use crate::core::drivers::Dialect;

    fn split_with(sql: &str, dialect: Dialect) -> Vec<String> {
        split_statements(trim_sql(sql), dialect)
    }

    fn split(sql: &str) -> Vec<String> {
        split_with(sql, Dialect::Postgres)
    }

    fn expected(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn splits_top_level_statements() {
        assert_eq!(
            split("SELECT 1; SELECT 2;"),
            expected(&["SELECT 1", "SELECT 2"])
        );
    }

    #[test]
    fn keeps_semicolons_in_strings_and_identifiers() {
        assert_eq!(
            split("SELECT ';' AS a; SELECT \"x;y\"; SELECT `a;b` FROM t"),
            expected(&["SELECT ';' AS a", "SELECT \"x;y\"", "SELECT `a;b` FROM t",])
        );
    }

    #[test]
    fn ignores_semicolons_inside_comments() {
        assert_eq!(
            split("SELECT 1 -- ; still comment\n; SELECT 2 /* ; */;"),
            expected(&["SELECT 1 -- ; still comment", "SELECT 2 /* ; */"])
        );
    }

    #[test]
    fn drops_comment_only_statements() {
        assert_eq!(
            split("SELECT 1; -- trailing comment"),
            expected(&["SELECT 1"])
        );
        assert!(split("-- only a comment").is_empty());
    }

    #[test]
    fn handles_doubled_quotes() {
        assert_eq!(
            split("SELECT 'it''s; ok'; SELECT 2"),
            expected(&["SELECT 'it''s; ok'", "SELECT 2"])
        );
    }

    #[test]
    fn treats_backslash_as_an_escape_only_for_mysql() {
        let sql = "SELECT 'C:\\'; SELECT 2;";
        assert_eq!(
            split_with(sql, Dialect::Postgres),
            expected(&["SELECT 'C:\\'", "SELECT 2"])
        );
        assert_eq!(
            split_with(sql, Dialect::Sqlite),
            expected(&["SELECT 'C:\\'", "SELECT 2"])
        );
        assert_eq!(
            split_with(sql, Dialect::Mssql),
            expected(&["SELECT 'C:\\'", "SELECT 2"])
        );
        assert_eq!(
            split_with(sql, Dialect::Mysql),
            expected(&["SELECT 'C:\\'; SELECT 2"])
        );
        assert_eq!(
            split_with(sql, Dialect::Clickhouse),
            expected(&["SELECT 'C:\\'; SELECT 2"])
        );
    }

    #[test]
    fn keeps_semicolons_in_sql_server_bracket_identifiers() {
        assert_eq!(
            split_with("SELECT [a;b] FROM t; SELECT 2", Dialect::Mssql),
            expected(&["SELECT [a;b] FROM t", "SELECT 2"])
        );
        assert_eq!(
            split_with("SELECT [a]]b] FROM t; SELECT 2", Dialect::Mssql),
            expected(&["SELECT [a]]b] FROM t", "SELECT 2"])
        );
    }
}
