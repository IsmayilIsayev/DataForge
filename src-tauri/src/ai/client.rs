use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::ai::{AiProvider, AiSettings};
use crate::core::secrets;
use crate::error::{AppError, AppResult};

const OPENAI_BASE: &str = "https://api.openai.com/v1";
const GOOGLE_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";

#[derive(Serialize)]
struct OpenAiRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}

#[derive(Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: &'static str,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct OpenAiResponse {
    #[serde(default)]
    choices: Vec<OpenAiChoice>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Deserialize)]
struct OpenAiMessage {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Serialize)]
struct GoogleRequest<'a> {
    #[serde(rename = "systemInstruction")]
    system_instruction: GoogleContent<'a>,
    contents: Vec<GoogleContent<'a>>,
    #[serde(rename = "generationConfig")]
    generation_config: GoogleGenerationConfig,
}

#[derive(Serialize)]
struct GoogleGenerationConfig {
    #[serde(rename = "responseMimeType")]
    response_mime_type: &'static str,
}

#[derive(Serialize)]
struct GoogleContent<'a> {
    parts: Vec<GooglePart<'a>>,
}

#[derive(Serialize)]
struct GooglePart<'a> {
    text: &'a str,
}

#[derive(Deserialize)]
struct GoogleResponse {
    #[serde(default)]
    candidates: Vec<GoogleCandidate>,
}

#[derive(Deserialize)]
struct GoogleCandidate {
    content: GoogleResponseContent,
}

#[derive(Deserialize)]
struct GoogleResponseContent {
    #[serde(default)]
    parts: Vec<GoogleResponsePart>,
}

#[derive(Deserialize)]
struct GoogleResponsePart {
    #[serde(default)]
    text: String,
}

pub async fn complete(settings: &AiSettings, system: &str, user: &str) -> AppResult<String> {
    let model = settings.model.trim();
    if model.is_empty() {
        return Err(AppError::Config("AI model is not configured".to_string()));
    }

    let api_key = secrets::get_api_key()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| AppError::Ai(format!("HTTP client: {error}")))?;

    match settings.provider {
        AiProvider::Openai | AiProvider::OpenaiCompatible => {
            let base = match settings.provider {
                AiProvider::Openai => OPENAI_BASE.to_string(),
                AiProvider::OpenaiCompatible => settings
                    .base_url
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        AppError::Config(
                            "Base URL is required for OpenAI-compatible providers".to_string(),
                        )
                    })?,
                AiProvider::Google => unreachable!(),
            };

            let url = format!("{}/chat/completions", base.trim_end_matches('/'));

            let mut use_json_format = true;
            loop {
                let body = OpenAiRequest {
                    model,
                    messages: vec![
                        ChatMessage {
                            role: "system",
                            content: system,
                        },
                        ChatMessage {
                            role: "user",
                            content: user,
                        },
                    ],
                    response_format: if use_json_format {
                        Some(ResponseFormat {
                            kind: "json_object",
                        })
                    } else {
                        None
                    },
                };

                let response = client
                    .post(url.as_str())
                    .bearer_auth(&api_key)
                    .header("content-type", "application/json")
                    .json(&body)
                    .send()
                    .await
                    .map_err(network_error)?;

                if !response.status().is_success() {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_default();
                    // Some providers/models reject response_format; retry once
                    // without it instead of failing the whole request.
                    if use_json_format
                        && status.as_u16() == 400
                        && text.to_lowercase().contains("response_format")
                    {
                        use_json_format = false;
                        continue;
                    }
                    return Err(AppError::Ai(format!("AI API {status}: {text}")));
                }

                let parsed: OpenAiResponse = response
                    .json()
                    .await
                    .map_err(|error| AppError::Ai(format!("response parse: {error}")))?;

                let text = parsed
                    .choices
                    .into_iter()
                    .next()
                    .and_then(|choice| choice.message.content)
                    .unwrap_or_default();

                return Ok(text);
            }
        }
        AiProvider::Google => {
            let model = model.trim_start_matches("models/");
            if model.is_empty()
                || !model.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
                })
            {
                return Err(AppError::Config("Invalid Google model name".to_string()));
            }

            let url = format!("{GOOGLE_BASE}/{model}:generateContent");
            let body = GoogleRequest {
                system_instruction: GoogleContent {
                    parts: vec![GooglePart { text: system }],
                },
                contents: vec![GoogleContent {
                    parts: vec![GooglePart { text: user }],
                }],
                generation_config: GoogleGenerationConfig {
                    response_mime_type: "application/json",
                },
            };

            let response = client
                .post(url)
                .query(&[("key", api_key)])
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(network_error)?;

            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                return Err(AppError::Ai(format!("AI API {status}: {text}")));
            }

            let parsed: GoogleResponse = response
                .json()
                .await
                .map_err(|error| AppError::Ai(format!("response parse: {error}")))?;

            let text = parsed
                .candidates
                .first()
                .and_then(|candidate| candidate.content.parts.first())
                .map(|part| part.text.clone())
                .unwrap_or_default();

            Ok(text)
        }
    }
}

fn network_error(error: reqwest::Error) -> AppError {
    AppError::Ai(format!("network: {}", error.without_url()))
}
