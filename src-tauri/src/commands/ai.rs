use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ai::nl2sql::{self, Nl2SqlResult};
use crate::ai::{client, prompts, AiKeyScope, AiProvider, AiSettings};
use crate::core::secrets;
use crate::error::{AppError, AppResult};
use crate::sql_util::{explainable_statement, result_text};
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

const MAX_CHAT_MESSAGES: usize = 12;
const MAX_RESULT_ROWS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageInput {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResultContext {
    #[serde(default)]
    pub sql: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Vec<serde_json::Value>>,
}

fn normalized_chat_role(role: &str) -> &'static str {
    if role.eq_ignore_ascii_case("assistant") {
        "assistant"
    } else {
        "user"
    }
}

fn clean_chat_messages(messages: &[ChatMessageInput]) -> Vec<ChatMessageInput> {
    messages
        .iter()
        .filter_map(|message| {
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }
            Some(ChatMessageInput {
                role: normalized_chat_role(&message.role).to_string(),
                content: content.to_string(),
            })
        })
        .collect()
}

fn trim_chat_messages(messages: &[ChatMessageInput]) -> &[ChatMessageInput] {
    let start = messages.len().saturating_sub(MAX_CHAT_MESSAGES);
    &messages[start..]
}

fn tsv_escape(value: &str) -> String {
    value
        .replace('\t', "\\t")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
}

fn tsv_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn build_result_tsv(columns: &[String], rows: &[Vec<serde_json::Value>]) -> String {
    let mut lines = Vec::with_capacity(rows.len().min(MAX_RESULT_ROWS) + 1);
    lines.push(
        columns
            .iter()
            .map(|column| tsv_escape(column))
            .collect::<Vec<_>>()
            .join("\t"),
    );

    for row in rows.iter().take(MAX_RESULT_ROWS) {
        lines.push(
            row.iter()
                .map(|value| tsv_escape(&tsv_value(value)))
                .collect::<Vec<_>>()
                .join("\t"),
        );
    }

    lines.join("\n")
}

fn result_context_text(context: &ChatResultContext) -> String {
    let mut text = String::from("\n\nUSER-PROVIDED QUERY RESULT (you did not fetch this):\n");
    if !context.sql.trim().is_empty() {
        text.push_str("SQL:\n");
        text.push_str(context.sql.trim());
        text.push('\n');
    }
    text.push_str("COLUMNS AND ROWS (TSV, up to 50 rows):\n");
    text.push_str(&build_result_tsv(&context.columns, &context.rows));
    text
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

fn explain_sql_for(dialect: &str, sql: &str) -> Option<String> {
    let statement = explainable_statement(sql)?;
    match dialect {
        "postgres" => Some(format!("EXPLAIN (FORMAT TEXT) {statement}")),
        "mysql" => Some(format!("EXPLAIN {statement}")),
        "sqlite" => Some(format!("EXPLAIN QUERY PLAN {statement}")),
        _ => None,
    }
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

const MODELS_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(15);

const GROQ_MODELS: &[&str] = &[
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
];
const OPENAI_MODELS: &[&str] = &["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o3-mini"];
const OPENROUTER_MODELS: &[&str] = &[
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.3-70b-instruct",
];
const OLLAMA_MODELS: &[&str] = &["llama3.1", "qwen2.5", "mistral", "deepseek-r1"];
const LMSTUDIO_MODELS: &[&str] = &["local-model", "qwen2.5", "mistral", "llama3.1"];
const LOCAL_MODELS: &[&str] = &["gpt-4o-mini", "gpt-4o", "anthropic/claude-3.5-sonnet"];
const GOOGLE_MODELS: &[&str] = &[
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
];

const NON_CHAT_MODEL_MARKERS: &[&str] = &[
    "whisper",
    "tts",
    "orpheus",
    "embed",
    "embedding",
    "guard",
    "safeguard",
    "moderation",
    "dall-e",
    "image",
    "audio",
    "transcribe",
    "rerank",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelList {
    pub models: Vec<String>,
    #[serde(default)]
    pub offline: bool,
}

#[derive(Deserialize)]
struct OpenAiModelsResponse {
    #[serde(default)]
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    #[serde(default)]
    id: String,
}

#[derive(Deserialize)]
struct GoogleModelsResponse {
    #[serde(default)]
    models: Vec<GoogleModel>,
}

#[derive(Deserialize)]
struct GoogleModel {
    #[serde(default)]
    name: String,
}

fn is_chat_model(id: &str) -> bool {
    let lower = id.to_lowercase();
    !NON_CHAT_MODEL_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

fn filter_chat_models(models: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut filtered = Vec::new();
    for model in models {
        let model = model.trim().to_string();
        if model.is_empty() || !is_chat_model(&model) || filtered.contains(&model) {
            continue;
        }
        filtered.push(model);
    }
    filtered
}

fn order_models(models: Vec<String>, selected: &str) -> Vec<String> {
    let selected = selected.trim();
    let mut models = filter_chat_models(models);
    models.sort_by(|left, right| {
        left.to_lowercase()
            .cmp(&right.to_lowercase())
            .then_with(|| left.cmp(right))
    });
    models.dedup_by(|left, right| left.as_str().eq_ignore_ascii_case(right.as_str()));

    if selected.is_empty() {
        return models;
    }

    match models.iter().position(|model| model == selected) {
        Some(index) => {
            let model = models.remove(index);
            models.insert(0, model);
        }
        None => models.insert(0, selected.to_string()),
    }
    models
}

fn parse_openai_models(raw: &str) -> AppResult<Vec<String>> {
    let parsed: OpenAiModelsResponse = serde_json::from_str(raw)
        .map_err(|error| AppError::Ai(format!("models parse: {error}")))?;
    Ok(parsed.data.into_iter().map(|model| model.id).collect())
}

fn parse_google_models(raw: &str) -> AppResult<Vec<String>> {
    let parsed: GoogleModelsResponse = serde_json::from_str(raw)
        .map_err(|error| AppError::Ai(format!("models parse: {error}")))?;
    Ok(parsed
        .models
        .into_iter()
        .map(|model| {
            model
                .name
                .trim()
                .trim_start_matches("models/")
                .to_string()
        })
        .collect())
}

fn static_models(settings: &AiSettings) -> Vec<String> {
    let base = settings
        .base_url
        .as_deref()
        .unwrap_or("")
        .to_lowercase();
    let presets: &[&str] = match settings.provider {
        AiProvider::Google => GOOGLE_MODELS,
        AiProvider::Openai => OPENAI_MODELS,
        AiProvider::OpenaiCompatible if base.contains("api.groq.com") => GROQ_MODELS,
        AiProvider::OpenaiCompatible if base.contains("openrouter.ai") => OPENROUTER_MODELS,
        AiProvider::OpenaiCompatible if base.contains(":11434") => OLLAMA_MODELS,
        AiProvider::OpenaiCompatible if base.contains(":1234") => LMSTUDIO_MODELS,
        AiProvider::OpenaiCompatible
            if base.contains("localhost") || base.contains("127.0.0.1") =>
        {
            LOCAL_MODELS
        }
        AiProvider::OpenaiCompatible => &[],
    };

    let mut models: Vec<String> = presets.iter().map(|model| model.to_string()).collect();
    if models.is_empty() && !settings.model.trim().is_empty() {
        models.push(settings.model.trim().to_string());
    }
    models
}

fn models_cache() -> &'static Mutex<HashMap<String, (Instant, Vec<String>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<String>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_models(key: &str) -> Option<Vec<String>> {
    let cache = models_cache().lock().ok()?;
    let (cached_at, models) = cache.get(key)?;
    (cached_at.elapsed() < MODELS_CACHE_TTL).then(|| models.clone())
}

fn cache_models(key: String, models: Vec<String>) {
    if let Ok(mut cache) = models_cache().lock() {
        cache.insert(key, (Instant::now(), models));
    }
}

fn provider_base_url(settings: &AiSettings) -> AppResult<String> {
    match settings.provider {
        AiProvider::Openai => Ok(client::OPENAI_BASE.to_string()),
        AiProvider::OpenaiCompatible => settings
            .base_url
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                AppError::Config("Base URL is required for OpenAI-compatible providers".to_string())
            }),
        AiProvider::Google => Err(AppError::Config(
            "Google uses its own models endpoint".to_string(),
        )),
    }
}

async fn fetch_models(settings: &AiSettings, api_key: &str) -> AppResult<Vec<String>> {
    let client = reqwest::Client::builder()
        .timeout(MODEL_LIST_TIMEOUT)
        .build()
        .map_err(|error| AppError::Ai(format!("HTTP client: {error}")))?;

    let (url, response) = match settings.provider {
        AiProvider::Openai | AiProvider::OpenaiCompatible => {
            let base = provider_base_url(settings)?;
            let url = format!("{}/models", base.trim_end_matches('/'));
            let response = client
                .get(url.as_str())
                .bearer_auth(api_key)
                .header("accept", "application/json")
                .send()
                .await
                .map_err(|error| AppError::Ai(format!("network: {}", error.without_url())))?;
            (url, response)
        }
        AiProvider::Google => {
            let response = client
                .get(client::GOOGLE_BASE)
                .query(&[("key", api_key)])
                .header("accept", "application/json")
                .send()
                .await
                .map_err(|error| AppError::Ai(format!("network: {}", error.without_url())))?;
            (client::GOOGLE_BASE.to_string(), response)
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::Ai(format!("models {url} {status}: {text}")));
    }

    let raw = response
        .text()
        .await
        .map_err(|error| AppError::Ai(format!("models response: {error}")))?;
    let models = match settings.provider {
        AiProvider::Google => parse_google_models(&raw)?,
        _ => parse_openai_models(&raw)?,
    };
    Ok(filter_chat_models(models))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_list_models(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> AppResult<AiModelList> {
    let settings = state.ai_settings().await;
    let cache_key = format!(
        "{:?}|{}",
        settings.provider,
        settings.base_url.as_deref().unwrap_or("")
    );

    let cached = if refresh.unwrap_or(false) {
        None
    } else {
        cached_models(&cache_key)
    };

    let fetched = match cached {
        Some(models) => Some(models),
        None => {
            if !settings.key_matches_scope() {
                None
            } else {
                match secrets::get_api_key() {
                    Ok(api_key) => match fetch_models(&settings, &api_key).await {
                        Ok(models) if !models.is_empty() => {
                            cache_models(cache_key, models.clone());
                            Some(models)
                        }
                        _ => None,
                    },
                    Err(_) => None,
                }
            }
        }
    };

    let (models, offline) = match fetched {
        Some(models) => (models, false),
        None => (static_models(&settings), true),
    };

    Ok(AiModelList {
        models: order_models(models, &settings.model),
        offline,
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
pub async fn ai_chat(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    messages: Vec<ChatMessageInput>,
    ui_language: Option<String>,
    result: Option<ChatResultContext>,
) -> AppResult<String> {
    let cleaned = clean_chat_messages(&messages);
    if cleaned.is_empty() {
        return Err(AppError::Config("Mesaj boşdur".to_string()));
    }
    let messages = trim_chat_messages(&cleaned);

    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect_name();
    let settings = state.ai_settings().await;

    let latest_user = messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.content.clone())
        .unwrap_or_default();
    let mut schema_question = latest_user;
    if let Some(context) = result.as_ref() {
        if !context.sql.trim().is_empty() {
            schema_question.push(' ');
            schema_question.push_str(context.sql.trim());
        }
    }

    let snapshot = driver.get_schema(database.as_deref()).await?;
    let schema = nl2sql::build_schema_context(
        &snapshot,
        &schema_question,
        settings.schema_token_budget,
    );

    eprintln!(
        "[ai_chat] {} messages, schema ~{} tokens, {} of {} tables with columns{}",
        messages.len(),
        schema.estimated_tokens,
        schema.tables_with_columns.len(),
        schema.total_tables,
        if schema.truncated { " (trimmed)" } else { "" }
    );

    let system = prompts::chat_system(
        dialect,
        language_name(ui_language.as_deref()),
        &schema.text,
    );

    let mut contents: Vec<String> = messages
        .iter()
        .map(|message| message.content.clone())
        .collect();
    if let Some(context) = result.as_ref() {
        if let Some(index) = messages.iter().rposition(|message| message.role == "user") {
            contents[index].push_str(&result_context_text(context));
        }
    }

    let turns: Vec<client::ChatTurn<'_>> = messages
        .iter()
        .zip(contents.iter())
        .map(|(message, content)| client::ChatTurn {
            role: message.role.as_str(),
            content: content.as_str(),
        })
        .collect();

    client::complete_messages(&settings, &system, &turns).await
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
    plan: Option<String>,
) -> AppResult<AiOptimizeResult> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err(AppError::Config("SQL boşdur".to_string()));
    }

    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect_name();
    let settings = state.ai_settings().await;

    let supplied_plan = plan
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let plan = if supplied_plan.is_some() {
        supplied_plan
    } else if let Some(explain_sql) = explain_sql_for(dialect, sql) {
        match driver.run_statements(&[explain_sql], 100, database).await {
            Ok(result) => Some(result_text(&result)),
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
        base_url_allowed, build_result_tsv, clean_chat_messages, explain_sql_for,
        filter_chat_models, fix_user_message, language_name, optimize_user_message, order_models,
        parse_openai_models, trim_chat_messages, ChatMessageInput,
    };

    #[test]
    fn keeps_only_chat_models_from_the_groq_catalog() {
        let catalog = vec![
            "qwen/qwen3.8-27b",
            "openai/gpt-oss-120b",
            "openai/gpt-oss-20b",
            "canopylabs/orpheus-v1",
            "meta-llama/llama-prompt-guard-2-86m",
            "openai/gpt-oss-safeguard-20b",
            "whisper-large-v3-turbo",
        ];
        let filtered = filter_chat_models(catalog.into_iter().map(str::to_string));
        assert_eq!(
            filtered,
            vec![
                "qwen/qwen3.8-27b".to_string(),
                "openai/gpt-oss-120b".to_string(),
                "openai/gpt-oss-20b".to_string()
            ]
        );
    }

    #[test]
    fn orders_models_with_the_selected_one_first_then_alphabetically() {
        let models = vec![
            "openai/gpt-oss-20b".to_string(),
            "qwen/qwen3.8-27b".to_string(),
            "openai/gpt-oss-120b".to_string(),
        ];
        assert_eq!(
            order_models(models, "openai/gpt-oss-20b"),
            vec![
                "openai/gpt-oss-20b".to_string(),
                "openai/gpt-oss-120b".to_string(),
                "qwen/qwen3.8-27b".to_string()
            ]
        );
    }

    #[test]
    fn keeps_the_selected_model_when_it_is_missing_from_the_list() {
        let models = vec!["openai/gpt-oss-120b".to_string()];
        assert_eq!(
            order_models(models, "my/custom-model"),
            vec![
                "my/custom-model".to_string(),
                "openai/gpt-oss-120b".to_string()
            ]
        );
    }

    #[test]
    fn parses_the_openai_models_response_shape() {
        let raw = r#"{"object":"list","data":[{"id":"gpt-4o-mini","object":"model"},{"id":"whisper-1","object":"model"}]}"#;
        assert_eq!(
            parse_openai_models(raw).unwrap(),
            vec!["gpt-4o-mini".to_string(), "whisper-1".to_string()]
        );
    }

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
    fn chat_messages_are_trimmed_to_the_last_twelve() {
        let messages: Vec<ChatMessageInput> = (0..15)
            .map(|index| {
                let role = if index % 2 == 0 { "user" } else { "assistant" };
                ChatMessageInput {
                    role: role.to_string(),
                    content: format!("message-{index}"),
                }
            })
            .collect();

        let trimmed = trim_chat_messages(&messages);
        assert_eq!(trimmed.len(), 12);
        assert_eq!(trimmed.first().unwrap().content, "message-3");
        assert_eq!(trimmed.last().unwrap().content, "message-14");
    }

    #[test]
    fn chat_messages_drop_empty_content_and_normalize_roles() {
        let messages = vec![
            ChatMessageInput {
                role: "system".to_string(),
                content: "  ".to_string(),
            },
            ChatMessageInput {
                role: "ASSISTANT".to_string(),
                content: " hello ".to_string(),
            },
            ChatMessageInput {
                role: "user".to_string(),
                content: "hi".to_string(),
            },
        ];

        let cleaned = clean_chat_messages(&messages);
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[0].role, "assistant");
        assert_eq!(cleaned[0].content, "hello");
        assert_eq!(cleaned[1].role, "user");
    }

    #[test]
    fn result_tsv_caps_rows_and_escapes_control_characters() {
        let rows = (0..60)
            .map(|index| {
                vec![
                    serde_json::json!(format!("row-{index}\tvalue\nnext")),
                    serde_json::json!(index),
                ]
            })
            .collect::<Vec<_>>();

        let tsv = build_result_tsv(&["name".to_string(), "id".to_string()], &rows);
        assert_eq!(tsv.lines().count(), 51);
        assert!(tsv.contains("row-0\\tvalue\\nnext"));
        assert!(tsv.contains("row-49\\tvalue\\nnext"));
        assert!(!tsv.contains("row-50"));
        assert!(!tsv.contains("row-0\tvalue"));
    }

    #[test]
    fn result_tsv_escapes_column_names() {
        let tsv = build_result_tsv(&["odd\tname".to_string()], &[]);
        assert_eq!(tsv, "odd\\tname");
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
