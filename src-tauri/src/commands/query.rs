use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tauri::State;
use uuid::Uuid;

pub(crate) use crate::core::restore::split_statements;
use crate::core::drivers::{
    BatchResult, BoundParam, ColumnInfo, DatabaseTable, Dialect, ErSchema, ParamValue, RunParam,
    TableInfo,
};
use crate::core::query_cancel::{RunCancel, RunningQuery};
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
    run_id: Option<String>,
    params: Option<Vec<RunParam>>,
) -> AppResult<BatchResult> {
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

    let params = params.unwrap_or_default();
    let mut rewritten = Vec::with_capacity(statements.len());
    let mut statement_params = Vec::with_capacity(statements.len());
    for statement in &statements {
        let (sql, bound) = rewrite_params(statement, driver.dialect(), &params)?;
        rewritten.push(sql);
        statement_params.push(bound);
    }
    let statements = rewritten;

    let limit = max_rows.unwrap_or(1000).clamp(1, 100_000);
    let run_id = run_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let Some(run_id) = run_id else {
        return driver
            .run_statements_batch(&statements, statement_params, limit, database)
            .await;
    };
    if Uuid::parse_str(&run_id).is_err() {
        return Err(AppError::Config("invalid run id".to_string()));
    }

    let cancel = Arc::new(RunCancel::new(run_id.clone()));
    let run = Arc::new(RunningQuery::new(cancel.clone(), Some(driver.clone())));
    let _guard = state.runs.register(run_id, run.clone());

    let execution =
        driver.run_statements_cancellable_batch(&statements, statement_params, limit, database, &cancel);
    tokio::pin!(execution);
    tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            // Stop polling the query, then ask the server to cancel it on a
            // different connection. The request is bounded so the UI never
            // hangs on a slow/unreachable cancel.
            let _ = tokio::time::timeout(
                Duration::from_millis(750),
                run.cancel_on_server(),
            )
            .await;
            Err(AppError::Cancelled(cancelled_message(driver.dialect(), &statements)))
        }
        result = &mut execution => result,
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn cancel_query(state: State<'_, AppState>, run_id: String) -> AppResult<bool> {
    Ok(state.runs.cancel(&run_id))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ParamScanState {
    Normal,
    SingleQuote,
    DoubleQuote,
    Backtick,
    Bracket,
    LineComment,
    BlockComment,
    Dollar,
}

fn is_tag_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// The `$tag$` opener at `index`, with its length, or `None`.
fn dollar_tag_at(bytes: &[u8], index: usize) -> Option<(&[u8], usize)> {
    if bytes.get(index) != Some(&b'$') {
        return None;
    }
    if index > 0 && is_tag_byte(bytes[index - 1]) {
        return None;
    }
    let mut end = index + 1;
    if bytes.get(end) == Some(&b'$') {
        return Some((&bytes[index..=end], end + 1 - index));
    }
    if !bytes
        .get(end)
        .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
    {
        return None;
    }
    end += 1;
    while end < bytes.len() && is_tag_byte(bytes[end]) {
        end += 1;
    }
    if bytes.get(end) == Some(&b'$') {
        return Some((&bytes[index..=end], end + 1 - index));
    }
    None
}

fn param_value(param: &RunParam) -> ParamValue {
    let raw = param.value.clone().unwrap_or_default();
    if param.param_type.eq_ignore_ascii_case("number") {
        ParamValue::Number(raw.trim().to_string())
    } else if param.param_type.eq_ignore_ascii_case("boolean") {
        let value = raw.trim().to_ascii_lowercase();
        ParamValue::Boolean(matches!(value.as_str(), "true" | "1" | "yes" | "on"))
    } else if param.param_type.eq_ignore_ascii_case("null") {
        ParamValue::Null
    } else {
        ParamValue::Text(raw)
    }
}

fn clickhouse_type(value: &ParamValue) -> &'static str {
    match value {
        ParamValue::Text(_) => "String",
        ParamValue::Number(value) => {
            if value.parse::<i64>().is_ok() {
                "Int64"
            } else {
                "Float64"
            }
        }
        ParamValue::Boolean(_) => "Bool",
        ParamValue::Null => "Nullable(String)",
    }
}

/// Rewrite `:name` placeholders to the driver's native style and return the
/// values to bind, in the order the placeholders appear. The scan mirrors the
/// frontend `findParams` and the restore statement splitter: strings, quoted
/// identifiers, comments, `$$` bodies and bracketed sections are skipped.
pub(crate) fn rewrite_params(
    sql: &str,
    dialect: Dialect,
    params: &[RunParam],
) -> AppResult<(String, Vec<BoundParam>)> {
    if params.is_empty() {
        return Ok((sql.to_string(), Vec::new()));
    }

    let lookup: HashMap<&str, &RunParam> = params
        .iter()
        .map(|param| (param.name.as_str(), param))
        .collect();
    let bytes = sql.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(sql.len());
    let mut bound = Vec::new();
    let mut counter = 0usize;
    let mut index = 0usize;
    let mut state = ParamScanState::Normal;
    let mut dollar_tag: Vec<u8> = Vec::new();

    while index < bytes.len() {
        let current = bytes[index];
        match state {
            ParamScanState::Normal => {
                if current == b'\'' {
                    state = ParamScanState::SingleQuote;
                    out.push(current);
                    index += 1;
                } else if current == b'"' {
                    state = ParamScanState::DoubleQuote;
                    out.push(current);
                    index += 1;
                } else if current == b'`' {
                    state = ParamScanState::Backtick;
                    out.push(current);
                    index += 1;
                } else if current == b'[' {
                    // Array slices (`[1:2]`) and bracketed identifiers.
                    state = ParamScanState::Bracket;
                    out.push(current);
                    index += 1;
                } else if current == b'$' && dialect == Dialect::Postgres {
                    if let Some((tag, length)) = dollar_tag_at(bytes, index) {
                        out.extend_from_slice(tag);
                        dollar_tag = tag.to_vec();
                        state = ParamScanState::Dollar;
                        index += length;
                    } else {
                        out.push(current);
                        index += 1;
                    }
                } else if current == b'-' && bytes.get(index + 1) == Some(&b'-') {
                    out.extend_from_slice(b"--");
                    state = ParamScanState::LineComment;
                    index += 2;
                } else if current == b'#' && dialect == Dialect::Mysql {
                    out.push(current);
                    state = ParamScanState::LineComment;
                    index += 1;
                } else if current == b'/' && bytes.get(index + 1) == Some(&b'*') {
                    out.extend_from_slice(b"/*");
                    state = ParamScanState::BlockComment;
                    index += 2;
                } else if current == b':' {
                    let next = bytes.get(index + 1).copied();
                    let previous = index.checked_sub(1).map(|at| bytes[at]);
                    let name_start = next.is_some_and(|byte| {
                        byte.is_ascii_alphabetic() || byte == b'_'
                    });
                    let previous_word = previous.is_some_and(|byte| {
                        byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
                    });
                    if next != Some(b':')
                        && next != Some(b'=')
                        && previous != Some(b':')
                        && !previous_word
                        && name_start
                    {
                        let mut end = index + 2;
                        while end < bytes.len()
                            && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_')
                        {
                            end += 1;
                        }
                        let name = std::str::from_utf8(&bytes[index + 1..end])
                            .unwrap_or_default()
                            .to_string();
                        let Some(param) = lookup.get(name.as_str()) else {
                            return Err(AppError::Config(format!(
                                "Missing value for parameter :{name}"
                            )));
                        };
                        let value = param_value(param);
                        let placeholder = match dialect {
                            Dialect::Postgres => {
                                counter += 1;
                                format!("${counter}")
                            }
                            Dialect::Mysql | Dialect::Sqlite => "?".to_string(),
                            Dialect::Mssql => {
                                counter += 1;
                                format!("@P{counter}")
                            }
                            Dialect::Clickhouse => {
                                format!("{{{}:{}}}", name, clickhouse_type(&value))
                            }
                            Dialect::Mongodb => "?".to_string(),
                        };
                        out.extend_from_slice(placeholder.as_bytes());
                        bound.push(BoundParam { name, value });
                        index = end;
                    } else {
                        out.push(current);
                        index += 1;
                    }
                } else {
                    out.push(current);
                    index += 1;
                }
            }
            ParamScanState::SingleQuote
            | ParamScanState::DoubleQuote
            | ParamScanState::Backtick
            | ParamScanState::Bracket => {
                let quote = match state {
                    ParamScanState::SingleQuote => b'\'',
                    ParamScanState::DoubleQuote => b'"',
                    ParamScanState::Bracket => b']',
                    _ => b'`',
                };
                let backslash_escapes = state != ParamScanState::Bracket;
                if backslash_escapes && current == b'\\' && index + 1 < bytes.len() {
                    out.push(current);
                    out.push(bytes[index + 1]);
                    index += 2;
                } else if current == quote {
                    if bytes.get(index + 1) == Some(&quote) {
                        out.push(current);
                        out.push(quote);
                        index += 2;
                    } else {
                        out.push(current);
                        state = ParamScanState::Normal;
                        index += 1;
                    }
                } else {
                    out.push(current);
                    index += 1;
                }
            }
            ParamScanState::LineComment => {
                out.push(current);
                if current == b'\n' {
                    state = ParamScanState::Normal;
                }
                index += 1;
            }
            ParamScanState::BlockComment => {
                if current == b'*' && bytes.get(index + 1) == Some(&b'/') {
                    out.extend_from_slice(b"*/");
                    state = ParamScanState::Normal;
                    index += 2;
                } else {
                    out.push(current);
                    index += 1;
                }
            }
            ParamScanState::Dollar => {
                if bytes[index..].starts_with(&dollar_tag) {
                    out.extend_from_slice(&dollar_tag);
                    index += dollar_tag.len();
                    state = ParamScanState::Normal;
                } else {
                    out.push(current);
                    index += 1;
                }
            }
        }
    }

    let rewritten = String::from_utf8(out)
        .map_err(|_| AppError::Config("SQL is not valid UTF-8".to_string()))?;
    Ok((rewritten, bound))
}

fn cancelled_message(
    dialect: crate::core::drivers::Dialect,
    statements: &[String],
) -> String {
    let explicit_transaction = statements.iter().any(|statement| {
        let first = statement
            .trim_start()
            .split(|c: char| c.is_whitespace() || c == ';' || c == '(')
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        first == "BEGIN" || first == "START"
    });

    if dialect == crate::core::drivers::Dialect::Postgres && explicit_transaction {
        "Query cancelled — the transaction was rolled back by the server".to_string()
    } else {
        "Query cancelled".to_string()
    }
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
mod param_tests {
    use super::rewrite_params;
    use crate::core::drivers::{BoundParam, Dialect, ParamValue, RunParam};

    fn param(name: &str, kind: &str, value: Option<&str>) -> RunParam {
        RunParam {
            name: name.to_string(),
            param_type: kind.to_string(),
            value: value.map(str::to_string),
        }
    }

    fn values(bound: &[BoundParam]) -> Vec<(&str, ParamValue)> {
        bound
            .iter()
            .map(|item| (item.name.as_str(), item.value.clone()))
            .collect()
    }

    #[test]
    fn postgres_numbers_placeholders_and_repeats_values_in_order() {
        let sql = "SELECT * FROM users WHERE id = :id AND status = :status AND id = :id";
        let params = [param("id", "Number", Some("7")), param("status", "Text", Some("active"))];
        let (rewritten, bound) = rewrite_params(sql, Dialect::Postgres, &params).unwrap();
        assert_eq!(
            rewritten,
            "SELECT * FROM users WHERE id = $1 AND status = $2 AND id = $3"
        );
        assert_eq!(
            values(&bound),
            vec![
                ("id", ParamValue::Number("7".to_string())),
                ("status", ParamValue::Text("active".to_string())),
                ("id", ParamValue::Number("7".to_string())),
            ]
        );
    }

    #[test]
    fn mysql_and_sqlite_use_question_marks_in_appearance_order() {
        let sql = "SELECT * FROM t WHERE a = :a OR b = :b OR a = :a";
        let params = [param("a", "Number", Some("1")), param("b", "Text", Some("x"))];
        let (mysql, mysql_bound) = rewrite_params(sql, Dialect::Mysql, &params).unwrap();
        assert_eq!(mysql, "SELECT * FROM t WHERE a = ? OR b = ? OR a = ?");
        assert_eq!(mysql_bound.len(), 3);

        let (sqlite, sqlite_bound) = rewrite_params(sql, Dialect::Sqlite, &params).unwrap();
        assert_eq!(sqlite, mysql);
        assert_eq!(sqlite_bound, mysql_bound);
    }

    #[test]
    fn mssql_uses_p_numbered_placeholders() {
        let sql = "SELECT * FROM t WHERE a = :a AND b = :b";
        let params = [param("a", "Boolean", Some("true")), param("b", "NULL", None)];
        let (rewritten, bound) = rewrite_params(sql, Dialect::Mssql, &params).unwrap();
        assert_eq!(rewritten, "SELECT * FROM t WHERE a = @P1 AND b = @P2");
        assert_eq!(
            values(&bound),
            vec![
                ("a", ParamValue::Boolean(true)),
                ("b", ParamValue::Null),
            ]
        );
    }

    #[test]
    fn clickhouse_uses_typed_braces() {
        let sql = "SELECT * FROM t WHERE id = :id AND price = :price AND ok = :ok AND gone = :gone";
        let params = [
            param("id", "Number", Some("7")),
            param("price", "Number", Some("1.5")),
            param("ok", "Boolean", Some("false")),
            param("gone", "NULL", None),
        ];
        let (rewritten, bound) = rewrite_params(sql, Dialect::Clickhouse, &params).unwrap();
        assert_eq!(
            rewritten,
            "SELECT * FROM t WHERE id = {id:Int64} AND price = {price:Float64} AND ok = {ok:Bool} AND gone = {gone:Nullable(String)}"
        );
        assert_eq!(bound.len(), 4);
    }

    #[test]
    fn casts_assignments_strings_comments_and_dollar_bodies_are_untouched() {
        let sql = "SELECT ':x', \"a:x\", `b:x`, [1:2], value::int, label := 1 -- :c\n/* :d */, $$ :e $$ FROM t";
        let params = [param("x", "Text", Some("1"))];
        let (rewritten, bound) = rewrite_params(sql, Dialect::Postgres, &params).unwrap();
        assert_eq!(rewritten, sql);
        assert!(bound.is_empty());
    }

    #[test]
    fn no_params_leaves_sql_unchanged() {
        let sql = "SELECT * FROM t WHERE id = :id";
        let (rewritten, bound) = rewrite_params(sql, Dialect::Postgres, &[]).unwrap();
        assert_eq!(rewritten, sql);
        assert!(bound.is_empty());
    }

    #[test]
    fn missing_value_is_an_error() {
        let result = rewrite_params("SELECT :missing", Dialect::Postgres, &[]);
        assert!(result.is_ok());
        let result = rewrite_params(
            "SELECT :missing",
            Dialect::Postgres,
            &[param("other", "Text", Some("x"))],
        );
        assert!(result.is_err());
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
