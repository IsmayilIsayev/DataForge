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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiKeyScope {
    pub provider: AiProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
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
    /// Provider + base URL the stored keychain key belongs to. Missing for
    /// settings written by older builds, which forces the key to be re-entered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_scope: Option<AiKeyScope>,
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
            key_scope: None,
        }
    }
}

impl AiSettings {
    pub fn current_key_scope(&self) -> AiKeyScope {
        AiKeyScope {
            provider: self.provider,
            base_url: if self.provider == AiProvider::OpenaiCompatible {
                self.base_url.clone()
            } else {
                None
            },
        }
    }

    pub fn key_matches_scope(&self) -> bool {
        self.key_scope
            .as_ref()
            .is_some_and(|scope| scope == &self.current_key_scope())
    }
}

#[cfg(test)]
mod tests {
    use super::{AiKeyScope, AiProvider, AiSettings};

    #[test]
    fn key_scope_tracks_provider_and_base_url() {
        let mut settings = AiSettings {
            provider: AiProvider::OpenaiCompatible,
            base_url: Some("https://api.example.com/v1".to_string()),
            key_scope: Some(AiKeyScope {
                provider: AiProvider::OpenaiCompatible,
                base_url: Some("https://api.example.com/v1".to_string()),
            }),
            ..AiSettings::default()
        };
        assert!(settings.key_matches_scope());

        settings.base_url = Some("https://attacker.example/v1".to_string());
        assert!(!settings.key_matches_scope());

        settings.key_scope = Some(AiKeyScope {
            provider: AiProvider::Openai,
            base_url: None,
        });
        assert!(!settings.key_matches_scope());
    }

    #[test]
    fn legacy_settings_without_a_scope_do_not_match() {
        let settings = AiSettings::default();
        assert!(!settings.key_matches_scope());
    }
}
