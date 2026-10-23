use keyring::{Entry, Error as KeyringError};

use crate::error::{AppError, AppResult};

const SERVICE: &str = "dataforge";
const AI_KEY_USER: &str = "ai_api_key";

fn entry(conn_id: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, &format!("connection:{conn_id}"))
        .map_err(|error| AppError::Config(format!("keyring: {error}")))
}

fn ssh_entry(conn_id: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, &format!("connection:{conn_id}:ssh"))
        .map_err(|error| AppError::Config(format!("keyring: {error}")))
}

fn ai_entry() -> AppResult<Entry> {
    Entry::new(SERVICE, AI_KEY_USER).map_err(|error| AppError::Config(format!("keyring: {error}")))
}

pub fn set_connection_password(conn_id: &str, password: &str) -> AppResult<()> {
    entry(conn_id)?
        .set_password(password)
        .map_err(|error| AppError::Config(format!("keyring: {error}")))
}

pub fn get_connection_password(conn_id: &str) -> AppResult<Option<String>> {
    match entry(conn_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(AppError::Config(format!("keyring: {error}"))),
    }
}

pub fn delete_connection_password(conn_id: &str) -> AppResult<()> {
    match entry(conn_id)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(AppError::Config(format!("keyring: {error}"))),
    }
}

pub fn set_connection_ssh_secret(conn_id: &str, secret: &str) -> AppResult<()> {
    ssh_entry(conn_id)?
        .set_password(secret)
        .map_err(|error| AppError::Config(format!("keyring: {error}")))
}

pub fn get_connection_ssh_secret(conn_id: &str) -> AppResult<Option<String>> {
    match ssh_entry(conn_id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(AppError::Config(format!("keyring: {error}"))),
    }
}

pub fn delete_connection_ssh_secret(conn_id: &str) -> AppResult<()> {
    match ssh_entry(conn_id)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(AppError::Config(format!("keyring: {error}"))),
    }
}

pub fn set_api_key(api_key: &str) -> AppResult<()> {
    ai_entry()?
        .set_password(api_key)
        .map_err(|error| AppError::Config(format!("keyring: {error}")))
}

pub fn get_api_key() -> AppResult<String> {
    match ai_entry()?.get_password() {
        Ok(api_key) => Ok(api_key),
        Err(KeyringError::NoEntry) => Err(AppError::NoApiKey),
        Err(error) => Err(AppError::Config(format!("keyring: {error}"))),
    }
}

pub fn has_api_key() -> bool {
    ai_entry()
        .and_then(|entry| {
            entry
                .get_password()
                .map_err(|error| AppError::Config(format!("keyring: {error}")))
        })
        .is_ok()
}
