use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum AppError {
    #[error("API açarı təyin edilməyib")]
    NoApiKey,
    #[error("AI xətası: {0}")]
    Ai(String),
    #[error("DB xətası: {0}")]
    Db(String),
    #[error("bağlantı tapılmadı")]
    NoConnection,
    #[error("konfiqurasiya xətası: {0}")]
    Config(String),
    #[error("ixrac xətası: {0}")]
    Export(String),
    #[error("daxili xəta: {0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;
