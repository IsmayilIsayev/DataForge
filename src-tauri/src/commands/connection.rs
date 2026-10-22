use serde::{Deserialize, Serialize};
use tauri::State;

use crate::core::drivers::{self, ConnectionInput, ConnectionMeta};
use crate::core::secrets;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

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
    let exists = state.connections.read().await.find(&id).is_some();
    if !exists {
        return Err(AppError::NoConnection);
    }

    let old_password = secrets::get_connection_password(&id)?;
    let new_password = input
        .password
        .clone()
        .filter(|password| !password.is_empty());
    let password = new_password.clone().or_else(|| old_password.clone());

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
    Ok(state.connections.read().await.list())
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
pub async fn pick_sqlite_file() -> AppResult<Option<String>> {
    #[cfg(target_os = "windows")]
    {
        let output = tokio::task::spawn_blocking(|| {
            std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-STA",
                    "-Command",
                    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
                     Add-Type -AssemblyName System.Windows.Forms | Out-Null; \
                     $dialog = New-Object System.Windows.Forms.OpenFileDialog; \
                     $dialog.Filter = 'SQLite files (*.db;*.sqlite;*.sqlite3)|*.db;*.sqlite;*.sqlite3|All files (*.*)|*.*'; \
                     if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { \
                       [Console]::Out.Write($dialog.FileName) \
                     }",
                ])
                .output()
        })
        .await
        .map_err(|error| AppError::Config(format!("file picker: {error}")))?
        .map_err(|error| AppError::Config(format!("file picker: {error}")))?;

        if !output.status.success() {
            return Err(AppError::Config(format!(
                "file picker: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn test_connection(
    input: ConnectionInput,
    id: Option<String>,
) -> AppResult<TestConnectionResult> {
    let password = input
        .password
        .clone()
        .filter(|password| !password.is_empty())
        .or_else(|| {
            id.as_deref()
                .and_then(|id| secrets::get_connection_password(id).ok().flatten())
        })
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
