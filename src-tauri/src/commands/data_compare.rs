//! Data compare: rows of one table in two databases, matched by primary key.
//! The target side is held in memory (keys + normalised values); the source is
//! streamed against it. The result is counts, samples and a sync script that
//! makes the target equal to the source. Nothing is written here.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::commands::edit::{quote_ident, table_ref};
use crate::commands::export::read_table;
use crate::core::backup::value_literal;
use crate::core::drivers::{ColumnInfo, Dialect};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const PAGE_SIZE: i64 = 2_000;
const MAX_TARGET_ROWS: usize = 1_000_000;
const MAX_SAMPLES: usize = 200;
const MAX_SCRIPT_ROWS: u64 = 5_000;

#[derive(Debug, Serialize)]
pub struct DiffSample {
    /// "changed", "only_source" or "only_target".
    pub kind: &'static str,
    pub key: Vec<Value>,
    /// Columns that differ (changed rows only).
    pub columns: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct DataDiff {
    pub key: Vec<String>,
    pub columns: Vec<String>,
    pub skipped_columns: Vec<String>,
    pub same: u64,
    pub changed: u64,
    pub only_source: u64,
    pub only_target: u64,
    pub samples: Vec<DiffSample>,
    /// INSERT/UPDATE/DELETE for the target; None when there are too many differences.
    pub sync_sql: Option<String>,
}

/// One comparable form for values that different drivers report differently:
/// 1 / true, "1.50" / 1.5, "2024-01-01T10:00:00Z" / "2024-01-01 10:00:00".
pub(crate) fn normalize(value: &Value) -> String {
    match value {
        Value::Null => "\u{0}NULL".to_string(),
        Value::Bool(flag) => if *flag { "1" } else { "0" }.to_string(),
        Value::Number(number) => normalize_text(&number.to_string()),
        Value::String(text) => normalize_text(text),
        other => other.to_string(),
    }
}

fn normalize_text(text: &str) -> String {
    let trimmed = text.trim();
    if let Ok(int) = trimmed.parse::<i128>() {
        return int.to_string();
    }
    if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) {
        if let Ok(float) = trimmed.parse::<f64>() {
            return if float.fract() == 0.0 && float.abs() < 1e15 {
                (float as i64).to_string()
            } else {
                float.to_string()
            };
        }
    }
    let bytes = trimmed.as_bytes();
    let datetime = bytes.len() >= 16
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && (bytes[10] == b'T' || bytes[10] == b' ')
        && bytes[13] == b':';
    if datetime {
        let mut value = trimmed.replacen('T', " ", 1);
        for suffix in ["Z", "+00:00", "+00"] {
            if let Some(rest) = value.strip_suffix(suffix) {
                value = rest.to_string();
            }
        }
        if value.contains('.') {
            value = value.trim_end_matches('0').trim_end_matches('.').to_string();
        }
        return value;
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(json) = serde_json::from_str::<Value>(trimmed) {
            return json.to_string();
        }
    }
    text.to_string()
}

fn key_of(row: &[Value], width: usize) -> String {
    row[..width]
        .iter()
        .map(normalize)
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

struct Script {
    dialect: Dialect,
    target: String,
    names: Vec<String>,
    types: Vec<String>,
    key_width: usize,
    sql: String,
    rows: u64,
}

impl Script {
    fn literal(&self, index: usize, value: &Value) -> String {
        value_literal(self.dialect, &self.types[index], value)
    }

    fn condition(&self, key: &[Value]) -> String {
        key.iter()
            .enumerate()
            .map(|(index, value)| {
                format!("{} = {}", quote_ident(self.dialect, &self.names[index]), self.literal(index, value))
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    }

    fn push(&mut self, statement: String) {
        self.rows += 1;
        if self.rows <= MAX_SCRIPT_ROWS {
            self.sql.push_str(&statement);
            self.sql.push_str(";\n");
        }
    }

    fn insert(&mut self, row: &[Value]) {
        let columns: Vec<String> = self.names.iter().map(|name| quote_ident(self.dialect, name)).collect();
        let values: Vec<String> = row.iter().enumerate().map(|(index, value)| self.literal(index, value)).collect();
        let statement = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            self.target,
            columns.join(", "),
            values.join(", ")
        );
        self.push(statement);
    }

    fn update(&mut self, row: &[Value], changed: &[usize]) {
        let set: Vec<String> = changed
            .iter()
            .map(|&index| format!("{} = {}", quote_ident(self.dialect, &self.names[index]), self.literal(index, &row[index])))
            .collect();
        let statement = format!(
            "UPDATE {} SET {} WHERE {}",
            self.target,
            set.join(", "),
            self.condition(&row[..self.key_width])
        );
        self.push(statement);
    }

    fn delete(&mut self, key: &[Value]) {
        let statement = format!("DELETE FROM {} WHERE {}", self.target, self.condition(key));
        self.push(statement);
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn compare_table_data(
    state: State<'_, AppState>,
    source_conn: String,
    source_db: String,
    target_conn: String,
    target_db: String,
    table: String,
) -> AppResult<DataDiff> {
    let source = state.pool.get(&source_conn).await?;
    let target = state.pool.get(&target_conn).await?;
    for driver in [&source, &target] {
        if matches!(driver.dialect(), Dialect::Mongodb | Dialect::Redis) {
            return Err(AppError::Config(format!("data compare is not available for {}", driver.dialect())));
        }
    }

    let source_columns = source.list_columns(&source_db, &table).await?;
    let target_columns = target.list_columns(&target_db, &table).await?;
    if source_columns.is_empty() {
        return Err(AppError::Config(format!("“{table}” was not found in the source")));
    }
    if target_columns.is_empty() {
        return Err(AppError::Config(format!("“{table}” was not found in the target")));
    }

    // Key columns first, then the other shared columns, as (source, target) pairs.
    let mut pairs: Vec<(&ColumnInfo, &ColumnInfo)> = Vec::new();
    let mut skipped = Vec::new();
    let is_key = |column: &ColumnInfo| column.key.as_deref() == Some("PRI");
    for column in source_columns.iter().filter(|c| is_key(*c)).chain(source_columns.iter().filter(|c| !is_key(*c))) {
        match target_columns.iter().find(|item| item.name.eq_ignore_ascii_case(&column.name)) {
            Some(item) => pairs.push((column, item)),
            None if is_key(column) => {
                return Err(AppError::Config(format!(
                    "the target has no key column “{}”",
                    column.name
                )))
            }
            None => skipped.push(column.name.clone()),
        }
    }
    let key_width = source_columns.iter().filter(|c| is_key(*c)).count();
    if key_width == 0 {
        return Err(AppError::Config(format!(
            "“{table}” has no primary key in the source — rows cannot be matched"
        )));
    }
    let key_types: Vec<String> = pairs[..key_width].iter().map(|(s, _)| s.data_type.clone()).collect();
    let target_key_types: Vec<String> = pairs[..key_width].iter().map(|(_, t)| t.data_type.clone()).collect();
    let source_read: Vec<String> = pairs.iter().map(|(s, _)| s.name.clone()).collect();
    let target_read: Vec<String> = pairs.iter().map(|(_, t)| t.name.clone()).collect();

    // Target: key -> (normalised values, raw key).
    let mut existing: HashMap<String, (Vec<String>, Vec<Value>)> = HashMap::new();
    let mut too_many = false;
    {
        let mut on_batch = |batch: Vec<Vec<Value>>| -> AppResult<bool> {
            for row in batch {
                if existing.len() >= MAX_TARGET_ROWS {
                    too_many = true;
                    return Ok(false);
                }
                let values = row.iter().map(normalize).collect();
                existing.insert(key_of(&row, key_width), (values, row[..key_width].to_vec()));
            }
            Ok(true)
        };
        read_table(
            target.as_ref(),
            target.dialect(),
            &target_db,
            &table,
            &target_read,
            &target_read[..key_width],
            &target_key_types,
            PAGE_SIZE,
            &mut on_batch,
        )
        .await?;
    }
    if too_many {
        return Err(AppError::Config(format!(
            "the target table has more than {MAX_TARGET_ROWS} rows — compare a filtered copy instead"
        )));
    }

    let mut diff = DataDiff {
        key: source_read[..key_width].to_vec(),
        columns: source_read.clone(),
        skipped_columns: skipped,
        ..DataDiff::default()
    };
    let mut script = Script {
        dialect: target.dialect(),
        target: table_ref(target.dialect(), &target_db, &table),
        names: target_read.clone(),
        types: pairs.iter().map(|(_, t)| t.data_type.clone()).collect(),
        key_width,
        sql: String::new(),
        rows: 0,
    };
    {
        let mut on_batch = |batch: Vec<Vec<Value>>| -> AppResult<bool> {
            for row in batch {
                match existing.remove(&key_of(&row, key_width)) {
                    Some((values, _)) => {
                        let changed: Vec<usize> = (key_width..row.len())
                            .filter(|&index| normalize(&row[index]) != values[index])
                            .collect();
                        if changed.is_empty() {
                            diff.same += 1;
                            continue;
                        }
                        diff.changed += 1;
                        if diff.samples.len() < MAX_SAMPLES {
                            diff.samples.push(DiffSample {
                                kind: "changed",
                                key: row[..key_width].to_vec(),
                                columns: changed.iter().map(|&index| source_read[index].clone()).collect(),
                            });
                        }
                        script.update(&row, &changed);
                    }
                    None => {
                        diff.only_source += 1;
                        if diff.samples.len() < MAX_SAMPLES {
                            diff.samples.push(DiffSample {
                                kind: "only_source",
                                key: row[..key_width].to_vec(),
                                columns: Vec::new(),
                            });
                        }
                        script.insert(&row);
                    }
                }
            }
            Ok(true)
        };
        read_table(
            source.as_ref(),
            source.dialect(),
            &source_db,
            &table,
            &source_read,
            &source_read[..key_width],
            &key_types,
            PAGE_SIZE,
            &mut on_batch,
        )
        .await?;
    }

    let mut leftover: Vec<Vec<Value>> = existing.into_values().map(|(_, key)| key).collect();
    leftover.sort_by_cached_key(|key| key_of(key, key_width));
    for key in leftover {
        diff.only_target += 1;
        if diff.samples.len() < MAX_SAMPLES {
            diff.samples.push(DiffSample {
                kind: "only_target",
                key: key.clone(),
                columns: Vec::new(),
            });
        }
        script.delete(&key);
    }

    if script.rows > 0 && script.rows <= MAX_SCRIPT_ROWS {
        diff.sync_sql = Some(script.sql);
    }
    Ok(diff)
}

#[cfg(test)]
mod tests {
    use super::normalize;
    use serde_json::json;

    #[test]
    fn normalizes_values_that_drivers_report_differently() {
        assert_eq!(normalize(&json!(true)), normalize(&json!(1)));
        assert_eq!(normalize(&json!("1.50")), normalize(&json!(1.5)));
        assert_eq!(normalize(&json!("10")), normalize(&json!(10.0)));
        assert_eq!(normalize(&json!("2024-01-01T10:00:00Z")), normalize(&json!("2024-01-01 10:00:00")));
        assert_eq!(normalize(&json!("2024-01-01 10:00:00.500000")), "2024-01-01 10:00:00.5");
        assert_eq!(normalize(&json!("{\"a\": 1}")), normalize(&json!({"a": 1})));
        assert_ne!(normalize(&json!(null)), normalize(&json!("")));
        assert_ne!(normalize(&json!("9007199254740993")), normalize(&json!("9007199254740992")));
        assert_ne!(normalize(&json!("abc")), normalize(&json!("abd")));
    }
}
