use std::collections::HashSet;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::ai::{client, prompts, AiSettings};
use crate::core::drivers::SchemaSnapshot;
use crate::error::AppResult;

pub const DEFAULT_SCHEMA_TOKEN_BUDGET: u32 = 3000;
pub const MIN_SCHEMA_TOKEN_BUDGET: u32 = 500;
pub const MAX_SCHEMA_TOKEN_BUDGET: u32 = 8000;
const MAX_SCHEMA_TABLES: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Nl2SqlResult {
    pub sql: String,
    pub explanation: String,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub needs_confirmation: bool,
    #[serde(default)]
    pub schema_tables: Vec<String>,
    #[serde(default)]
    pub schema_total_tables: usize,
    #[serde(default)]
    pub schema_tokens: usize,
    #[serde(default)]
    pub schema_truncated: bool,
    #[serde(default)]
    pub raw: String,
}

#[derive(Debug, Clone)]
pub struct SchemaContext {
    pub text: String,
    pub tables_with_columns: Vec<String>,
    pub total_tables: usize,
    pub estimated_tokens: usize,
    pub truncated: bool,
}

impl SchemaContext {
    pub fn empty() -> Self {
        Self {
            text: String::new(),
            tables_with_columns: Vec::new(),
            total_tables: 0,
            estimated_tokens: 0,
            truncated: false,
        }
    }
}

const STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by", "from",
    "show", "list", "get", "find", "give", "me", "all", "any", "each", "per", "last", "this",
    "that", "these", "those", "how", "many", "much", "what", "which", "who", "where", "when",
    "is", "are", "was", "were", "be", "been", "has", "have", "had", "do", "does", "did",
    "please", "top", "first", "most", "least", "recent", "new", "old", "data", "rows", "row",
    "record", "records", "value", "values",
];

const GENERIC_COLUMNS: &[&str] = &[
    "id",
    "created_at",
    "updated_at",
    "deleted_at",
    "created_by",
    "updated_by",
    "created",
    "updated",
];

pub fn clamp_budget(value: u32) -> u32 {
    value.clamp(MIN_SCHEMA_TOKEN_BUDGET, MAX_SCHEMA_TOKEN_BUDGET)
}

pub fn estimate_tokens(text: &str) -> usize {
    ((text.chars().count() as f64) / 3.5).ceil() as usize
}

fn canonical(word: &str) -> String {
    let mut value = word.to_lowercase();
    let length = value.len();
    if length > 4 {
        if value.ends_with("ies") {
            value.truncate(length - 3);
            value.push('y');
        } else if value.ends_with("ses")
            || value.ends_with("xes")
            || value.ends_with("zes")
            || value.ends_with("ches")
            || value.ends_with("shes")
        {
            value.truncate(length - 2);
        } else if value.ends_with('s') && !value.ends_with("ss") {
            value.truncate(length - 1);
        }
    }
    value
}

fn normalize_ascii(word: &str) -> String {
    word.chars()
        .map(|character| match character {
            'ə' | 'Ə' => 'e',
            'ı' | 'I' | 'İ' => 'i',
            'ş' | 'Ş' => 's',
            'ç' | 'Ç' => 'c',
            'ğ' | 'Ğ' => 'g',
            'ö' | 'Ö' => 'o',
            'ü' | 'Ü' => 'u',
            other => other,
        })
        .collect::<String>()
        .to_lowercase()
}

const AZ_SYNONYMS: &[(&str, &[&str])] = &[
    ("sifaris", &["order", "receipt", "sale"]),
    ("emeliyyat", &["operation"]),
    ("musteri", &["customer"]),
    ("mehsul", &["product", "item"]),
    ("satis", &["sale", "receipt"]),
    ("odenis", &["payment", "receipt"]),
    ("mebleg", &["amount", "total", "price", "sum"]),
    ("tarix", &["date", "created"]),
    ("qaytarma", &["return"]),
    ("qaytar", &["return"]),
    ("qaime", &["invoice"]),
    ("anbar", &["stock", "inventory", "warehouse"]),
    ("isci", &["employee", "staff", "hrm"]),
    ("sobe", &["department"]),
    ("istifadeci", &["user"]),
    ("rol", &["role"]),
    ("icaze", &["permission"]),
    ("kampaniya", &["campaign"]),
    ("endirim", &["discount"]),
    ("vergi", &["tax"]),
    ("hesab", &["account", "invoice"]),
    ("son", &["latest", "recent"]),
];

fn add_word(set: &mut HashSet<String>, word: &str) {
    let word = normalize_ascii(word.trim());
    if word.len() < 2 || STOPWORDS.contains(&word.as_str()) {
        return;
    }
    set.insert(canonical(&word));
    if let Some((_, synonyms)) = AZ_SYNONYMS
        .iter()
        .find(|(key, _)| *key == word.as_str())
    {
        for synonym in *synonyms {
            set.insert(canonical(synonym));
        }
    }
}

fn split_words(value: &str) -> Vec<String> {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(canonical)
        .filter(|part| part.len() >= 2)
        .collect()
}

fn extract_quoted(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut quoted = Vec::new();
    let mut index = 0;

    while index < chars.len() {
        let character = chars[index];
        let closing = match character {
            '"' => Some('"'),
            '\'' => Some('\''),
            '`' => Some('`'),
            '[' => Some(']'),
            _ => None,
        };
        let Some(closing) = closing else {
            index += 1;
            continue;
        };

        let start = index + 1;
        let mut end = start;
        while end < chars.len() && chars[end] != closing {
            end += 1;
        }
        if end < chars.len() {
            let content: String = chars[start..end].iter().collect();
            for part in content.split('.') {
                let part = part.trim();
                if !part.is_empty() {
                    quoted.push(part.to_lowercase());
                }
            }
            index = end + 1;
        } else {
            break;
        }
    }

    quoted
}

fn question_terms(question: &str) -> (HashSet<String>, HashSet<String>) {
    let mut words = HashSet::new();
    let mut quoted = HashSet::new();

    for word in question.split(|character: char| !character.is_alphanumeric() && character != '_') {
        add_word(&mut words, word);
    }

    for identifier in extract_quoted(question) {
        quoted.insert(identifier.clone());
        for word in split_words(&identifier) {
            words.insert(word);
        }
    }

    (words, quoted)
}

fn table_score(
    table_name: &str,
    columns: &[crate::core::drivers::ColumnInfo],
    words: &HashSet<String>,
    quoted: &HashSet<String>,
) -> u32 {
    let table_lower = table_name.to_lowercase();
    let table_words = split_words(table_name);
    let mut score = 0u32;

    if quoted.contains(&table_lower) {
        score += 60;
    } else if words.contains(&canonical(&table_lower)) {
        score += 24;
    }

    if !table_words.is_empty() && table_words.iter().all(|word| words.contains(word)) {
        score += 16;
    } else {
        score += table_words
            .iter()
            .filter(|word| words.contains(*word))
            .count() as u32
            * 3;
    }

    for column in columns {
        let column_lower = column.name.to_lowercase();
        if GENERIC_COLUMNS.contains(&column_lower.as_str()) {
            continue;
        }
        if quoted.contains(&column_lower) {
            score += 30;
            continue;
        }
        let column_words = split_words(&column.name);
        if column_words.is_empty() {
            continue;
        }
        if words.contains(&canonical(&column_lower)) {
            score += 6;
        } else if column_words.iter().all(|word| words.contains(word)) {
            score += 4;
        } else {
            score += column_words
                .iter()
                .filter(|word| words.contains(*word))
                .count() as u32;
        }
    }

    score
}

fn build_text(
    snapshot: &SchemaSnapshot,
    full_indexes: &[usize],
    full_set: &HashSet<usize>,
) -> String {
    let mut text = format!("DATABASE: {}\n", snapshot.database);
    if !full_indexes.is_empty() {
        text.push_str("TABLES WITH COLUMNS:\n");
        for index in full_indexes {
            let table = &snapshot.tables[*index];
            let columns: Vec<String> = table
                .columns
                .iter()
                .map(|column| format!("{} {}", column.name, column.data_type))
                .collect();
            text.push_str(&format!("{}({})\n", table.name, columns.join(", ")));
        }
    }

    let other: Vec<String> = snapshot
        .tables
        .iter()
        .enumerate()
        .filter(|(index, _)| !full_set.contains(index))
        .map(|(_, table)| table.name.clone())
        .collect();

    if !other.is_empty() {
        text.push_str("OTHER TABLES (names only): ");
        text.push_str(&other.join(", "));
        text.push('\n');
    }

    text
}

pub fn build_schema_context(
    snapshot: &SchemaSnapshot,
    question: &str,
    budget: u32,
) -> SchemaContext {
    let (words, quoted) = question_terms(question);
    let mut scored: Vec<(u32, String, usize)> = snapshot
        .tables
        .iter()
        .enumerate()
        .filter_map(|(index, table)| {
            let score = table_score(&table.name, &table.columns, &words, &quoted);
            (score > 0).then_some((score, table.name.to_lowercase(), index))
        })
        .collect();

    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.cmp(&right.1))
    });

    let candidate_count = scored.len().min(MAX_SCHEMA_TABLES);
    let mut full_indexes: Vec<usize> = scored
        .iter()
        .take(candidate_count)
        .map(|(_, _, index)| *index)
        .collect();
    let mut full_set: HashSet<usize> = full_indexes.iter().copied().collect();
    let mut text = build_text(snapshot, &full_indexes, &full_set);
    let mut tokens = estimate_tokens(&text);

    while tokens > clamp_budget(budget) as usize && !full_indexes.is_empty() {
        let demoted = full_indexes.pop().expect("full table list checked as non-empty");
        full_set.remove(&demoted);
        text = build_text(snapshot, &full_indexes, &full_set);
        tokens = estimate_tokens(&text);
    }

    SchemaContext {
        text,
        tables_with_columns: full_indexes
            .iter()
            .map(|index| snapshot.tables[*index].name.clone())
            .collect(),
        total_tables: snapshot.tables.len(),
        estimated_tokens: tokens,
        truncated: scored.len() > full_indexes.len(),
    }
}

pub async fn nl2sql(
    settings: &AiSettings,
    dialect: &str,
    schema: &SchemaContext,
    question: &str,
) -> AppResult<Nl2SqlResult> {
    let system = prompts::nl2sql_system(dialect, &schema.text);
    let raw = client::complete(settings, &system, question).await?;
    let (mut result, used_fallback) = parse_nl2sql_result(&raw);

    result.schema_tables = schema.tables_with_columns.clone();
    result.schema_total_tables = schema.total_tables;
    result.schema_tokens = schema.estimated_tokens;
    result.schema_truncated = schema.truncated;

    if used_fallback || result.sql.trim().is_empty() {
        #[cfg(debug_assertions)]
        eprintln!("[ai_nl2sql] raw model response:\n{raw}");
    }

    Ok(result)
}

pub fn parse_nl2sql_result(raw: &str) -> (Nl2SqlResult, bool) {
    let parsed = parse_json::<Nl2SqlResult>(raw).ok();
    let mut used_fallback = parsed
        .as_ref()
        .map(|result| result.sql.trim().is_empty())
        .unwrap_or(true);
    let mut result = parsed.unwrap_or_else(|| Nl2SqlResult {
        sql: String::new(),
        explanation: String::new(),
        warnings: Vec::new(),
        needs_confirmation: false,
        schema_tables: Vec::new(),
        schema_total_tables: 0,
        schema_tokens: 0,
        schema_truncated: false,
        raw: String::new(),
    });

    if result.sql.trim().is_empty() {
        if let Some(sql) = extract_fenced_sql(raw).or_else(|| extract_standalone_sql(raw)) {
            result.sql = sql;
            if result.explanation.trim().is_empty() {
                result.explanation = "Recovered SQL from the model response.".to_string();
            }
        } else {
            used_fallback = true;
        }
    }

    result.raw = raw.to_string();
    (result, used_fallback)
}

const SQL_KEYWORDS: &[&str] = &[
    "SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "SHOW", "DESCRIBE", "DESC", "EXPLAIN",
    "CREATE", "ALTER", "DROP", "TRUNCATE",
];

fn contains_sql_keyword(text: &str) -> bool {
    let upper = text.to_ascii_uppercase();
    SQL_KEYWORDS
        .iter()
        .any(|keyword| upper.contains(keyword))
}

fn extract_fenced_sql(raw: &str) -> Option<String> {
    let mut search_from = 0;

    while let Some(rest) = raw.get(search_from..) {
        let Some(relative_start) = rest.find("```") else {
            break;
        };
        let block_start = search_from + relative_start;
        let after_fence = block_start + 3;
        let line_end = raw[after_fence..]
            .find('\n')
            .map(|offset| after_fence + offset)
            .unwrap_or(raw.len());
        let first_line = raw[after_fence..line_end].trim();
        let info = first_line.to_ascii_lowercase();

        let content_start = if first_line.is_empty() {
            (line_end + 1).min(raw.len())
        } else if info == "sql" || info.starts_with("sql ") {
            (line_end + 1).min(raw.len())
        } else if info == "json" || info.starts_with("json ") {
            search_from = line_end.saturating_add(1).min(raw.len());
            continue;
        } else if contains_sql_keyword(first_line) {
            after_fence
        } else {
            search_from = line_end.saturating_add(1).min(raw.len());
            continue;
        };

        let close = raw[content_start..]
            .find("```")
            .map(|offset| content_start + offset);
        let content_end = close.unwrap_or(raw.len());
        let content = raw[content_start..content_end].trim();
        if contains_sql_keyword(content) {
            if let Some(statement) = extract_statement_at(content, 0) {
                return Some(statement);
            }
            return Some(content.trim_matches('`').trim().to_string());
        }

        search_from = close
            .map(|value| value + 3)
            .unwrap_or(raw.len())
            .min(raw.len());
    }

    None
}

fn extract_standalone_sql(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if !bytes[index].is_ascii_alphabetic() {
            index += 1;
            continue;
        }

        let previous_is_word = index > 0
            && (bytes[index - 1].is_ascii_alphanumeric() || bytes[index - 1] == b'_');
        if previous_is_word {
            index += 1;
            continue;
        }

        let mut matched = None;
        for keyword in SQL_KEYWORDS {
            let end = index + keyword.len();
            if end > bytes.len() {
                continue;
            }
            if !bytes[index..end].eq_ignore_ascii_case(keyword.as_bytes()) {
                continue;
            }
            let next_is_word =
                end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_');
            if next_is_word {
                continue;
            }
            if keyword_is_plausible(raw, index, end, keyword) {
                matched = Some(*keyword);
                break;
            }
        }

        if let Some(keyword) = matched {
            if let Some(statement) = extract_statement_at(raw, index) {
                if !statement.is_empty() {
                    return Some(statement);
                }
            }
            index += keyword.len();
        } else {
            index += 1;
        }
    }

    None
}

fn keyword_is_plausible(raw: &str, start: usize, end: usize, keyword: &str) -> bool {
    let rest = raw[end..].trim_start();
    let first_word = rest
        .split(|character: char| !character.is_alphanumeric() && character != '_' && character != '*')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    match keyword {
        "SELECT" => {
            rest.starts_with('*')
                || rest.starts_with('(')
                || (!first_word.is_empty()
                    && !matches!(
                        first_word.as_str(),
                        "the" | "me" | "this" | "that" | "a" | "an" | "all" | "data" | "rows"
                    ))
        }
        "WITH" => rest.to_ascii_uppercase().contains("SELECT"),
        "INSERT" => first_word == "into",
        "UPDATE" => rest.to_ascii_uppercase().contains(" SET "),
        "DELETE" => first_word == "from",
        "SHOW" => matches!(
            first_word.as_str(),
            "tables" | "databases" | "columns" | "create" | "index" | "variables" | "status"
                | "processlist"
        ),
        "DESC" | "DESCRIBE" => !first_word.is_empty(),
        "EXPLAIN" => !first_word.is_empty(),
        "CREATE" | "ALTER" | "DROP" => matches!(
            first_word.as_str(),
            "table" | "index" | "view" | "database" | "schema"
        ),
        "TRUNCATE" => first_word == "table",
        _ => {
            let _ = (start, end);
            false
        }
    }
}

fn extract_statement_at(raw: &str, start: usize) -> Option<String> {
    let text = raw.get(start..)?.trim_start();
    if text.is_empty() {
        return None;
    }

    let mut quote: Option<char> = None;
    let mut end = text.len();
    let mut chars = text.char_indices().peekable();

    while let Some((offset, character)) = chars.next() {
        if let Some(active) = quote {
            if character == active {
                if chars.peek().map(|(_, next)| *next) == Some(active) {
                    chars.next();
                } else {
                    quote = None;
                }
            }
            continue;
        }

        if character == '\'' || character == '"' || character == '`' {
            quote = Some(character);
            continue;
        }

        if character == ';' {
            end = offset + character.len_utf8();
            break;
        }

        if text[offset..].starts_with("```") {
            end = offset;
            break;
        }
    }

    let statement = text[..end]
        .trim()
        .trim_matches('`')
        .trim()
        .to_string();
    if statement.is_empty() {
        None
    } else {
        Some(statement)
    }
}

pub fn parse_json<T: DeserializeOwned>(raw: &str) -> Result<T, serde_json::Error> {
    let cleaned = strip_code_fence(raw);

    match serde_json::from_str::<T>(&cleaned) {
        Ok(value) => Ok(value),
        Err(original) => {
            if let (Some(start), Some(end)) = (cleaned.find('{'), cleaned.rfind('}')) {
                if start < end {
                    if let Ok(value) = serde_json::from_str::<T>(&cleaned[start..=end]) {
                        return Ok(value);
                    }
                }
            }
            Err(original)
        }
    }
}

fn strip_code_fence(raw: &str) -> String {
    let text = raw.trim();
    let text = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```JSON"))
        .or_else(|| text.strip_prefix("```"))
        .unwrap_or(text);
    text.strip_suffix("```").unwrap_or(text).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::{build_schema_context, estimate_tokens, parse_nl2sql_result};
    use crate::core::drivers::{ColumnInfo, SchemaSnapshot, SchemaTable};

    fn column(name: &str, data_type: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: true,
            key: None,
        }
    }

    fn fixture(table_count: usize) -> SchemaSnapshot {
        let tables = (0..table_count)
            .map(|index| {
                let name = if index == 17 {
                    "customers".to_string()
                } else if index == 41 {
                    "orders".to_string()
                } else {
                    format!("operational_table_{index}")
                };
                SchemaTable {
                    name,
                    columns: vec![
                        column("id", "bigint"),
                        column("customer_id", "bigint"),
                        column("status", "text"),
                        column("total", "numeric"),
                        column("created_at", "timestamp"),
                        column("updated_at", "timestamp"),
                    ],
                }
            })
            .collect();

        SchemaSnapshot {
            database: "shop".to_string(),
            tables,
        }
    }

    #[test]
    fn keeps_all_names_but_only_relevant_columns() {
        let snapshot = fixture(113);
        let context = build_schema_context(
            &snapshot,
            "Show customers with their orders and total per customer",
            3000,
        );

        assert_eq!(context.total_tables, 113);
        assert!(context.tables_with_columns.contains(&"customers".to_string()));
        assert!(context.tables_with_columns.contains(&"orders".to_string()));
        assert!(context.text.contains("OTHER TABLES"));
        assert!(context.text.contains("operational_table_0"));
        assert!(context.text.contains("operational_table_112"));
        assert!(context.estimated_tokens <= 3000);
        assert!(context.estimated_tokens < 8000);
    }

    #[test]
    fn demotes_tables_to_stay_under_a_small_budget() {
        let snapshot = fixture(113);
        let context = build_schema_context(&snapshot, "orders", 1500);
        assert_eq!(context.estimated_tokens, estimate_tokens(&context.text));
        assert!(context.tables_with_columns.len() <= 40);
        assert!(context.text.contains("orders(id bigint"));
    }

    #[test]
    fn uses_singular_match_for_table_names() {
        let snapshot = fixture(113);
        let context = build_schema_context(&snapshot, "customer totals", 3000);
        assert!(context.tables_with_columns.contains(&"customers".to_string()));
    }

    #[test]
    fn parses_strict_json() {
        let raw = r#"{"sql":"SELECT 1;","explanation":"one","warnings":[],"needs_confirmation":false}"#;
        let (result, fallback) = parse_nl2sql_result(raw);
        assert_eq!(result.sql, "SELECT 1;");
        assert_eq!(result.explanation, "one");
        assert!(!fallback);
        assert_eq!(result.raw, raw);
    }

    #[test]
    fn recovers_sql_from_fenced_block() {
        let raw = "Here is the query:\n```sql\nSELECT id, name FROM customers;\n```\nLet me know.";
        let (result, fallback) = parse_nl2sql_result(raw);
        assert_eq!(result.sql, "SELECT id, name FROM customers;");
        assert!(fallback);
        assert_eq!(result.raw, raw);
    }

    #[test]
    fn recovers_sql_from_plain_fence() {
        let raw = "The result:\n```\nSELECT COUNT(*) FROM receipts;\n```";
        let (result, _) = parse_nl2sql_result(raw);
        assert_eq!(result.sql, "SELECT COUNT(*) FROM receipts;");
    }

    #[test]
    fn handles_a_fence_at_end_of_string_without_newline() {
        let raw = "Here is the output:\n```text";
        let (result, fallback) = parse_nl2sql_result(raw);
        assert!(result.sql.is_empty());
        assert!(fallback);
    }

    #[test]
    fn recovers_standalone_statement() {
        let raw = "Use this query: SELECT id FROM customers WHERE id = 1;";
        let (result, _) = parse_nl2sql_result(raw);
        assert_eq!(result.sql, "SELECT id FROM customers WHERE id = 1;");
    }

    #[test]
    fn empty_sql_keeps_explanation_and_raw() {
        let raw = r#"{"sql":"","explanation":"The schema has no matching table.","warnings":[],"needs_confirmation":false}"#;
        let (result, fallback) = parse_nl2sql_result(raw);
        assert!(result.sql.is_empty());
        assert_eq!(result.explanation, "The schema has no matching table.");
        assert_eq!(result.raw, raw);
        assert!(fallback);
    }
}
