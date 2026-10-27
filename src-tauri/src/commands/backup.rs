use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;

use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::export::read_table;
use crate::core::backup::{
    external_dump_command, external_tool, external_tool_name, supports_structure, timestamp_utc,
    DumpColumn, DumpMode, DumpOptions, SqlDumpWriter,
};
use crate::core::drivers::{Dialect, Driver};
use crate::core::schema_diff::SchemaData;
use crate::core::secrets;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const PAGE_SIZE: i64 = 5_000;
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Serialize)]
pub struct BackupCapabilities {
    pub structure_supported: bool,
    pub external_tool: Option<String>,
}

#[derive(Clone, Serialize)]
struct BackupProgress {
    id: String,
    table: Option<String>,
    table_index: u32,
    tables_total: u32,
    rows: u64,
    done: bool,
    cancelled: bool,
}

fn io_err(error: io::Error) -> AppError {
    AppError::Export(error.to_string())
}

fn emit_progress(
    app: &tauri::AppHandle,
    id: &str,
    table: Option<&str>,
    table_index: usize,
    tables_total: usize,
    rows: u64,
    done: bool,
    cancelled: bool,
) {
    let _ = app.emit(
        "backup:progress",
        BackupProgress {
            id: id.to_string(),
            table: table.map(str::to_string),
            table_index: table_index as u32,
            tables_total: tables_total as u32,
            rows,
            done,
            cancelled,
        },
    );
}

fn ensure_extension(path: String, gzip: bool) -> String {
    let lower = path.to_ascii_lowercase();
    if gzip {
        if lower.ends_with(".sql.gz") {
            path
        } else if lower.ends_with(".sql") {
            format!("{path}.gz")
        } else {
            format!("{path}.sql.gz")
        }
    } else if lower.ends_with(".sql") {
        path
    } else if lower.ends_with(".sql.gz") {
        path[..path.len() - 3].to_string()
    } else {
        format!("{path}.sql")
    }
}

fn safe_stem(value: &str) -> String {
    let stem: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    if stem.is_empty() {
        "database".to_string()
    } else {
        stem
    }
}

async fn save_file_dialog(
    app: &tauri::AppHandle,
    default_name: String,
    gzip: bool,
) -> AppResult<Option<String>> {
    let app = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        let filters: &[&str] = if gzip { &["gz"] } else { &["sql"] };
        app.dialog()
            .file()
            .add_filter(
                if gzip {
                    "Compressed SQL dump"
                } else {
                    "SQL dump"
                },
                filters,
            )
            .set_file_name(default_name)
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

enum OutputSink {
    Plain(BufWriter<File>),
    Gzip(GzEncoder<BufWriter<File>>),
}

impl Write for OutputSink {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(writer) => writer.write(buffer),
            Self::Gzip(writer) => writer.write(buffer),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(writer) => writer.flush(),
            Self::Gzip(writer) => writer.flush(),
        }
    }
}

impl OutputSink {
    fn finish(self) -> io::Result<()> {
        match self {
            Self::Plain(mut writer) => writer.flush(),
            Self::Gzip(writer) => writer.finish().map(|_| ()),
        }
    }
}

fn open_sink(path: &str, gzip: bool) -> AppResult<OutputSink> {
    let writer = BufWriter::new(File::create(path).map_err(io_err)?);
    if gzip {
        Ok(OutputSink::Gzip(GzEncoder::new(
            writer,
            Compression::default(),
        )))
    } else {
        Ok(OutputSink::Plain(writer))
    }
}

async fn is_cancelled(state: &AppState, id: &str) -> bool {
    state.cancelled.read().await.contains(id)
}

async fn clear_cancelled(state: &AppState, id: &str) {
    state.cancelled.write().await.remove(id);
}

async fn run_builtin(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    driver: Arc<dyn Driver>,
    database: &str,
    selected: &[String],
    schema: Option<&SchemaData>,
    options: &DumpOptions,
    path: &str,
    gzip: bool,
    id: &str,
) -> AppResult<(bool, u64)> {
    let sink = open_sink(path, gzip)?;
    let mut writer = SqlDumpWriter::new(
        sink,
        driver.dialect(),
        database,
        options.include_drop,
        options.rows_per_insert,
    );

    writer
        .write_header(APP_VERSION, &timestamp_utc(), selected)
        .map_err(io_err)?;

    if options.mode.includes_structure() {
        let schema = schema
            .ok_or_else(|| AppError::Config("schema metadata is not available".into()))?;
        writer.write_structure(schema, selected).map_err(io_err)?;
    }

    let mut cancelled = false;
    let mut total = 0u64;

    if options.mode.includes_data() {
        writer.begin_data().map_err(io_err)?;

        for (table_index, table) in selected.iter().enumerate() {
            if is_cancelled(state, id).await {
                cancelled = true;
                break;
            }

            let column_info = driver.list_columns(database, table).await?;
            if column_info.is_empty() {
                continue;
            }
            let columns: Vec<DumpColumn> = column_info
                .iter()
                .map(|column| DumpColumn {
                    name: column.name.clone(),
                    data_type: column.data_type.clone(),
                })
                .collect();
            let names: Vec<String> = columns.iter().map(|column| column.name.clone()).collect();
            let pk_info: Vec<_> = column_info
                .iter()
                .filter(|column| column.key.as_deref() == Some("PRI"))
                .collect();
            let pk: Vec<String> = pk_info.iter().map(|column| column.name.clone()).collect();
            let pk_types: Vec<String> = pk_info
                .iter()
                .map(|column| column.data_type.clone())
                .collect();

            writer.begin_table(table, &columns).map_err(io_err)?;

            let mut on_batch = |rows: Vec<Vec<Value>>| -> AppResult<bool> {
                let cancelled = state
                    .cancelled
                    .try_read()
                    .map(|guard| guard.contains(id))
                    .unwrap_or(false);
                if cancelled {
                    return Ok(false);
                }

                writer.write_rows(&rows).map_err(io_err)?;
                total += rows.len() as u64;
                emit_progress(
                    app,
                    id,
                    Some(table),
                    table_index,
                    selected.len(),
                    total,
                    false,
                    false,
                );
                Ok(true)
            };

            let completed = read_table(
                driver.as_ref(),
                driver.dialect(),
                database,
                table,
                &names,
                &pk,
                &pk_types,
                PAGE_SIZE,
                &mut on_batch,
            )
            .await?;
            drop(on_batch);

            writer.end_table().map_err(io_err)?;
            if !completed {
                cancelled = true;
                break;
            }
        }

        if !cancelled {
            writer.end_data(schema, selected).map_err(io_err)?;
        }
    }

    if !cancelled && options.mode.includes_structure() {
        if let Some(schema) = schema {
            writer
                .write_foreign_keys(schema, selected)
                .map_err(io_err)?;
        }
    }

    writer.finish().map_err(io_err)?;
    let sink = writer.into_inner().map_err(io_err)?;
    sink.finish().map_err(io_err)?;

    Ok((cancelled, total))
}

fn run_external(
    dialect: Dialect,
    host: &str,
    port: u16,
    username: &str,
    database: &str,
    selected: &[String],
    password: Option<&str>,
    options: &DumpOptions,
    path: &str,
    gzip: bool,
) -> AppResult<()> {
    let command = external_dump_command(
        dialect,
        host,
        port,
        username,
        database,
        selected,
        options.mode,
        options.include_drop,
        password,
    )?;

    let mut sink = open_sink(path, gzip)?;
    let mut child = Command::new(&command.program)
        .args(&command.args)
        .envs(
            command
                .env
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AppError::Export(format!("could not start {}: {error}", command.program))
        })?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Export("dump tool produced no output stream".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Export("dump tool produced no error stream".into()))?;

    let stderr_handle = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });

    let copy_result = io::copy(&mut stdout, &mut sink).map_err(io_err);
    drop(stdout);
    let status = child.wait().map_err(io_err)?;
    let stderr_bytes = stderr_handle.join().unwrap_or_default();
    copy_result?;
    sink.finish().map_err(io_err)?;

    if !status.success() {
        let stderr_text = String::from_utf8_lossy(&stderr_bytes);
        let stderr_text = stderr_text.trim();
        return Err(AppError::Export(if stderr_text.is_empty() {
            format!("{} failed with status {status}", command.program)
        } else {
            format!("{} failed: {stderr_text}", command.program)
        }));
    }

    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn backup_capabilities(
    state: State<'_, AppState>,
    conn_id: String,
) -> AppResult<BackupCapabilities> {
    let meta = state
        .connections
        .read()
        .await
        .find(&conn_id)
        .ok_or(AppError::NoConnection)?;
    let dialect = meta.dialect;

    Ok(BackupCapabilities {
        structure_supported: supports_structure(dialect),
        external_tool: if meta.ssh.is_some() {
            None
        } else {
            external_tool(dialect).map(str::to_string)
        },
    })
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn backup_database(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    tables: Vec<String>,
    mode: DumpMode,
    include_drop: Option<bool>,
    rows_per_insert: Option<u32>,
    gzip: Option<bool>,
    use_external: Option<bool>,
    backup_id: Option<String>,
) -> AppResult<Option<String>> {
    let mut seen = HashSet::new();
    let selected: Vec<String> = tables
        .into_iter()
        .map(|table| table.trim().to_string())
        .filter(|table| !table.is_empty())
        .filter(|table| seen.insert(table.clone()))
        .collect();
    if selected.is_empty() {
        return Err(AppError::Config("choose at least one table to back up".into()));
    }

    let options = DumpOptions {
        mode,
        include_drop: include_drop.unwrap_or(false),
        rows_per_insert: rows_per_insert.unwrap_or(500).clamp(1, 50_000) as usize,
    };
    let gzip = gzip.unwrap_or(false);
    let use_external = use_external.unwrap_or(false);

    let meta = state
        .connections
        .read()
        .await
        .find(&conn_id)
        .ok_or(AppError::NoConnection)?;
    let dialect = meta.dialect;

    if options.mode.includes_structure() && !supports_structure(dialect) {
        return Err(AppError::Config(
            "Structure export is not supported for this database yet".to_string(),
        ));
    }

    if use_external {
        if meta.ssh.is_some() {
            return Err(AppError::Config(
                "The external dump tool cannot connect through an SSH tunnel; use the built-in writer."
                    .to_string(),
            ));
        }
        if external_tool(dialect).is_none() {
            let tool = external_tool_name(dialect).unwrap_or("the dump tool");
            return Err(AppError::Config(format!("{tool} is not installed")));
        }
    }

    let id = backup_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let date = timestamp_utc();
    let day = date.split_whitespace().next().unwrap_or("backup");
    let extension = if gzip { "sql.gz" } else { "sql" };
    let default_name = format!(
        "{}-{}.{}",
        safe_stem(&database),
        day,
        extension
    );

    let path = match save_file_dialog(&app, default_name, gzip).await? {
        Some(path) => path,
        None => return Ok(None),
    };
    let path = ensure_extension(path, gzip);

    emit_progress(&app, &id, None, 0, selected.len(), 0, false, false);

    let result = if use_external {
        let password = secrets::get_connection_password(&conn_id)?;
        let host = meta.host.clone();
        let username = meta.username.clone();
        let port = meta.port;
        let external_database = if dialect == Dialect::Sqlite {
            meta.database.clone().unwrap_or_default()
        } else {
            database.clone()
        };
        let selected = selected.clone();
        let options = options.clone();
        let path = path.clone();
        tokio::task::spawn_blocking(move || {
            run_external(
                dialect,
                &host,
                port,
                &username,
                &external_database,
                &selected,
                password.as_deref(),
                &options,
                &path,
                gzip,
            )
            .map(|_| (false, 0u64))
        })
        .await
        .map_err(|error| AppError::Config(format!("backup: {error}")))?
    } else {
        let driver = state.ensure_driver(&conn_id).await?;
        let schema = if options.mode.includes_structure() || dialect == Dialect::Postgres {
            Some(driver.get_diff_schema(Some(&database)).await?)
        } else {
            None
        };

        if options.mode.includes_structure() {
            let schema_ref = schema
                .as_ref()
                .ok_or_else(|| AppError::Config("schema metadata is not available".into()))?;
            if let Some(missing) = selected
                .iter()
                .find(|table| schema_ref.table(table).is_none())
            {
                return Err(AppError::Config(format!(
                    "Table {missing} was not found in the database schema metadata"
                )));
            }
        }

        run_builtin(
            &app,
            &state,
            driver,
            &database,
            &selected,
            schema.as_ref(),
            &options,
            &path,
            gzip,
            &id,
        )
        .await
    };

    clear_cancelled(&state, &id).await;

    match result {
        Ok((true, rows)) => {
            let _ = std::fs::remove_file(&path);
            emit_progress(
                &app,
                &id,
                None,
                0,
                selected.len(),
                rows,
                true,
                true,
            );
            Ok(None)
        }
        Ok((false, rows)) => {
            emit_progress(
                &app,
                &id,
                None,
                selected.len().saturating_sub(1),
                selected.len(),
                rows,
                true,
                false,
            );
            Ok(Some(path))
        }
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            emit_progress(
                &app,
                &id,
                None,
                0,
                selected.len(),
                0,
                true,
                true,
            );
            Err(error)
        }
    }
}
