use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const SAVED_VERSION: u32 = 1;
const MAX_FOLDERS: usize = 1_000;
const MAX_QUERIES: usize = 10_000;
const MAX_ID_CHARS: usize = 128;
const MAX_NAME_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_SQL_CHARS: usize = 1_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedQueryFolder {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    pub sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedQueriesFile {
    pub version: u32,
    pub folders: Vec<SavedQueryFolder>,
    pub queries: Vec<SavedQuery>,
}

impl Default for SavedQueriesFile {
    fn default() -> Self {
        Self {
            version: SAVED_VERSION,
            folders: Vec::new(),
            queries: Vec::new(),
        }
    }
}

pub(crate) fn saved_queries_path(state: &AppState) -> PathBuf {
    state.config_dir.join("saved-queries.json")
}

fn check_length(label: &str, value: &str, max: usize) -> AppResult<()> {
    if value.chars().count() > max {
        return Err(AppError::Config(format!(
            "Saved queries file: {label} is too long (maximum {max} characters)."
        )));
    }
    Ok(())
}

fn check_required_length(label: &str, value: &str, max: usize) -> AppResult<()> {
    if value.trim().is_empty() {
        return Err(AppError::Config(format!(
            "Saved queries file: {label} cannot be empty."
        )));
    }
    check_length(label, value, max)
}

pub(crate) fn validate_document(document: &SavedQueriesFile) -> AppResult<()> {
    if document.version != SAVED_VERSION {
        return Err(AppError::Config(format!(
            "Unsupported saved queries version {} (expected {}).",
            document.version, SAVED_VERSION
        )));
    }
    if document.folders.len() > MAX_FOLDERS {
        return Err(AppError::Config(
            "Saved queries file contains too many folders.".to_string(),
        ));
    }
    if document.queries.len() > MAX_QUERIES {
        return Err(AppError::Config(
            "Saved queries file contains too many queries.".to_string(),
        ));
    }

    let mut folder_ids = std::collections::HashSet::new();
    for folder in &document.folders {
        check_required_length("folder id", &folder.id, MAX_ID_CHARS)?;
        check_required_length("folder name", &folder.name, MAX_NAME_CHARS)?;
        if !folder_ids.insert(folder.id.as_str()) {
            return Err(AppError::Config(format!(
                "Saved queries file contains a duplicate folder id: {}",
                folder.id
            )));
        }
    }

    let mut query_ids = std::collections::HashSet::new();
    for query in &document.queries {
        check_required_length("query id", &query.id, MAX_ID_CHARS)?;
        check_required_length("query name", &query.name, MAX_NAME_CHARS)?;
        check_length("query SQL", &query.sql, MAX_SQL_CHARS)?;
        if let Some(description) = &query.description {
            check_length("query description", description, MAX_DESCRIPTION_CHARS)?;
        }
        if let Some(folder_id) = &query.folder_id {
            check_required_length("query folder id", folder_id, MAX_ID_CHARS)?;
        }
        if !query_ids.insert(query.id.as_str()) {
            return Err(AppError::Config(format!(
                "Saved queries file contains a duplicate query id: {}",
                query.id
            )));
        }
    }

    Ok(())
}

pub(crate) fn read_document(path: &Path) -> AppResult<SavedQueriesFile> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(SavedQueriesFile::default()),
        Err(error) => {
            return Err(AppError::Config(format!(
                "Could not read saved queries: {error}"
            )))
        }
    };

    match serde_json::from_str::<SavedQueriesFile>(&text) {
        Ok(document) => {
            validate_document(&document)?;
            Ok(document)
        }
        Err(error) => {
            // Keep the unreadable file around instead of silently replacing it
            // with an empty list on the next save.
            eprintln!("saved-queries.json parse error ({error}); backing up");
            let backup = path.with_extension("corrupt.json");
            let _ = std::fs::rename(path, &backup);
            Ok(SavedQueriesFile::default())
        }
    }
}

pub(crate) fn write_document(path: &Path, document: &SavedQueriesFile) -> AppResult<()> {
    validate_document(document)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::Config(format!("config directory: {error}")))?;
    }

    let data = serde_json::to_string_pretty(document)
        .map_err(|error| AppError::Config(format!("saved queries: {error}")))?;

    // Atomic write: temp file + rename, so a crash mid-write cannot leave a
    // truncated saved-queries.json behind.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data)
        .map_err(|error| AppError::Config(format!("saved queries file: {error}")))?;
    std::fs::rename(&tmp, path)
        .map_err(|error| AppError::Config(format!("saved queries file: {error}")))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn load_saved_queries(state: State<'_, AppState>) -> AppResult<SavedQueriesFile> {
    let path = saved_queries_path(&state);
    tokio::task::spawn_blocking(move || read_document(&path))
        .await
        .map_err(|error| AppError::Config(format!("saved queries: {error}")))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_saved_queries(
    state: State<'_, AppState>,
    data: SavedQueriesFile,
) -> AppResult<SavedQueriesFile> {
    validate_document(&data)?;
    let path = saved_queries_path(&state);
    let document = data.clone();
    tokio::task::spawn_blocking(move || write_document(&path, &document))
        .await
        .map_err(|error| AppError::Config(format!("saved queries: {error}")))??;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::{read_document, validate_document, write_document, SavedQueriesFile, SavedQuery};
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dataforge-saved-test-{}-{}",
            name,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn document() -> SavedQueriesFile {
        SavedQueriesFile {
            version: 1,
            folders: Vec::new(),
            queries: vec![SavedQuery {
                id: "q1".to_string(),
                name: "Orders".to_string(),
                description: Some("Recent orders".to_string()),
                folder_id: None,
                sql: "SELECT * FROM orders;".to_string(),
                conn_id: None,
                database: None,
                created_at: 1,
                updated_at: 1,
            }],
        }
    }

    #[test]
    fn saves_atomically_and_reads_back() {
        let dir = temp_dir("atomic");
        let path = dir.join("saved-queries.json");

        write_document(&path, &document()).expect("write should succeed");
        let loaded = read_document(&path).expect("read should succeed");
        assert_eq!(loaded.queries.len(), 1);
        assert_eq!(loaded.queries[0].name, "Orders");
        assert!(!dir.join("saved-queries.json.tmp").exists());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_bad_saved_query_versions_and_duplicate_ids() {
        let mut bad_version = document();
        bad_version.version = 2;
        assert!(validate_document(&bad_version).is_err());

        let mut duplicate = document();
        duplicate.queries.push(duplicate.queries[0].clone());
        assert!(validate_document(&duplicate).is_err());
    }
}
