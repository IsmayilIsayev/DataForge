//! Small SQL helpers shared by the AI and execution-plan commands.

use crate::core::drivers::QueryResult;

fn strip_leading_trivia(mut sql: &str) -> &str {
    loop {
        sql = sql.trim_start();
        if let Some(rest) = sql.strip_prefix("--") {
            sql = rest.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
        } else if let Some(rest) = sql.strip_prefix("/*") {
            sql = rest.split_once("*/").map(|(_, tail)| tail).unwrap_or("");
        } else {
            return sql;
        }
    }
}

fn first_keyword(statement: &str) -> &str {
    let end = statement
        .find(|character: char| !character.is_ascii_alphabetic())
        .unwrap_or(statement.len());
    &statement[..end]
}

/// Return the statement only when it is one read-only `SELECT` / `WITH`
/// statement that can be prefixed with an EXPLAIN clause. This also makes
/// `EXPLAIN ANALYZE` safe: it can never be pointed at a write statement.
pub(crate) fn explainable_statement(sql: &str) -> Option<&str> {
    let trimmed = sql.trim();
    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();
    if trimmed.is_empty() || trimmed.contains(';') {
        return None;
    }

    let statement = strip_leading_trivia(trimmed).trim();
    let keyword = first_keyword(statement);
    if keyword.eq_ignore_ascii_case("select") || keyword.eq_ignore_ascii_case("with") {
        Some(statement)
    } else {
        None
    }
}

/// Render a query result as the plain text used in AI prompts and in the raw
/// plan viewer (one row per line, cells separated by ` | `).
pub(crate) fn result_text(result: &QueryResult) -> String {
    let mut text = String::new();
    if result.columns.len() > 1 {
        text.push_str(&result.columns.join(" | "));
        text.push('\n');
    }
    for row in &result.rows {
        let cells: Vec<String> = row
            .iter()
            .map(|value| match value {
                serde_json::Value::Null => "NULL".to_string(),
                serde_json::Value::String(value) => value.clone(),
                other => other.to_string(),
            })
            .collect();
        text.push_str(&cells.join(" | "));
        text.push('\n');
    }
    text.trim_end().to_string()
}
