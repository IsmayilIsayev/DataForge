use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ai::nl2sql::{self, Nl2SqlResult};
use crate::ai::{client, prompts, AiProvider, AiSettings};
use crate::core::secrets;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiExplainResult {
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfigView {
    pub provider: AiProvider,
    pub model: String,
    pub base_url: Option<String>,
    pub schema_token_budget: u32,
    pub has_key: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_get_config(state: State<'_, AppState>) -> AppResult<AiConfigView> {
    let settings = state.ai_settings().await;
    Ok(AiConfigView {
        provider: settings.provider,
        model: settings.model,
        base_url: settings.base_url,
        schema_token_budget: settings.schema_token_budget,
        has_key: secrets::has_api_key(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_set_config(
    state: State<'_, AppState>,
    provider: AiProvider,
    model: String,
    base_url: Option<String>,
    api_key: Option<String>,
    schema_token_budget: Option<u32>,
) -> AppResult<AiConfigView> {
    let current = state.ai_settings().await;
    let schema_token_budget = nl2sql::clamp_budget(
        schema_token_budget.unwrap_or(current.schema_token_budget),
    );
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

    if let Some(api_key) = api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        secrets::set_api_key(api_key)?;
    }

    let settings = AiSettings {
        provider,
        model,
        base_url: if provider == AiProvider::OpenaiCompatible {
            base_url
        } else {
            None
        },
        schema_token_budget,
    };
    state.set_ai_settings(settings.clone()).await?;

    Ok(AiConfigView {
        provider: settings.provider,
        model: settings.model,
        base_url: settings.base_url,
        schema_token_budget: settings.schema_token_budget,
        has_key: secrets::has_api_key(),
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
pub async fn ai_explain(state: State<'_, AppState>, sql: String) -> AppResult<AiExplainResult> {
    if sql.trim().is_empty() {
        return Err(AppError::Config("SQL boşdur".to_string()));
    }

    let settings = state.ai_settings().await;
    let raw = client::complete(&settings, prompts::explain_system(), &sql).await?;

    nl2sql::parse_json::<AiExplainResult>(&raw)
        .map_err(|error| AppError::Ai(format!("JSON parse: {error}\nxam: {raw}")))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_has_key() -> AppResult<bool> {
    Ok(secrets::has_api_key())
}
