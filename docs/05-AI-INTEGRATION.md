# 05 — AI İnteqrasiyası (provayder-seçimli)

DataForge-un əsas fərqi. AI **Rust backend-dən** çağırılır (açar heç vaxt frontend-də deyil). App **Claude-a bağlı DEYİL** — provayder-seçimlidir: `openai_compatible` (OpenAI formatı) və `google` (Gemini). İstifadəçi Settings-də provayder + model + (lazımsa) base URL + açar seçir.

> Tarixçə: ilk dizayn yalnız Claude (`/v1/messages`) idi; aşağıdakı Rust nümunələrinin bəziləri həmin ilkin versiyadandır. Cari implementasiya `openai_compatible` + `google` klientidir (bax `ai/client.rs`).

## 0. Provayderlər və modellər (CARI — implementasiya olunmuş)

Hazır preset-lər (`AiPanel.tsx`):

| Preset | provider | base URL | default model |
|---|---|---|---|
| **OpenAI** | `openai_compatible` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| **OpenRouter** | `openai_compatible` | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| **opencode (local)** | `openai_compatible` | `http://localhost:4096/v1` | `gpt-4o-mini` (local server lazım) |
| **Google** | `google` | — | `gemini-2.0-flash` |
| **Custom** | `openai_compatible` | (istifadəçi) | (istifadəçi) |

**Custom ilə əlavə işləyən xidmətlər:**
- **Groq** (pulsuz tier): base URL `https://api.groq.com/openai/v1`, model `llama-3.3-70b-versatile` və ya `llama-3.1-8b-instant`.
- **Grok / xAI**: base URL `https://api.x.ai/v1`, model `grok-2-latest`.
- **Ollama / LM Studio** (local, pulsuz): base URL `http://localhost:11434/v1` və s.

İstək şəkli: `openai_compatible` → `POST {base_url}/chat/completions`, `Authorization: Bearer <açar>`, `{model, messages:[{role:system},{role:user}]}`. `google` → `generateContent`.

> **Sxem büdcəsi:** böyük bazalarda (məs. 113 cədvəl) tam sxem token limitini aşır. `ai_nl2sql` yalnız **relevant cədvəlləri** + büdcəyə sığan qədər sütun göndərir (`schema_tables`, `schema_tokens`, `schema_truncated`).

## 1. Açarın saxlanması (təhlükəsizlik)

- Açar **OS keychain-də** (`keyring` crate). Frontend heç vaxt açarı görmür.
- `ai_set_key` komandası açarı yazır; `client.rs` oxuyur.

```rust
// core/secrets.rs
use keyring::Entry;

const SERVICE: &str = "dataforge";
const AI_KEY_USER: &str = "anthropic_api_key";

pub fn set_api_key(key: &str) -> anyhow::Result<()> {
    Entry::new(SERVICE, AI_KEY_USER)?.set_password(key)?;
    Ok(())
}
pub fn get_api_key() -> anyhow::Result<String> {
    Ok(Entry::new(SERVICE, AI_KEY_USER)?.get_password()?)
}
pub fn has_api_key() -> bool {
    Entry::new(SERVICE, AI_KEY_USER).and_then(|e| e.get_password()).is_ok()
}
```

## 2. Claude klienti (`ai/client.rs`)

```rust
use serde::{Deserialize, Serialize};
use crate::error::AppError;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

#[derive(Serialize)]
struct MessagesRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: Vec<Msg<'a>>,
}
#[derive(Serialize)]
struct Msg<'a> { role: &'a str, content: &'a str }

#[derive(Deserialize)]
struct MessagesResponse {
    content: Vec<Block>,
    stop_reason: Option<String>,
    // stop_details: refusal olanda dolur (aşağı bax)
}
#[derive(Deserialize)]
struct Block { #[serde(rename = "type")] kind: String, #[serde(default)] text: String }

/// Claude-a bir sorğu göndərib yalnız mətn cavabını qaytarır.
pub async fn complete(model: &str, system: &str, user: &str, max_tokens: u32)
    -> Result<String, AppError>
{
    let api_key = crate::core::secrets::get_api_key()
        .map_err(|_| AppError::NoApiKey)?;

    let body = MessagesRequest {
        model,
        max_tokens,
        system,
        messages: vec![Msg { role: "user", content: user }],
    };

    let client = reqwest::Client::new();
    let resp = client.post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send().await
        .map_err(|e| AppError::Ai(format!("şəbəkə: {e}")))?;

    if !resp.status().is_success() {
        let code = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(AppError::Ai(format!("Claude API {code}: {txt}")));
    }

    let parsed: MessagesResponse = resp.json().await
        .map_err(|e| AppError::Ai(format!("parse: {e}")))?;

    // refusal yoxlaması (təhlükəsizlik klassifikatoru rədd edə bilər)
    if parsed.stop_reason.as_deref() == Some("refusal") {
        return Err(AppError::Ai("Model bu sorğunu rədd etdi.".into()));
    }

    // ilk mətn blokunu götür
    let text = parsed.content.iter()
        .find(|b| b.kind == "text")
        .map(|b| b.text.clone())
        .unwrap_or_default();
    Ok(text)
}
```

> **Qeyd (thinking):** `claude-opus-5-5`-də thinking həmişə açıqdır — `thinking` sahəsini göndərmirik. Dərinliyi lazım olsa `output_config: {"effort": "medium"}` əlavə et (default `medium`). `budget_tokens` göndərmə — 400 verir.

## 3. Prompt şablonları (`ai/prompts.rs`)

Model **təmiz JSON** qaytarsın deyə system promptunda tələb edirik, sonra parse edirik (raw HTTP üçün ən sadə və etibarlı yol).

```rust
pub fn nl2sql_system(dialect: &str, schema: &str) -> String {
    format!(r#"You are a SQL expert for {dialect}. Convert the user's natural-language
request into a single valid {dialect} query.

RULES:
- Output ONLY a JSON object, no markdown, no prose outside JSON.
- Shape: {{"sql": string, "explanation": string, "warnings": string[], "needs_confirmation": boolean}}
- "needs_confirmation" = true if the query is DDL/DML (INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE).
- "warnings": note full table scans, missing WHERE on UPDATE/DELETE, large result sets.
- Never invent tables/columns not in the schema. If impossible, set sql="" and explain why.
- Prefer explicit column lists over SELECT *.

DATABASE SCHEMA:
{schema}
"#)
}

pub fn explain_system() -> &'static str {
    "You explain SQL queries in plain language for a developer. \
     Output ONLY JSON: {\"summary\": string}. Be concise, 2-4 sentences."
}

pub fn optimize_system(dialect: &str) -> String {
    format!(r#"You optimize {dialect} queries. Given a query and optional EXPLAIN plan,
suggest concrete improvements (indexes, rewrites, avoiding scans).
Output ONLY JSON: {{"suggestions": string[], "rewritten_sql": string|null}}."#)
}

pub fn fix_error_system(dialect: &str) -> String {
    format!(r#"You fix broken {dialect} SQL. Given the SQL and the DB error message,
return a corrected query. Output ONLY JSON:
{{"sql": string, "explanation": string, "warnings": string[], "needs_confirmation": boolean}}."#)
}
```

## 4. Sxem çıxarışı + axın (`ai/nl2sql.rs`)

> **JSON rejimi + fallback:** OpenAI-compatible sorğular `response_format:
> {"type":"json_object"}`, Google isə `responseMimeType: application/json`
> göndərir. Model dəqiq JSON qaytarmasa, parser ```sql``` fenced blokunu, sonra
> ilk standalone SQL ifadəsini çıxarır. SQL hələ boşdursa `raw` model mətni
> UI-da açılan diaqnostika panelində göstərilir.
>
> **Token büdcəsi (vacib):** tam sxem göndərilmir. `build_schema_context` bütün
> cədvəl adlarını saxlayır, lakin sütunları yalnız sualla əlaqəli cədvəllər üçün
> verir. `schema_token_budget` (default **3000**, 500–8000) ilə kəsilir; artıq
> cədvəllər yalnız ad kimi qalır. UI `N of M tables with columns · ~tokens`
> göstərir. 113 cədvəlli baza üçün tipik sual ~3k sxem tokeni yaradır.

```rust
use crate::{error::AppError, ai::{client, prompts}};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Nl2SqlResult {
    pub sql: String,
    pub explanation: String,
    #[serde(default)] pub warnings: Vec<String>,
    #[serde(default)] pub needs_confirmation: bool,
    #[serde(default)] pub schema_tables: Vec<String>,
    #[serde(default)] pub schema_total_tables: usize,
    #[serde(default)] pub schema_tokens: usize,
    #[serde(default)] pub schema_truncated: bool,
    #[serde(default)] pub raw: String, // modelin xam cavabı (debug)
}

pub fn build_schema_context(
    snap: &SchemaSnapshot,
    question: &str,
    budget: u32,
) -> SchemaContext { /* all names; relevant columns only; budget cap */ }

pub async fn nl2sql(model: &str, dialect: &str, schema_text: &str, question: &str)
    -> Result<Nl2SqlResult, AppError>
{
    let system = prompts::nl2sql_system(dialect, schema_text);
    let raw = client::complete(model, &system, question, 2048).await?;
    // model bəzən ```json ... ``` ilə bükə bilər — təmizlə
    let json = strip_code_fence(&raw);
    serde_json::from_str::<Nl2SqlResult>(&json)
        .map_err(|e| AppError::Ai(format!("JSON parse: {e}\nxam: {raw}")))
}

fn strip_code_fence(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    t.strip_suffix("```").unwrap_or(t).trim().to_string()
}
```

Komanda (`commands/ai.rs`):

```rust
#[tauri::command]
pub async fn ai_nl2sql(
    state: tauri::State<'_, AppState>,
    conn_id: String,
    question: String,
    include_schema: Option<bool>,
) -> Result<Nl2SqlResult, AppError> {
    let driver = state.pool.get(&conn_id).await?;
    let dialect = driver.dialect_name();          // "mysql" və s.
    let schema_text = if include_schema.unwrap_or(true) {
        let snap = driver.get_schema().await?;
        crate::ai::nl2sql::schema_to_text(&snap)
    } else { String::new() };
    let model = state.config.ai_model();          // default "claude-opus-5-5"
    crate::ai::nl2sql::nl2sql(&model, dialect, &schema_text, &question).await
}
```

## 5. Privacy (vacib)

- **Sxem** (cədvəl/sütun adları) yalnız `include_schema=true` olanda Claude-a gedir. UI-də bunu açıq göstər: "Sxem AI-yə göndəriləcək".
- **Data (sətir dəyərləri) default GÖNDƏRİLMİR.** NL→SQL üçün data lazım deyil.
- İlk dəfə AI işlədəndə istifadəçidən birdəfəlik razılıq al.
- İstəyə görə "offline rejim" — AI tamamilə söndürülə bilər.

## 6. Prompt caching (xərci azaldır)

Eyni baza ilə çox sorğuda sxem dəyişmir — onu keşlə:

```jsonc
"system": [
  { "type": "text", "text": "<NL2SQL qaydaları + SXEM>", "cache_control": { "type": "ephemeral" } }
]
```
`system` sahəsini sətir əvəzinə blok massivinə çevir və `cache_control` qoy. Təkrar sorğularda `usage.cache_read_input_tokens > 0` olmalıdır → sxem token xərci düşür.

## 7. Axın (streaming) — uzun cavablar

NL→SQL qısa olduğu üçün MVP-də streaming lazım deyil. Amma AI izah/optimallaşdırma uzun ola bilər — onda `"stream": true` + SSE oxu (`reqwest` `stream` feature). SSE event formatı: `content_block_delta` → `delta.text`.

## 8. Xəta idarəetmə (`error.rs`)

```rust
#[derive(Debug, thiserror::Error, serde::Serialize)]
pub enum AppError {
    #[error("API açarı təyin edilməyib")] NoApiKey,
    #[error("AI xətası: {0}")] Ai(String),
    #[error("DB xətası: {0}")] Db(String),
    #[error("bağlantı tapılmadı")] NoConnection,
}
```

Frontend `ai_fix_error`-u DB xətası baş verəndə təklif edir: istifadəçi "AI ilə düzəlt" basır → düzəldilmiş SQL gəlir (avtomatik icra YOX).
