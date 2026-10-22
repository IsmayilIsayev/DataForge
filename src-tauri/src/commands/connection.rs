use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::core::drivers::{self, ConnectionInput, ConnectionMeta, Dialect};
use crate::core::secrets;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    pub message: String,
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
    let driver = drivers::connect(&input, Some(&password)).await?;

    if input.save_password && !password.is_empty() {
        secrets::set_connection_password(&id, &password)?;
    }

    let meta = ConnectionMeta::from_input(id.clone(), &input);
    if let Err(error) = state.connections.write().await.upsert(meta.clone()) {
        let _ = secrets::delete_connection_password(&id);
        return Err(error);
    }

    state.pool.insert(id, driver).await;
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

    let old_password = secrets::get_connection_password(&id)?;
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

    let driver = drivers::connect(&input, password.as_deref()).await?;

    if input.save_password {
        if let Some(password) = &new_password {
            secrets::set_connection_password(&id, password)?;
        }
    } else {
        secrets::delete_connection_password(&id)?;
    }

    let meta = ConnectionMeta::from_input(id.clone(), &input);
    if let Err(error) = state.connections.write().await.upsert(meta.clone()) {
        if let Some(password) = &old_password {
            let _ = secrets::set_connection_password(&id, password);
        } else if new_password.is_some() {
            let _ = secrets::delete_connection_password(&id);
        }
        return Err(error);
    }

    state.pool.insert(id, driver).await;
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
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pick_sqlite_file(app: tauri::AppHandle) -> AppResult<Option<String>> {
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("SQLite files", &["db", "sqlite", "sqlite3", "db3"])
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
pub async fn test_connection(
    state: State<'_, AppState>,
    input: ConnectionInput,
    id: Option<String>,
) -> AppResult<TestConnectionResult> {
    let stored_password = match id.as_deref() {
        Some(id) => {
            let meta = state.connections.read().await.find(id);
            match meta {
                Some(meta) if stored_password_reusable(&input, &meta) => {
                    secrets::get_connection_password(id).ok().flatten()
                }
                _ => None,
            }
        }
        None => None,
    };

    let password = input
        .password
        .clone()
        .filter(|password| !password.is_empty())
        .or(stored_password)
        .unwrap_or_default();

    match drivers::connect(&input, Some(&password)).await {
        Ok(driver) => match driver.query("SELECT 1", 1).await {
            Ok(_) => Ok(TestConnectionResult {
                ok: true,
                message: "Bağlantı uğurludur".to_string(),
            }),
            Err(error) => Ok(TestConnectionResult {
                ok: false,
                message: format!("Sorğu alınmadı: {error}"),
            }),
        },
        Err(error) => Ok(TestConnectionResult {
            ok: false,
            message: format!("Bağlantı alınmadı: {error}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::stored_password_reusable;
    use crate::core::drivers::{ConnectionInput, ConnectionMeta, Dialect};

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
}
