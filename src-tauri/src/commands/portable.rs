use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::commands::saved::{
    read_document, saved_queries_path, validate_document, write_document, SavedQueriesFile,
    SavedQuery, SavedQueryFolder,
};
use crate::core::drivers::{
    ConnectionEnvironment, ConnectionMeta, Dialect, SslMode,
};
use crate::core::secrets;
use crate::core::ssh::{SshAuth, SshConfig};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const EXPORT_FORMAT: &str = "dataforge-connections";
const EXPORT_VERSION: u32 = 1;
const EXPORT_HEADER: &str = "DataForge connection export. Passwords, SSH secrets and AI keys are NOT included. Imported connections ask for the password on first connect.";
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 1_000;
const MAX_NAME_CHARS: usize = 120;
const MAX_HOST_CHARS: usize = 255;
const MAX_USER_CHARS: usize = 255;
const MAX_DATABASE_CHARS: usize = 4_096;
const MAX_FLAVOR_CHARS: usize = 64;
const MAX_PATH_CHARS: usize = 4_096;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableSshConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableConnection {
    pub name: String,
    pub dialect: Dialect,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<ConnectionEnvironment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flavor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_mode: Option<SslMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_ca_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<PortableSshConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
}

impl PortableConnection {
    fn from_meta(meta: &ConnectionMeta) -> Self {
        Self {
            name: meta.name.clone(),
            dialect: meta.dialect,
            host: meta.host.clone(),
            port: meta.port,
            username: meta.username.clone(),
            database: meta.database.clone(),
            environment: meta.environment,
            flavor: meta.flavor.clone(),
            ssl_mode: meta.ssl_mode,
            ssl_ca_path: meta.ssl_ca_path.clone(),
            ssh: meta.ssh.as_ref().map(|ssh| PortableSshConfig {
                host: ssh.host.clone(),
                port: ssh.port,
                username: ssh.username.clone(),
                auth: ssh.auth,
                key_path: ssh.key_path.clone(),
            }),
            read_only: meta.read_only,
        }
    }

    fn to_meta(&self, id: String) -> ConnectionMeta {
        ConnectionMeta {
            id,
            name: self.name.trim().to_string(),
            dialect: self.dialect,
            host: self.host.trim().to_string(),
            port: self.port,
            username: self.username.trim().to_string(),
            database: self.database.clone(),
            read_only: self.read_only,
            environment: self.environment,
            flavor: self.flavor.clone(),
            trust_cert: None,
            ssl_mode: self.ssl_mode,
            ssl_ca_path: self.ssl_ca_path.clone(),
            ssh: self.ssh.as_ref().map(|ssh| SshConfig {
                host: ssh.host.trim().to_string(),
                port: ssh.port,
                username: ssh.username.trim().to_string(),
                auth: ssh.auth,
                key_path: ssh.key_path.clone(),
                host_key: None,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableFile {
    pub format: String,
    pub version: u32,
    pub header: String,
    pub exported_at: i64,
    pub connections: Vec<PortableConnection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_queries: Option<SavedQueriesFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportPreviewItem {
    pub index: usize,
    pub connection: PortableConnection,
    pub conflict: Option<String>,
    pub conflict_with: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportPreview {
    pub path: String,
    pub header: String,
    pub connections: Vec<ImportPreviewItem>,
    pub saved_query_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportDecision {
    pub index: usize,
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub replaced: usize,
    pub skipped: usize,
    pub saved_queries: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConflictKind {
    Name,
    Endpoint,
    Both,
}

impl ConflictKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Name => "name",
            Self::Endpoint => "endpoint",
            Self::Both => "both",
        }
    }
}

fn check_length(label: &str, value: &str, max: usize) -> AppResult<()> {
    if value.chars().count() > max {
        return Err(AppError::Config(format!(
            "Invalid connections file: {label} is too long (maximum {max} characters)."
        )));
    }
    Ok(())
}

fn check_required_length(label: &str, value: &str, max: usize) -> AppResult<()> {
    if value.trim().is_empty() {
        return Err(AppError::Config(format!(
            "Invalid connections file: {label} cannot be empty."
        )));
    }
    check_length(label, value, max)
}

fn normalize_database(database: &Option<String>) -> Option<String> {
    database
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn validate_connection(connection: &PortableConnection) -> AppResult<()> {
    check_required_length("connection name", &connection.name, MAX_NAME_CHARS)?;
    check_length("host", &connection.host, MAX_HOST_CHARS)?;
    check_length("username", &connection.username, MAX_USER_CHARS)?;
    if let Some(database) = &connection.database {
        check_length("database", database, MAX_DATABASE_CHARS)?;
    }
    if let Some(flavor) = &connection.flavor {
        check_length("flavor", flavor, MAX_FLAVOR_CHARS)?;
    }
    if let Some(path) = &connection.ssl_ca_path {
        check_length("SSL CA path", path, MAX_PATH_CHARS)?;
    }

    if connection.dialect != Dialect::Sqlite {
        if connection.port == 0 {
            return Err(AppError::Config(
                "Invalid connections file: port must be between 1 and 65535.".to_string(),
            ));
        }
        check_required_length("host", &connection.host, MAX_HOST_CHARS)?;
    }

    if let Some(ssh) = &connection.ssh {
        check_required_length("SSH host", &ssh.host, MAX_HOST_CHARS)?;
        check_required_length("SSH username", &ssh.username, MAX_USER_CHARS)?;
        if ssh.port == 0 {
            return Err(AppError::Config(
                "Invalid connections file: SSH port must be between 1 and 65535.".to_string(),
            ));
        }
        if let Some(path) = &ssh.key_path {
            check_length("SSH key path", path, MAX_PATH_CHARS)?;
        }
    }

    Ok(())
}

fn validate_file(file: &PortableFile) -> AppResult<()> {
    if file.format != EXPORT_FORMAT {
        return Err(AppError::Config(format!(
            "Invalid connections file: unexpected format \"{}\".",
            file.format
        )));
    }
    if file.version != EXPORT_VERSION {
        return Err(AppError::Config(format!(
            "Unsupported connections file version {} (expected {}).",
            file.version, EXPORT_VERSION
        )));
    }
    check_length("header", &file.header, 2_000)?;
    if file.connections.is_empty() {
        return Err(AppError::Config(
            "Invalid connections file: it does not contain any connections.".to_string(),
        ));
    }
    if file.connections.len() > MAX_CONNECTIONS {
        return Err(AppError::Config(
            "Invalid connections file: too many connections.".to_string(),
        ));
    }

    for connection in &file.connections {
        validate_connection(connection)?;
    }

    if let Some(saved) = &file.saved_queries {
        validate_document(saved)?;
    }

    Ok(())
}

pub(crate) fn parse_import(text: &str) -> AppResult<PortableFile> {
    if text.len() > MAX_FILE_BYTES {
        return Err(AppError::Config(
            "Invalid connections file: the file is too large.".to_string(),
        ));
    }
    let file: PortableFile = serde_json::from_str(text)
        .map_err(|error| AppError::Config(format!("Invalid connections file: {error}")))?;
    validate_file(&file)?;
    Ok(file)
}

fn read_import(path: &Path) -> AppResult<PortableFile> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| AppError::Config(format!("Could not read connections file: {error}")))?;
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(AppError::Config(
            "Invalid connections file: the file is too large.".to_string(),
        ));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|error| AppError::Config(format!("Could not read connections file: {error}")))?;
    parse_import(&text)
}

fn same_name(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

fn same_endpoint(connection: &PortableConnection, meta: &ConnectionMeta) -> bool {
    if connection.dialect != meta.dialect {
        return false;
    }

    if connection.dialect == Dialect::Sqlite {
        return normalize_database(&connection.database) == normalize_database(&meta.database);
    }

    connection.host.trim().eq_ignore_ascii_case(meta.host.trim())
        && connection.port == meta.port
        && connection.username.trim() == meta.username.trim()
        && normalize_database(&connection.database) == normalize_database(&meta.database)
}

pub(crate) fn detect_conflict(
    connection: &PortableConnection,
    existing: &[ConnectionMeta],
) -> Option<(ConflictKind, ConnectionMeta)> {
    let by_name = existing
        .iter()
        .find(|meta| same_name(&connection.name, &meta.name));
    let by_endpoint = existing
        .iter()
        .find(|meta| same_endpoint(connection, meta));

    match (by_name, by_endpoint) {
        (Some(name), Some(endpoint)) if name.id == endpoint.id => {
            Some((ConflictKind::Both, name.clone()))
        }
        (Some(name), _) => Some((ConflictKind::Name, name.clone())),
        (_, Some(endpoint)) => Some((ConflictKind::Endpoint, endpoint.clone())),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportAction {
    New,
    Skip,
    Replace,
}

fn parse_action(value: &str) -> AppResult<ImportAction> {
    match value {
        "new" => Ok(ImportAction::New),
        "skip" => Ok(ImportAction::Skip),
        "replace" => Ok(ImportAction::Replace),
        other => Err(AppError::Config(format!(
            "Invalid import action \"{other}\" (expected new, skip or replace)."
        ))),
    }
}

pub(crate) fn merge_saved_queries(
    existing: &SavedQueriesFile,
    incoming: &SavedQueriesFile,
) -> SavedQueriesFile {
    let now = now_secs();
    let mut folder_ids = HashMap::new();
    let mut folders = existing.folders.clone();

    for folder in &incoming.folders {
        let id = uuid::Uuid::new_v4().to_string();
        folder_ids.insert(folder.id.clone(), id.clone());
        folders.push(SavedQueryFolder {
            id,
            name: folder.name.clone(),
            created_at: now,
        });
    }

    let mut queries = existing.queries.clone();
    for query in &incoming.queries {
        queries.push(SavedQuery {
            id: uuid::Uuid::new_v4().to_string(),
            name: query.name.clone(),
            description: query.description.clone(),
            folder_id: query
                .folder_id
                .as_ref()
                .and_then(|folder_id| folder_ids.get(folder_id).cloned()),
            sql: query.sql.clone(),
            conn_id: query.conn_id.clone(),
            database: query.database.clone(),
            created_at: now,
            updated_at: now,
        });
    }

    SavedQueriesFile {
        version: 1,
        folders,
        queries,
    }
}

fn ensure_export_extension(path: String) -> String {
    if path.to_ascii_lowercase().ends_with(".dataforge.json") {
        path
    } else {
        format!("{path}.dataforge.json")
    }
}

async fn save_export_dialog(app: &tauri::AppHandle) -> AppResult<Option<String>> {
    let dialog_app = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("DataForge connections", &["json"])
            .set_file_name("dataforge-connections.dataforge.json")
            .blocking_save_file()
    })
    .await
    .map_err(|error| AppError::Config(format!("save dialog: {error}")))?;

    match path {
        Some(path) => Ok(Some(
            path.into_path()
                .map_err(|error| AppError::Config(format!("save dialog: {error}")))?
                .to_string_lossy()
                .into_owned(),
        )),
        None => Ok(None),
    }
}

async fn pick_import_dialog(app: &tauri::AppHandle) -> AppResult<Option<String>> {
    let dialog_app = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("DataForge connections", &["json"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| AppError::Config(format!("file picker: {error}")))?;

    match path {
        Some(path) => Ok(Some(
            path.into_path()
                .map_err(|error| AppError::Config(format!("file picker: {error}")))?
                .to_string_lossy()
                .into_owned(),
        )),
        None => Ok(None),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn export_connections(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    include_saved_queries: bool,
) -> AppResult<Option<String>> {
    let connections = {
        let store = state.connections.read().await;
        let source = store.list();
        let requested: HashSet<&str> = ids.iter().map(String::as_str).collect();
        source
            .iter()
            .filter(|meta| requested.is_empty() || requested.contains(meta.id.as_str()))
            .map(PortableConnection::from_meta)
            .collect::<Vec<_>>()
    };

    if connections.is_empty() {
        return Err(AppError::Config(
            "Select at least one connection to export.".to_string(),
        ));
    }

    let saved_queries = if include_saved_queries {
        Some(read_document(&saved_queries_path(&state))?)
    } else {
        None
    };

    let file = PortableFile {
        format: EXPORT_FORMAT.to_string(),
        version: EXPORT_VERSION,
        header: EXPORT_HEADER.to_string(),
        exported_at: now_secs(),
        connections,
        saved_queries,
    };
    let data = serde_json::to_string_pretty(&file)
        .map_err(|error| AppError::Config(format!("connections export: {error}")))?;

    let Some(path) = save_export_dialog(&app).await? else {
        return Ok(None);
    };
    let path = ensure_export_extension(path);

    tokio::task::spawn_blocking(move || std::fs::write(&path, data).map(|_| path))
        .await
        .map_err(|error| AppError::Config(format!("connections export: {error}")))?
        .map_err(|error| AppError::Export(error.to_string()))
        .map(Some)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn preview_connections_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<ImportPreview>> {
    let Some(path) = pick_import_dialog(&app).await? else {
        return Ok(None);
    };
    let file = read_import(Path::new(&path))?;
    let existing = state.connections.read().await.list();

    let connections = file
        .connections
        .iter()
        .enumerate()
        .map(|(index, connection)| {
            let conflict = detect_conflict(connection, &existing);
            ImportPreviewItem {
                index,
                connection: connection.clone(),
                conflict: conflict
                    .as_ref()
                    .map(|(kind, _)| kind.as_str().to_string()),
                conflict_with: conflict.map(|(_, meta)| meta.name),
            }
        })
        .collect();
    let saved_query_count = file
        .saved_queries
        .as_ref()
        .map(|saved| saved.queries.len())
        .unwrap_or(0);

    Ok(Some(ImportPreview {
        path,
        header: file.header,
        connections,
        saved_query_count,
    }))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn apply_connections_import(
    state: State<'_, AppState>,
    path: String,
    decisions: Vec<ImportDecision>,
    import_saved_queries: bool,
) -> AppResult<ImportResult> {
    let file = read_import(Path::new(&path))?;

    let mut actions = HashMap::new();
    for decision in decisions {
        if decision.index >= file.connections.len() {
            return Err(AppError::Config(format!(
                "Invalid import decision: connection #{} does not exist.",
                decision.index
            )));
        }
        let action = parse_action(&decision.action)?;
        actions.insert(decision.index, action);
    }

    let existing = state.connections.read().await.list();
    let mut working = existing.clone();
    let mut plan: Vec<(usize, ImportAction, Option<String>)> = Vec::new();

    for (index, connection) in file.connections.iter().enumerate() {
        let action = actions.get(&index).copied().unwrap_or(ImportAction::Skip);
        if action == ImportAction::Skip {
            plan.push((index, action, None));
            continue;
        }

        let conflict = detect_conflict(connection, &working);
        let id = match action {
            ImportAction::New => uuid::Uuid::new_v4().to_string(),
            ImportAction::Replace => match conflict {
                Some((_, meta)) => meta.id,
                None => {
                    return Err(AppError::Config(format!(
                        "Connection \"{}\" cannot be replaced because no existing connection conflicts with it.",
                        connection.name
                    )))
                }
            },
            ImportAction::Skip => unreachable!(),
        };

        let meta = connection.to_meta(id.clone());
        if let Some(index) = working.iter().position(|item| item.id == id) {
            working[index] = meta;
        } else {
            working.push(meta);
        }
        plan.push((index, action, Some(id)));
    }

    let mut result = ImportResult {
        imported: 0,
        replaced: 0,
        skipped: 0,
        saved_queries: 0,
    };

    for (index, action, id) in plan {
        match action {
            ImportAction::Skip => {
                result.skipped += 1;
            }
            ImportAction::New | ImportAction::Replace => {
                let Some(id) = id else { continue };
                if action == ImportAction::Replace {
                    // The endpoint may have changed, and the old keychain
                    // entries must never be reused by an imported connection.
                    state.pool.remove(&id).await;
                    secrets::delete_connection_password(&id)?;
                    secrets::delete_connection_ssh_secret(&id)?;
                    result.replaced += 1;
                } else {
                    result.imported += 1;
                }

                let meta = file.connections[index].to_meta(id);
                state.connections.write().await.upsert(meta)?;
            }
        }
    }

    if import_saved_queries {
        if let Some(incoming) = &file.saved_queries {
            let path = saved_queries_path(&state);
            let existing = read_document(&path)?;
            let merged = merge_saved_queries(&existing, incoming);
            write_document(&path, &merged)?;
            result.saved_queries = incoming.queries.len();
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        detect_conflict, merge_saved_queries, parse_import, validate_file, ConflictKind,
        PortableConnection, PortableFile, EXPORT_FORMAT, EXPORT_HEADER, EXPORT_VERSION,
    };
    use crate::commands::saved::{SavedQueriesFile, SavedQuery, SavedQueryFolder};
    use crate::core::drivers::{ConnectionEnvironment, ConnectionMeta, Dialect, SslMode};
    use crate::core::ssh::SshAuth;
    use serde_json::json;

    fn exported(meta: &ConnectionMeta) -> PortableConnection {
        PortableConnection::from_meta(meta)
    }

    #[test]
    fn export_never_contains_secret_fields() {
        let meta = ConnectionMeta {
            id: "id".to_string(),
            name: "production".to_string(),
            dialect: Dialect::Postgres,
            host: "db.example".to_string(),
            port: 5432,
            username: "app".to_string(),
            database: Some("shop".to_string()),
            read_only: Some(true),
            environment: Some(ConnectionEnvironment::Prod),
            flavor: Some("rds".to_string()),
            trust_cert: Some(true),
            ssl_mode: Some(SslMode::VerifyFull),
            ssl_ca_path: Some("/certs/ca.pem".to_string()),
            ssh: Some(crate::core::ssh::SshConfig {
                host: "bastion.example".to_string(),
                port: 22,
                username: "deploy".to_string(),
                auth: SshAuth::Password,
                key_path: Some("/home/deploy/.ssh/id_ed25519".to_string()),
                host_key: Some("SHA256:secret-host-key".to_string()),
            }),
        };

        let file = PortableFile {
            format: EXPORT_FORMAT.to_string(),
            version: EXPORT_VERSION,
            header: EXPORT_HEADER.to_string(),
            exported_at: 1,
            connections: vec![exported(&meta)],
            saved_queries: None,
        };
        let text = serde_json::to_string(&file.connections).expect("serialize");

        for forbidden in [
            "\"password\":",
            "\"ssh_secret\":",
            "\"host_key\":",
            "\"api_key\":",
            "\"trust_cert\":",
            "secret-host-key",
        ] {
            assert!(
                !text.to_lowercase().contains(forbidden),
                "export must not contain {forbidden}: {text}"
            );
        }
        assert!(text.contains("bastion.example"));
        assert!(text.contains("\"auth\":\"password\""));
    }

    fn connection_json(name: &str, dialect: &str, port: u16) -> serde_json::Value {
        json!({
            "name": name,
            "dialect": dialect,
            "host": "db.example",
            "port": port,
            "username": "app",
            "database": "shop"
        })
    }

    fn file_json(version: u32, connection: serde_json::Value) -> String {
        json!({
            "format": EXPORT_FORMAT,
            "version": version,
            "header": EXPORT_HEADER,
            "exported_at": 1,
            "connections": [connection]
        })
        .to_string()
    }

    #[test]
    fn rejects_bad_version_unknown_dialect_and_huge_strings() {
        let bad_version = file_json(2, connection_json("db", "postgres", 5432));
        let error = parse_import(&bad_version).unwrap_err().to_string();
        assert!(error.contains("version"), "{error}");

        let unknown = file_json(1, connection_json("db", "oracle", 1521));
        let error = parse_import(&unknown).unwrap_err().to_string();
        assert!(error.contains("unknown variant") || error.contains("oracle"), "{error}");

        let mut huge = connection_json("db", "postgres", 5432);
        huge["name"] = json!("x".repeat(10_000));
        let error = parse_import(&file_json(1, huge)).unwrap_err().to_string();
        assert!(error.contains("too long"), "{error}");

        let bad_port = connection_json("db", "postgres", 0);
        let error = parse_import(&file_json(1, bad_port)).unwrap_err().to_string();
        assert!(error.contains("port"), "{error}");
    }

    #[test]
    fn rejects_unexpected_fields() {
        let mut connection = connection_json("db", "postgres", 5432);
        connection["password"] = json!("hunter2");
        let error = parse_import(&file_json(1, connection))
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown field") || error.contains("invalid"), "{error}");
    }

    fn meta(id: &str, name: &str, host: &str, port: u16, username: &str, database: &str) -> ConnectionMeta {
        ConnectionMeta {
            id: id.to_string(),
            name: name.to_string(),
            dialect: Dialect::Postgres,
            host: host.to_string(),
            port,
            username: username.to_string(),
            database: Some(database.to_string()),
            read_only: None,
            environment: None,
            flavor: None,
            trust_cert: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssh: None,
        }
    }

    #[test]
    fn detects_name_and_endpoint_conflicts() {
        let existing = vec![meta("a", "Shop", "db.example", 5432, "app", "shop")];

        let same_name = PortableConnection {
            name: " shop ".to_string(),
            dialect: Dialect::Postgres,
            host: "other.example".to_string(),
            port: 5432,
            username: "app".to_string(),
            database: Some("other".to_string()),
            environment: None,
            flavor: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssh: None,
            read_only: None,
        };
        assert_eq!(
            detect_conflict(&same_name, &existing).map(|(kind, _)| kind),
            Some(ConflictKind::Name)
        );

        let same_endpoint = PortableConnection {
            name: "Other".to_string(),
            host: "db.example".to_string(),
            database: Some("shop".to_string()),
            ..same_name.clone()
        };
        assert_eq!(
            detect_conflict(&same_endpoint, &existing).map(|(kind, _)| kind),
            Some(ConflictKind::Endpoint)
        );

        let both = PortableConnection {
            host: "DB.EXAMPLE".to_string(),
            database: Some("shop".to_string()),
            ..same_name
        };
        assert_eq!(
            detect_conflict(&both, &existing).map(|(kind, _)| kind),
            Some(ConflictKind::Both)
        );
    }

    #[test]
    fn merges_saved_queries_with_fresh_ids() {
        let existing = SavedQueriesFile {
            version: 1,
            folders: vec![SavedQueryFolder {
                id: "f-old".to_string(),
                name: "Old".to_string(),
                created_at: 1,
            }],
            queries: Vec::new(),
        };
        let incoming = SavedQueriesFile {
            version: 1,
            folders: vec![SavedQueryFolder {
                id: "f-new".to_string(),
                name: "New".to_string(),
                created_at: 2,
            }],
            queries: vec![SavedQuery {
                id: "q-new".to_string(),
                name: "Count".to_string(),
                description: None,
                folder_id: Some("f-new".to_string()),
                sql: "SELECT 1;".to_string(),
                conn_id: None,
                database: None,
                created_at: 2,
                updated_at: 2,
            }],
        };

        let merged = merge_saved_queries(&existing, &incoming);
        assert_eq!(merged.folders.len(), 2);
        assert_eq!(merged.queries.len(), 1);
        assert_ne!(merged.folders[1].id, "f-new");
        assert_ne!(merged.queries[0].id, "q-new");
        assert_eq!(
            merged.queries[0].folder_id.as_deref(),
            Some(merged.folders[1].id.as_str())
        );
    }

    #[test]
    fn all_exported_fields_round_trip_without_secrets() {
        let meta = meta("id", "db", "db.example", 5432, "app", "shop");
        let connection = exported(&meta);
        let file = PortableFile {
            format: EXPORT_FORMAT.to_string(),
            version: EXPORT_VERSION,
            header: EXPORT_HEADER.to_string(),
            exported_at: 1,
            connections: vec![connection.clone()],
            saved_queries: None,
        };
        assert!(validate_file(&file).is_ok());

        let restored = connection.to_meta("new-id".to_string());
        assert_eq!(restored.name, "db");
        assert_eq!(restored.dialect, Dialect::Postgres);
        assert_eq!(restored.host, "db.example");
        assert_eq!(restored.port, 5432);
        assert_eq!(restored.username, "app");
        assert_eq!(restored.database.as_deref(), Some("shop"));
        assert!(restored.ssh.is_none());
    }
}
