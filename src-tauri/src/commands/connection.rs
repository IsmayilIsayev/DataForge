use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::core::drivers::{self, ConnectionInput, ConnectionMeta, Dialect};
use crate::core::secrets;
use crate::core::ssh::SshAuth;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The keychain password belongs to one concrete endpoint. Reuse it only when
/// every connection-relevant field still points at that same endpoint.
fn stored_password_reusable(input: &ConnectionInput, meta: &ConnectionMeta) -> bool {
    if input.dialect != meta.dialect {
        return false;
    }

    if input.dialect == Dialect::Sqlite {
        return input.database == meta.database;
    }

    input.host == meta.host && input.port == meta.port && input.username == meta.username
}

/// A host key belongs to an SSH host:port pair. When the endpoint is unchanged
/// the stored fingerprint is authoritative; a new endpoint starts over with
/// trust on first use.
fn stored_ssh_host_key(input: &ConnectionInput, meta: &ConnectionMeta) -> Option<String> {
    match (&input.ssh, &meta.ssh) {
        (Some(input_ssh), Some(meta_ssh))
            if input_ssh.host == meta_ssh.host && input_ssh.port == meta_ssh.port =>
        {
            meta_ssh.host_key.clone()
        }
        _ => None,
    }
}

fn apply_stored_ssh_host_key(input: &mut ConnectionInput, meta: Option<&ConnectionMeta>) {
    let Some(meta) = meta else {
        return;
    };
    let stored = stored_ssh_host_key(input, meta);
    if let Some(ssh) = input.ssh.as_mut() {
        ssh.host_key = stored;
    }
}

/// The SSH password/passphrase can be reused only when every field that
/// determines which credential is valid still points at the same SSH login.
fn ssh_secret_reusable(input: &ConnectionInput, meta: &ConnectionMeta) -> bool {
    match (&input.ssh, &meta.ssh) {
        (Some(input_ssh), Some(meta_ssh)) => {
            input_ssh.host == meta_ssh.host
                && input_ssh.port == meta_ssh.port
                && input_ssh.username == meta_ssh.username
                && input_ssh.auth == meta_ssh.auth
                && input_ssh.key_path == meta_ssh.key_path
        }
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_host_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionState {
    pub id: String,
    pub connected: bool,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_connection(
    state: State<'_, AppState>,
    input: ConnectionInput,
) -> AppResult<ConnectionMeta> {
    let id = uuid::Uuid::new_v4().to_string();
    let password = input.password.clone().unwrap_or_default();
    let ssh_secret = input.ssh_secret.clone().unwrap_or_default();
    let connected = drivers::connect(&input, Some(&password)).await?;

    if input.save_password && !password.is_empty() {
        secrets::set_connection_password(&id, &password)?;
    }
    if input.save_password && input.ssh.is_some() && !ssh_secret.is_empty() {
        if let Err(error) = secrets::set_connection_ssh_secret(&id, &ssh_secret) {
            let _ = secrets::delete_connection_password(&id);
            return Err(error);
        }
    }

    let mut meta = ConnectionMeta::from_input(id.clone(), &input);
    if let Some(tunnel) = connected.tunnel.as_ref() {
        if let Some(ssh) = meta.ssh.as_mut() {
            ssh.host_key = Some(tunnel.host_key().to_string());
        }
    }

    if let Err(error) = state.connections.write().await.upsert(meta.clone()) {
        let _ = secrets::delete_connection_password(&id);
        let _ = secrets::delete_connection_ssh_secret(&id);
        return Err(error);
    }

    state.pool.insert(id, connected).await;
    Ok(meta)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn update_connection(
    state: State<'_, AppState>,
    id: String,
    input: ConnectionInput,
) -> AppResult<ConnectionMeta> {
    let meta = state
        .connections
        .read()
        .await
        .find(&id)
        .ok_or(AppError::NoConnection)?;

    let mut input = input;
    apply_stored_ssh_host_key(&mut input, Some(&meta));

    let old_password = secrets::get_connection_password(&id)?;
    let old_ssh_secret = secrets::get_connection_ssh_secret(&id)?;
    let new_password = input
        .password
        .clone()
        .filter(|password| !password.is_empty());
    let reuse_stored = stored_password_reusable(&input, &meta);

    if new_password.is_none() && old_password.is_some() && !reuse_stored {
        return Err(AppError::Config(
            "The host, port, user or dialect changed — re-enter the password.".to_string(),
        ));
    }

    let password = new_password
        .clone()
        .or_else(|| old_password.clone().filter(|_| reuse_stored));

    let new_ssh_secret = input
        .ssh_secret
        .clone()
        .filter(|secret| !secret.is_empty());
    let reuse_ssh_secret = ssh_secret_reusable(&input, &meta);

    let password_auth = matches!(
        input.ssh.as_ref().map(|ssh| ssh.auth),
        Some(SshAuth::Password)
    );
    if password_auth
        && new_ssh_secret.is_none()
        && old_ssh_secret.is_some()
        && !reuse_ssh_secret
    {
        return Err(AppError::Config(
            "The SSH host, user, authentication method or key file changed — re-enter the SSH password or key passphrase."
                .to_string(),
        ));
    }

    input.ssh_secret = new_ssh_secret
        .clone()
        .or_else(|| old_ssh_secret.clone().filter(|_| reuse_ssh_secret));

    let connected = drivers::connect(&input, password.as_deref()).await?;

    if input.save_password {
        if let Some(password) = &new_password {
            secrets::set_connection_password(&id, password)?;
        }
        if input.ssh.is_some() {
            if let Some(secret) = &new_ssh_secret {
                secrets::set_connection_ssh_secret(&id, secret)?;
            }
        }
    } else {
        secrets::delete_connection_password(&id)?;
    }

    if input.ssh.is_none() || !input.save_password {
        secrets::delete_connection_ssh_secret(&id)?;
    }

    let mut meta = ConnectionMeta::from_input(id.clone(), &input);
    if let Some(tunnel) = connected.tunnel.as_ref() {
        if let Some(ssh) = meta.ssh.as_mut() {
            ssh.host_key = Some(tunnel.host_key().to_string());
        }
    }

    if let Err(error) = state.connections.write().await.upsert(meta.clone()) {
        if let Some(password) = &old_password {
            let _ = secrets::set_connection_password(&id, password);
        } else if new_password.is_some() {
            let _ = secrets::delete_connection_password(&id);
        }
        if let Some(secret) = &old_ssh_secret {
            let _ = secrets::set_connection_ssh_secret(&id, secret);
        } else if new_ssh_secret.is_some() {
            let _ = secrets::delete_connection_ssh_secret(&id);
        }
        return Err(error);
    }

    state.pool.insert(id, connected).await;
    Ok(meta)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionMeta>> {
    let store = state.connections.read().await;
    if let Some(error) = store.load_error() {
        return Err(AppError::Config(error.to_string()));
    }
    Ok(store.list())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_connection_states(state: State<'_, AppState>) -> AppResult<Vec<ConnectionState>> {
    let connections = state.connections.read().await.list();
    let mut states = Vec::with_capacity(connections.len());

    for connection in connections {
        states.push(ConnectionState {
            connected: state.pool.get_opt(&connection.id).await.is_some(),
            id: connection.id,
        });
    }

    Ok(states)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn connect_connection(state: State<'_, AppState>, conn_id: String) -> AppResult<()> {
    state.ensure_driver(&conn_id).await?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn disconnect_connection(state: State<'_, AppState>, conn_id: String) -> AppResult<()> {
    let exists = state.connections.read().await.find(&conn_id).is_some();
    if !exists {
        return Err(AppError::NoConnection);
    }

    state.pool.remove(&conn_id).await;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let exists = state.connections.read().await.find(&id).is_some();
    if !exists {
        return Err(AppError::NoConnection);
    }

    state.connections.write().await.remove(&id)?;
    state.pool.remove(&id).await;
    secrets::delete_connection_password(&id)?;
    secrets::delete_connection_ssh_secret(&id)?;
    Ok(())
}

async fn pick_file(
    app: tauri::AppHandle,
    filter_name: &'static str,
    extensions: &'static [&'static str],
) -> AppResult<Option<String>> {
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(filter_name, extensions)
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
pub async fn pick_sqlite_file(app: tauri::AppHandle) -> AppResult<Option<String>> {
    pick_file(app, "SQLite files", &["db", "sqlite", "sqlite3", "db3"]).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pick_ssh_key_file(app: tauri::AppHandle) -> AppResult<Option<String>> {
    pick_file(app, "SSH private keys", &["pem", "key", "ppk"]).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn test_connection(
    state: State<'_, AppState>,
    input: ConnectionInput,
    id: Option<String>,
) -> AppResult<TestConnectionResult> {
    let meta = match id.as_deref() {
        Some(id) => state.connections.read().await.find(id),
        None => None,
    };

    let mut input = input;
    apply_stored_ssh_host_key(&mut input, meta.as_ref());

    let stored_password = match (&meta, id.as_deref()) {
        (Some(meta), Some(id)) if stored_password_reusable(&input, meta) => {
            secrets::get_connection_password(id).ok().flatten()
        }
        _ => None,
    };
    let new_ssh_secret = input
        .ssh_secret
        .clone()
        .filter(|secret| !secret.is_empty());
    let stored_ssh_secret = match (&meta, id.as_deref()) {
        (Some(meta), Some(id)) if ssh_secret_reusable(&input, meta) => {
            secrets::get_connection_ssh_secret(id).ok().flatten()
        }
        _ => None,
    };
    input.ssh_secret = new_ssh_secret.or(stored_ssh_secret);

    let password = input
        .password
        .clone()
        .filter(|password| !password.is_empty())
        .or(stored_password)
        .unwrap_or_default();

    match drivers::connect(&input, Some(&password)).await {
        Ok(connected) => {
            let ssh_host_key = connected
                .tunnel
                .as_ref()
                .map(|tunnel| tunnel.host_key().to_string());
            match connected.driver.query("SELECT 1", 1).await {
                Ok(_) => Ok(TestConnectionResult {
                    ok: true,
                    message: match &ssh_host_key {
                        Some(fingerprint) => {
                            format!("Bağlantı uğurludur · SSH host key {fingerprint}")
                        }
                        None => "Bağlantı uğurludur".to_string(),
                    },
                    ssh_host_key,
                }),
                Err(error) => Ok(TestConnectionResult {
                    ok: false,
                    message: format!("Sorğu alınmadı: {error}"),
                    ssh_host_key,
                }),
            }
        }
        Err(error) => Ok(TestConnectionResult {
            ok: false,
            message: format!("Bağlantı alınmadı: {error}"),
            ssh_host_key: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{ssh_secret_reusable, stored_password_reusable, stored_ssh_host_key};
    use crate::core::drivers::{ConnectionInput, ConnectionMeta, Dialect};
    use crate::core::ssh::{SshAuth, SshConfig};

    fn input(dialect: Dialect, host: &str, port: u16, username: &str, database: Option<&str>) -> ConnectionInput {
        ConnectionInput {
            name: "saved".to_string(),
            dialect,
            host: host.to_string(),
            port,
            username: username.to_string(),
            database: database.map(str::to_string),
            password: None,
            save_password: true,
            read_only: None,
            environment: None,
            flavor: None,
            trust_cert: None,
            ssh: None,
            ssh_secret: None,
        }
    }

    fn meta(dialect: Dialect, host: &str, port: u16, username: &str, database: Option<&str>) -> ConnectionMeta {
        ConnectionMeta {
            id: "id".to_string(),
            name: "saved".to_string(),
            dialect,
            host: host.to_string(),
            port,
            username: username.to_string(),
            database: database.map(str::to_string),
            read_only: None,
            environment: None,
            flavor: None,
            trust_cert: None,
            ssh: None,
        }
    }

    #[test]
    fn reuses_password_only_for_the_same_endpoint() {
        let stored = meta(Dialect::Postgres, "db.example", 5432, "app", Some("shop"));
        let same = input(Dialect::Postgres, "db.example", 5432, "app", Some("other"));
        assert!(stored_password_reusable(&same, &stored));

        assert!(!stored_password_reusable(
            &input(Dialect::Postgres, "attacker.example", 5432, "app", None),
            &stored
        ));
        assert!(!stored_password_reusable(
            &input(Dialect::Postgres, "db.example", 5433, "app", None),
            &stored
        ));
        assert!(!stored_password_reusable(
            &input(Dialect::Postgres, "db.example", 5432, "other", None),
            &stored
        ));
        assert!(!stored_password_reusable(
            &input(Dialect::Mysql, "db.example", 5432, "app", None),
            &stored
        ));
    }

    #[test]
    fn reuses_sqlite_password_only_for_the_same_file() {
        let stored = meta(Dialect::Sqlite, "", 0, "", Some("/data/app.db"));
        assert!(stored_password_reusable(
            &input(Dialect::Sqlite, "", 0, "", Some("/data/app.db")),
            &stored
        ));
        assert!(!stored_password_reusable(
            &input(Dialect::Sqlite, "", 0, "", Some("/data/other.db")),
            &stored
        ));
    }

    fn ssh_config(host: &str, port: u16, username: &str) -> SshConfig {
        SshConfig {
            host: host.to_string(),
            port,
            username: username.to_string(),
            auth: SshAuth::Password,
            key_path: None,
            host_key: Some("SHA256:abc".to_string()),
        }
    }

    #[test]
    fn reuses_the_ssh_host_key_only_for_the_same_host_and_port() {
        let mut stored = meta(Dialect::Postgres, "db.example", 5432, "app", None);
        stored.ssh = Some(ssh_config("bastion.example", 22, "deploy"));

        let mut same = input(Dialect::Postgres, "db.example", 5432, "app", None);
        same.ssh = Some(ssh_config("bastion.example", 22, "other"));

        assert_eq!(
            stored_ssh_host_key(&same, &stored).as_deref(),
            Some("SHA256:abc")
        );

        let mut moved = input(Dialect::Postgres, "db.example", 5432, "app", None);
        moved.ssh = Some(ssh_config("bastion.example", 2222, "deploy"));
        assert!(stored_ssh_host_key(&moved, &stored).is_none());
    }

    #[test]
    fn reuses_the_ssh_secret_only_for_the_same_login() {
        let mut stored = meta(Dialect::Postgres, "db.example", 5432, "app", None);
        stored.ssh = Some(ssh_config("bastion.example", 22, "deploy"));

        let mut same = input(Dialect::Postgres, "db.example", 5432, "app", None);
        same.ssh = Some(ssh_config("bastion.example", 22, "deploy"));
        assert!(ssh_secret_reusable(&same, &stored));

        let mut other_user = input(Dialect::Postgres, "db.example", 5432, "app", None);
        other_user.ssh = Some(ssh_config("bastion.example", 22, "root"));
        assert!(!ssh_secret_reusable(&other_user, &stored));

        let mut key_auth = input(Dialect::Postgres, "db.example", 5432, "app", None);
        let mut cfg = ssh_config("bastion.example", 22, "deploy");
        cfg.auth = SshAuth::Key;
        cfg.key_path = Some("~/.ssh/id_ed25519".to_string());
        key_auth.ssh = Some(cfg);
        assert!(!ssh_secret_reusable(&key_auth, &stored));
    }
}
