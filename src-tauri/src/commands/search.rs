use futures::stream::{self, StreamExt};
use serde::Serialize;
use tauri::State;

use crate::core::drivers::Dialect;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MAX_TABLES: usize = 100;
const ROWS_PER_TABLE: i64 = 3;
const MAX_HITS: usize = 200;
/// How many per-table data queries run at once. Kept at/under the smallest
/// driver pool (Postgres uses 5) so a remote DB such as Neon is never starved,
/// while still overlapping round-trips for a big speed-up over serial scanning.
const CONCURRENCY: usize = 4;

#[derive(Serialize)]
pub struct SearchHit {
    /// "table" | "column" | "data"
    pub kind: String,
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

fn quote_ident(dialect: Dialect, name: &str) -> String {
    match dialect {
        Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        Dialect::Mssql => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn is_text_type(data_type: &str) -> bool {
    let t = data_type.to_ascii_lowercase();
    ["char", "text", "string", "clob", "json", "enum", "set", "uuid", "name", "citext"]
        .iter()
        .any(|needle| t.contains(needle))
}

fn like_literal(dialect: Dialect, term: &str) -> String {
    // Escape LIKE wildcards, the escape character itself and the quote, then
    // wrap for a "contains" match.
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
        .replace('\'', "''");
    if dialect == Dialect::Mssql {
        format!("N'%{escaped}%'")
    } else {
        format!("'%{escaped}%'")
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

#[tauri::command(rename_all = "snake_case")]
pub async fn find_in_database(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    term: String,
    case_insensitive: bool,
    include_data: bool,
    only_table: Option<String>,
) -> AppResult<Vec<SearchHit>> {
    let needle = term.trim().to_string();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect();
    let schema = driver.get_schema(Some(&database)).await?;

    // Unicode-aware lowercasing so non-ASCII letters (ə, ı, ş, ç, ğ, ö, ü, …)
    // match regardless of case — ASCII-only folding silently dropped them.
    let lower = needle.to_lowercase();
    let mut hits: Vec<SearchHit> = Vec::new();

    // When scoped to a single table, restrict the whole search to it.
    let tables: Vec<_> = match &only_table {
        Some(name) => schema.tables.iter().filter(|t| &t.name == name).collect(),
        None => schema.tables.iter().collect(),
    };

    // 1) Structure: table + column name matches (always).
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

    // 2) Data: scan text columns of each table for the term. Each table is one
    // query; the queries run concurrently (bounded) instead of one after another,
    // which is the main speed-up on remote databases with round-trip latency.
    if include_data {
        let like = if case_insensitive && dialect == Dialect::Postgres {
            "ILIKE"
        } else {
            "LIKE"
        };
        let pattern = like_literal(dialect, &needle);
        let escape = like_escape_clause(dialect);

        // Build one SQL job per table that has text columns.
        let jobs: Vec<(String, String)> = tables
            .iter()
            .take(MAX_TABLES)
            .filter_map(|table| {
                let text_cols: Vec<&String> = table
                    .columns
                    .iter()
                    .filter(|c| is_text_type(&c.data_type))
                    .map(|c| &c.name)
                    .collect();
                if text_cols.is_empty() {
                    return None;
                }
                // Postgres has strict types: uuid/json/jsonb/enum columns reject
                // ILIKE directly ("operator does not exist: uuid ~~* unknown"),
                // so cast every searched column to text first. MySQL's text types
                // match LIKE as-is.
                let where_parts: Vec<String> = text_cols
                    .iter()
                    .map(|name| {
                        let col = quote_ident(dialect, name);
                        let expr = if dialect == Dialect::Postgres {
                            format!("{col}::text")
                        } else {
                            col
                        };
                        format!("{expr} {like} {pattern}{escape}")
                    })
                    .collect();
                let select_cols: Vec<String> = text_cols
                    .iter()
                    .map(|name| {
                        let col = quote_ident(dialect, name);
                        if dialect == Dialect::Postgres {
                            format!("{col}::text AS {col}")
                        } else {
                            col
                        }
                    })
                    .collect();
                let table_ref = match dialect {
                    Dialect::Mysql => format!(
                        "{}.{}",
                        quote_ident(dialect, &database),
                        quote_ident(dialect, &table.name)
                    ),
                    Dialect::Mssql => format!(
                        "{}.{}.{}",
                        quote_ident(dialect, &database),
                        quote_ident(dialect, "dbo"),
                        quote_ident(dialect, &table.name)
                    ),
                    _ => quote_ident(dialect, &table.name),
                };
                let sql = format!(
                    "SELECT {} FROM {} WHERE {}",
                    select_cols.join(", "),
                    table_ref,
                    where_parts.join(" OR "),
                );
                Some((table.name.clone(), sql))
            })
            .collect();

        // Run the jobs concurrently, at most CONCURRENCY in flight at once.
        let results = stream::iter(jobs.into_iter().map(|(table_name, sql)| {
            let driver = driver.clone();
            let database = database.clone();
            async move {
                let outcome = driver
                    .run_statements(&[sql], ROWS_PER_TABLE, Some(database))
                    .await;
                (table_name, outcome)
            }
        }))
        .buffer_unordered(CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

        let mut first_error: Option<AppError> = None;
        for (table_name, outcome) in results {
            if hits.len() >= MAX_HITS {
                break;
            }
            let result = match outcome {
                Ok(result) => result,
                Err(error) => {
                    // Remember the first failure so a totally empty result can
                    // report WHY instead of looking like "nothing matched".
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                    continue;
                }
            };
            for row in &result.rows {
                // Prefer the exact column whose text contains the term; fall back
                // to the first text cell so DB-level matches that a strict
                // substring check can't reproduce (e.g. MySQL accent-insensitive
                // collations) still surface as a hit.
                let mut best: Option<(usize, &String)> = None;
                let mut fallback: Option<(usize, &String)> = None;
                for (index, cell) in row.iter().enumerate() {
                    if let serde_json::Value::String(text) = cell {
                        if fallback.is_none() && !text.is_empty() {
                            fallback = Some((index, text));
                        }
                        if text.to_lowercase().contains(&lower) {
                            best = Some((index, text));
                            break;
                        }
                    }
                }
                if let Some((index, text)) = best.or(fallback) {
                    let mut snippet = text.clone();
                    if snippet.chars().count() > 120 {
                        snippet = snippet.chars().take(120).collect::<String>() + "…";
                    }
                    hits.push(SearchHit {
                        kind: "data".into(),
                        table: table_name.clone(),
                        column: result.columns.get(index).cloned(),
                        value: Some(snippet),
                    });
                }
                if hits.len() >= MAX_HITS {
                    break;
                }
            }
        }

        // If nothing matched anywhere AND a query failed, the empty result is a
        // failure, not a genuine "no matches" — surface the cause to the user.
        if hits.is_empty() {
            if let Some(error) = first_error {
                return Err(error);
            }
        }
    }

    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::{like_escape_clause, like_literal};
    use crate::core::drivers::Dialect;

    #[test]
    fn escapes_backslashes_and_wildcards() {
        assert_eq!(like_literal(Dialect::Mysql, "100%"), "'%100\\%%'");
        assert_eq!(like_literal(Dialect::Mysql, "a_b"), "'%a\\_b%'");
        assert_eq!(like_literal(Dialect::Mysql, "a\\b"), "'%a\\\\b%'");
        assert_eq!(
            like_literal(Dialect::Mssql, "O'Brien"),
            "N'%O''Brien%'"
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
