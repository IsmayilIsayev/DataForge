use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ai::nl2sql::{self, Nl2SqlResult};
use crate::ai::{client, prompts, AiKeyScope, AiProvider, AiSettings};
use crate::core::drivers::QueryResult;
use crate::core::secrets;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Plain HTTP is only acceptable for a local model server; any other base URL
/// must use TLS so an API key is never sent in cleartext.
fn base_url_allowed(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return false;
    };

    match url.scheme() {
        "https" => true,
        "http" => matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
        ),
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiExplainResult {
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiFixResult {
    pub sql: String,
    pub explanation: String,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub needs_confirmation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiOptimizeResult {
    pub suggestions: Vec<String>,
    #[serde(default)]
    pub rewritten_sql: Option<String>,
}

fn language_name(code: Option<&str>) -> Option<&'static str> {
    let code = code?.trim();
    if code.eq_ignore_ascii_case("az") || code.eq_ignore_ascii_case("azerbaijani") {
        Some("Azerbaijani")
    } else if code.eq_ignore_ascii_case("en") || code.eq_ignore_ascii_case("english") {
        Some("English")
    } else {
        None
    }
}

fn fix_user_message(sql: &str, error: &str, schema: &str) -> String {
    format!(
        "SQL:\n{sql}\n\nDATABASE ERROR:\n{error}\n\nDATABASE SCHEMA (use these exact table and column names):\n{schema}"
    )
}

fn optimize_user_message(sql: &str, plan: Option<&str>) -> String {
    match plan.map(str::trim).filter(|value| !value.is_empty()) {
        Some(plan) => format!("SQL:\n{sql}\n\nEXPLAIN PLAN:\n{plan}"),
        None => format!(
            "SQL:\n{sql}\n\nEXPLAIN PLAN: not available (the database did not return a plan)."
        ),
    }
}

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

fn explainable_statement(sql: &str) -> Option<&str> {
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

fn explain_sql_for(dialect: &str, sql: &str) -> Option<String> {
    let statement = explainable_statement(sql)?;
    match dialect {
        "postgres" => Some(format!("EXPLAIN (FORMAT TEXT) {statement}")),
        "mysql" => Some(format!("EXPLAIN {statement}")),
        "sqlite" => Some(format!("EXPLAIN QUERY PLAN {statement}")),
        _ => None,
    }
}

fn plan_text(result: &QueryResult) -> String {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfigView {
    pub provider: AiProvider,
    pub model: String,
    pub base_url: Option<String>,
    pub has_key: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_get_config(state: State<'_, AppState>) -> AppResult<AiConfigView> {
    let settings = state.ai_settings().await;
    let has_key = settings.key_matches_scope() && secrets::has_api_key();
    Ok(AiConfigView {
        provider: settings.provider,
        model: settings.model,
        base_url: settings.base_url,
        has_key,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_set_config(
    state: State<'_, AppState>,
    provider: AiProvider,
    model: String,
    base_url: Option<String>,
    api_key: Option<String>,
) -> AppResult<AiConfigView> {
    let current = state.ai_settings().await;
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err(AppError::Config("AI model is required".to_string()));
    }

    let base_url = base_url
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty());

    if provider == AiProvider::OpenaiCompatible && base_url.is_none() {
        return Err(AppError::Config(
            "Base URL is required for OpenAI-compatible providers".to_string(),
        ));
    }

    if let Some(base_url) = base_url.as_deref() {
        if !base_url_allowed(base_url) {
            return Err(AppError::Config(
                "Base URL must use https:// (plain http:// is only allowed for localhost, 127.0.0.1 or ::1)."
                    .to_string(),
            ));
        }
    }

    let base_url = if provider == AiProvider::OpenaiCompatible {
        base_url
    } else {
        None
    };
    let scope = AiKeyScope {
        provider,
        base_url: base_url.clone(),
    };
    let new_api_key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let has_saved_key = secrets::has_api_key();

    let key_scope = if let Some(api_key) = new_api_key {
        secrets::set_api_key(api_key)?;
        Some(scope)
    } else if has_saved_key {
        if current.key_scope.as_ref() != Some(&scope) {
            return Err(AppError::Config(
                "The AI provider or base URL changed — re-enter the API key.".to_string(),
            ));
        }
        Some(scope)
    } else {
        None
    };

    let settings = AiSettings {
        provider,
        model,
        base_url,
        schema_token_budget: current.schema_token_budget,
        key_scope,
    };
    state.set_ai_settings(settings.clone()).await?;

    Ok(AiConfigView {
        provider: settings.provider,
        model: settings.model,
        base_url: settings.base_url,
        has_key: settings.key_scope.is_some(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_nl2sql(
    state: State<'_, AppState>,
    conn_id: String,
    question: String,
    include_schema: Option<bool>,
    database: Option<String>,
) -> AppResult<Nl2SqlResult> {
    let question = question.trim();
    if question.is_empty() {
        return Err(AppError::Config("Sual boşdur".to_string()));
    }

    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect_name();
    let settings = state.ai_settings().await;
    let schema = if include_schema.unwrap_or(true) {
        let snapshot = driver.get_schema(database.as_deref()).await?;
        nl2sql::build_schema_context(&snapshot, question, settings.schema_token_budget)
    } else {
        nl2sql::SchemaContext::empty()
    };

    eprintln!(
        "[ai_nl2sql] schema ~{} tokens, {} of {} tables with columns{}",
        schema.estimated_tokens,
        schema.tables_with_columns.len(),
        schema.total_tables,
        if schema.truncated { " (trimmed)" } else { "" }
    );

    nl2sql::nl2sql(&settings, dialect, &schema, question).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_explain(
    state: State<'_, AppState>,
    sql: String,
    language: Option<String>,
) -> AppResult<AiExplainResult> {
    if sql.trim().is_empty() {
        return Err(AppError::Config("SQL boşdur".to_string()));
    }

    let settings = state.ai_settings().await;
    let system = prompts::explain_system(language_name(language.as_deref()));
    let raw = client::complete(&settings, &system, &sql).await?;

    nl2sql::parse_json::<AiExplainResult>(&raw)
        .map_err(|error| AppError::Ai(format!("JSON parse: {error}\nxam: {raw}")))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_fix_error(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    sql: String,
    error: String,
) -> AppResult<AiFixResult> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err(AppError::Config("SQL boşdur".to_string()));
    }
    let error = error.trim();
    if error.is_empty() {
        return Err(AppError::Config("Xəta mətni boşdur".to_string()));
    }

    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect_name();
    let settings = state.ai_settings().await;
    let snapshot = driver.get_schema(database.as_deref()).await?;
    let schema = nl2sql::build_schema_context(&snapshot, sql, settings.schema_token_budget);

    let system = prompts::fix_error_system(dialect);
    let user = fix_user_message(sql, error, &schema.text);
    let raw = client::complete(&settings, &system, &user).await?;

    nl2sql::parse_json::<AiFixResult>(&raw)
        .map_err(|parse_error| AppError::Ai(format!("JSON parse: {parse_error}\nxam: {raw}")))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_optimize(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    sql: String,
) -> AppResult<AiOptimizeResult> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err(AppError::Config("SQL boşdur".to_string()));
    }

    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect_name();
    let settings = state.ai_settings().await;

    let plan = if let Some(explain_sql) = explain_sql_for(dialect, sql) {
        match driver.run_statements(&[explain_sql], 100, database).await {
            Ok(result) => Some(plan_text(&result)),
            Err(explain_error) => {
                eprintln!("[ai_optimize] EXPLAIN failed, continuing without a plan: {explain_error}");
                None
            }
        }
    } else {
        None
    };

    let system = prompts::optimize_system(dialect);
    let user = optimize_user_message(sql, plan.as_deref());
    let raw = client::complete(&settings, &system, &user).await?;

    nl2sql::parse_json::<AiOptimizeResult>(&raw)
        .map_err(|parse_error| AppError::Ai(format!("JSON parse: {parse_error}\nxam: {raw}")))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_has_key(state: State<'_, AppState>) -> AppResult<bool> {
    let settings = state.ai_settings().await;
    Ok(settings.key_matches_scope() && secrets::has_api_key())
}

#[cfg(test)]
mod tests {
    use super::{
        base_url_allowed, explain_sql_for, fix_user_message, language_name, optimize_user_message,
    };

    #[test]
    fn fix_user_message_includes_sql_error_and_schema() {
        let message = fix_user_message(
            "SELECT nope FROM users",
            "column nope does not exist",
            "users(id, name)",
        );
        assert!(message.contains("SELECT nope FROM users"));
        assert!(message.contains("column nope does not exist"));
        assert!(message.contains("users(id, name)"));
        assert!(message.contains("DATABASE SCHEMA"));
    }

    #[test]
    fn optimize_user_message_includes_the_plan_when_available() {
        let with_plan = optimize_user_message("SELECT * FROM users", Some("Seq Scan on users"));
        assert!(with_plan.contains("SELECT * FROM users"));
        assert!(with_plan.contains("Seq Scan on users"));

        let without_plan = optimize_user_message("SELECT * FROM users", None);
        assert!(without_plan.contains("not available"));
    }

    #[test]
    fn picks_explain_syntax_per_dialect() {
        assert_eq!(
            explain_sql_for("postgres", "SELECT 1"),
            Some("EXPLAIN (FORMAT TEXT) SELECT 1".to_string())
        );
        assert_eq!(
            explain_sql_for("mysql", "SELECT 1"),
            Some("EXPLAIN SELECT 1".to_string())
        );
        assert_eq!(
            explain_sql_for("sqlite", "SELECT 1"),
            Some("EXPLAIN QUERY PLAN SELECT 1".to_string())
        );
        assert_eq!(explain_sql_for("mssql", "SELECT 1"), None);
    }

    #[test]
    fn explain_handles_comments_semicolons_and_ctes() {
        assert_eq!(
            explain_sql_for("postgres", "-- why\n/* context */ SELECT 1;"),
            Some("EXPLAIN (FORMAT TEXT) SELECT 1".to_string())
        );
        assert_eq!(
            explain_sql_for("mysql", "WITH c AS (SELECT 1) SELECT * FROM c"),
            Some("EXPLAIN WITH c AS (SELECT 1) SELECT * FROM c".to_string())
        );
    }

    #[test]
    fn refuses_explain_for_writes_and_multiple_statements() {
        assert_eq!(
            explain_sql_for("postgres", "UPDATE users SET name = 'x'"),
            None
        );
        assert_eq!(explain_sql_for("mysql", "DELETE FROM users"), None);
        assert_eq!(
            explain_sql_for("sqlite", "INSERT INTO users(name) VALUES ('x')"),
            None
        );
        assert_eq!(
            explain_sql_for("postgres", "SELECT 1; DELETE FROM users"),
            None
        );
    }

    #[test]
    fn maps_ui_language_codes_to_prompt_languages() {
        assert_eq!(language_name(Some("az")), Some("Azerbaijani"));
        assert_eq!(language_name(Some("en")), Some("English"));
        assert_eq!(language_name(Some("fr")), None);
        assert_eq!(language_name(None), None);
    }

    #[test]
    fn https_base_urls_are_allowed() {
        assert!(base_url_allowed("https://api.openai.com/v1"));
        assert!(base_url_allowed("https://api.example.com/v1/"));
    }

    #[test]
    fn plain_http_is_only_allowed_for_loopback() {
        assert!(base_url_allowed("http://localhost:11434/v1"));
        assert!(base_url_allowed("http://127.0.0.1:1234/v1"));
        assert!(base_url_allowed("http://[::1]:4096/v1"));
        assert!(!base_url_allowed("http://attacker.example/v1"));
        assert!(!base_url_allowed("http://localhost.attacker.example/v1"));
    }

    #[test]
    fn other_schemes_are_rejected() {
        assert!(!base_url_allowed("ftp://example.com/v1"));
        assert!(!base_url_allowed("not a url"));
    }
}
