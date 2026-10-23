use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ai::nl2sql::{self, Nl2SqlResult};
use crate::ai::{client, prompts, AiKeyScope, AiProvider, AiSettings};
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
    let system = prompts::explain_system(language.as_deref());
    let raw = client::complete(&settings, &system, &sql).await?;

    nl2sql::parse_json::<AiExplainResult>(&raw)
        .map_err(|error| AppError::Ai(format!("JSON parse: {error}\nxam: {raw}")))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_has_key(state: State<'_, AppState>) -> AppResult<bool> {
    let settings = state.ai_settings().await;
    Ok(settings.key_matches_scope() && secrets::has_api_key())
}

#[cfg(test)]
mod tests {
    use super::base_url_allowed;

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
