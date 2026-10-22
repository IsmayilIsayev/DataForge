use serde::Serialize;
use tauri::State;

use crate::core::drivers::Dialect;
use crate::error::AppResult;
use crate::state::AppState;

const MAX_TABLES: usize = 100;
const ROWS_PER_TABLE: i64 = 3;
const MAX_HITS: usize = 200;

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
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn is_text_type(data_type: &str) -> bool {
    let t = data_type.to_ascii_lowercase();
    ["char", "text", "string", "clob", "json", "enum", "set", "uuid", "name", "citext"]
        .iter()
        .any(|needle| t.contains(needle))
}

fn like_literal(term: &str) -> String {
    // Escape LIKE wildcards and the quote, wrap for a "contains" match.
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
        .replace('\'', "''");
    format!("'%{escaped}%'")
}

#[tauri::command(rename_all = "snake_case")]
pub async fn find_in_database(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    term: String,
    case_insensitive: bool,
    include_data: bool,
) -> AppResult<Vec<SearchHit>> {
    let needle = term.trim().to_string();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect();
    let schema = driver.get_schema(Some(&database)).await?;

    let lower = needle.to_ascii_lowercase();
    let mut hits: Vec<SearchHit> = Vec::new();

    // 1) Structure: table + column name matches (always).
    for table in &schema.tables {
        if table.name.to_ascii_lowercase().contains(&lower) {
            hits.push(SearchHit {
                kind: "table".into(),
                table: table.name.clone(),
                column: None,
                value: None,
            });
        }
        for column in &table.columns {
            if column.name.to_ascii_lowercase().contains(&lower) {
                hits.push(SearchHit {
                    kind: "column".into(),
                    table: table.name.clone(),
                    column: Some(column.name.clone()),
                    value: None,
                });
            }
        }
    }

    // 2) Data: scan text columns of each table for the term.
    if include_data {
        let like = if case_insensitive && dialect == Dialect::Postgres {
            "ILIKE"
        } else {
            "LIKE"
        };
        let pattern = like_literal(&needle);

        for table in schema.tables.iter().take(MAX_TABLES) {
            if hits.len() >= MAX_HITS {
                break;
            }
            let text_cols: Vec<&String> = table
                .columns
                .iter()
                .filter(|c| is_text_type(&c.data_type))
                .map(|c| &c.name)
                .collect();
            if text_cols.is_empty() {
                continue;
            }

            let where_parts: Vec<String> = text_cols
                .iter()
                .map(|name| {
                    format!("{} {} {}", quote_ident(dialect, name), like, pattern)
                })
                .collect();
            let select_cols: Vec<String> = text_cols
                .iter()
                .map(|name| quote_ident(dialect, name))
                .collect();

            let table_ref = match dialect {
                Dialect::Mysql => format!(
                    "{}.{}",
                    quote_ident(dialect, &database),
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

            let result = match driver
                .run_statements(&[sql], ROWS_PER_TABLE, Some(database.clone()))
                .await
            {
                Ok(result) => result,
                Err(_) => continue, // skip tables we can't read
            };

            for row in &result.rows {
                for (index, cell) in row.iter().enumerate() {
                    if let serde_json::Value::String(text) = cell {
                        if text.to_ascii_lowercase().contains(&lower) {
                            let mut snippet = text.clone();
                            if snippet.chars().count() > 120 {
                                snippet = snippet.chars().take(120).collect::<String>()
                                    + "…";
                            }
                            hits.push(SearchHit {
                                kind: "data".into(),
                                table: table.name.clone(),
                                column: result.columns.get(index).cloned(),
                                value: Some(snippet),
                            });
                            break;
                        }
                    }
                }
                if hits.len() >= MAX_HITS {
                    break;
                }
            }
        }
    }

    Ok(hits)
}
