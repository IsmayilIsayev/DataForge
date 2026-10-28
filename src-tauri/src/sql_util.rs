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

fn contains_data_modification(statement: &str) -> bool {
    let bytes = statement.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => {
                let quote = bytes[index];
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == quote {
                        if index + 1 < bytes.len() && bytes[index + 1] == quote {
                            index += 2;
                            continue;
                        }
                        index += 1;
                        break;
                    }
                    index += 1;
                }
            }
            b'[' => {
                index += 1;
                while index < bytes.len() && bytes[index] != b']' {
                    index += 1;
                }
                index += 1;
            }
            b'-' if index + 1 < bytes.len() && bytes[index + 1] == b'-' => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'*' => {
                index += 2;
                while index + 1 < bytes.len()
                    && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = index;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                {
                    index += 1;
                }
                let word = &statement[start..index];
                if matches!(
                    word.to_ascii_uppercase().as_str(),
                    "INSERT" | "UPDATE" | "DELETE" | "MERGE"
                ) {
                    return true;
                }
            }
            _ => index += 1,
        }
    }
    false
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
    if keyword.eq_ignore_ascii_case("select") {
        Some(statement)
    } else if keyword.eq_ignore_ascii_case("with")
        && !contains_data_modification(statement)
    {
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


#[cfg(test)]
mod tests {
    use super::explainable_statement;

    #[test]
    fn readonly_statements_are_explainable() {
        assert!(explainable_statement("SELECT 1").is_some());
        assert!(explainable_statement("WITH x AS (SELECT 1) SELECT * FROM x").is_some());
        assert!(explainable_statement("WITH x AS (SELECT 'UPDATE DELETE') SELECT * FROM x")
            .is_some());
    }

    #[test]
    fn data_modifying_ctes_are_rejected() {
        assert!(explainable_statement(
            "WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x"
        )
        .is_none());
        assert!(explainable_statement(
            "WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x"
        )
        .is_none());
        assert!(explainable_statement(
            "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"
        )
        .is_none());
        assert!(explainable_statement(
            "WITH x AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE) SELECT * FROM x"
        )
        .is_none());
    }
}
