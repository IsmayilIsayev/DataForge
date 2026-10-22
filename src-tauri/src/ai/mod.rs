pub mod client;
pub mod nl2sql;
pub mod prompts;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProvider {
    Openai,
    OpenaiCompatible,
    Google,
}

impl Default for AiProvider {
    fn default() -> Self {
        Self::Openai
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSettings {
    #[serde(default)]
    pub provider: AiProvider,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default = "default_schema_token_budget")]
    pub schema_token_budget: u32,
}

fn default_model() -> String {
    "gpt-4o-mini".to_string()
}

fn default_schema_token_budget() -> u32 {
    crate::ai::nl2sql::DEFAULT_SCHEMA_TOKEN_BUDGET
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: AiProvider::Openai,
            model: default_model(),
            base_url: None,
            schema_token_budget: default_schema_token_budget(),
        }
    }
}
